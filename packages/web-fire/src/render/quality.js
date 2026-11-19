// Quality tiers and the governor that moves between them.
//
// The rule is "quality first, but never at the cost of the illusion": fire
// that stutters stops reading as fire long before a softer one does. So the
// governor spends its budget on holding the frame rate and only climbs back
// up after a sustained comfortable stretch.
//
// The grids are smaller than they look. A flame is a smooth field — what makes
// it convincing is that it is solved rather than drawn, not that it is solved
// finely — and the solver costs roughly 90 nanoseconds a cell a frame, so the
// grid is where the whole budget goes. The measured cost of each of these is
// printed by `npm test`.
//
// Copyright (c) 2026 Alex Mkwizu <alexgmkwizu@gmail.com> — MIT.

export const TIERS = {
  low: { label: 'Low', grid: 160, dpr: 1.25, scale: 0.75, substeps: 2, pressure: 6, reach: 3 },
  medium: { label: 'Medium', grid: 224, dpr: 1.5, scale: 0.9, substeps: 3, pressure: 8, reach: 4 },
  high: { label: 'High', grid: 288, dpr: 2, scale: 1, substeps: 3, pressure: 8, reach: 4 },
  ultra: { label: 'Ultra', grid: 384, dpr: 2, scale: 1, substeps: 4, pressure: 10, reach: 5 },
}

export const ORDER = ['low', 'medium', 'high', 'ultra']

/** First guess, from what the machine will tell us about itself. */
export function detectTier() {
  const cores = navigator.hardwareConcurrency || 4
  const memory = navigator.deviceMemory || 4
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
  const dpr = window.devicePixelRatio || 1

  let score = 0
  score += cores >= 12 ? 2 : cores >= 8 ? 1.5 : cores >= 6 ? 1 : cores >= 4 ? 0.5 : 0
  score += memory >= 8 ? 1 : memory >= 4 ? 0.5 : 0
  if (mobile) score -= 1.5
  // A high-DPI screen means more pixels for the same picture.
  if (dpr > 2.5) score -= 0.5

  // Start one rung below the ceiling: climbing after a smooth second costs
  // nothing, but a janky first impression is the one people remember.
  if (score >= 2) return 'high'
  if (score >= 1) return 'medium'
  return 'low'
}

/**
 * Watches frame times and recommends a tier.
 * @param {(tier: string, reason: string) => void} onChange
 */
export function createGovernor(onChange) {
  let current = detectTier()
  let manual = null
  let ema = 16.7
  let overBudget = 0
  let underBudget = 0
  let refresh = 16.7
  let samples = 0
  let cooldown = 0
  let demotions = 0

  return {
    get tier() {
      return manual ?? current
    },
    get auto() {
      return manual === null
    },
    get fps() {
      return 1000 / ema
    },
    /** Pin a tier, or pass null to hand control back to the governor. */
    setManual(tier) {
      manual = tier
      onChange(manual ?? current, manual ? 'manual' : 'auto')
    },
    /** Feed one frame interval, in ms. */
    sample(dt) {
      if (dt <= 0 || dt > 500) return
      ema += (dt - ema) * 0.08
      samples++

      // Learn the display's own cadence: a 120Hz panel has a different idea
      // of "fine" than a 60Hz one, and neither should be judged against
      // 16.7ms. It drops to a faster cadence at once and creeps up to a
      // slower one, because a single quick frame proves the display can do
      // it while a single slow one proves nothing. Creeping up at all is
      // what keeps a genuinely 30Hz panel from being read as a slow machine
      // and demoted twice for something no tier can fix.
      if (samples > 20) refresh += (dt - refresh) * (dt < refresh ? 0.5 : 0.002)
      const period = Math.min(Math.max(refresh, 6.5), 34)

      if (cooldown > 0) {
        cooldown--
        return
      }
      if (manual !== null) return

      const index = ORDER.indexOf(current)
      if (ema > period * 1.45) {
        overBudget++
        underBudget = 0
        if (overBudget > 45 && index > 0) {
          current = ORDER[index - 1]
          demotions++
          overBudget = 0
          cooldown = 90
          onChange(current, 'slow')
        }
      } else if (ema < period * 1.12) {
        underBudget++
        overBudget = 0
        // Only climb if we have not already been knocked down twice: past
        // that, the machine has told us where it stands.
        if (underBudget > 300 && index < ORDER.length - 1 && demotions < 2) {
          current = ORDER[index + 1]
          underBudget = 0
          cooldown = 180
          onChange(current, 'headroom')
        }
      } else {
        overBudget = 0
        underBudget = 0
      }
    },
  }
}

/**
 * Simulation grid for a viewport, at a tier. The grid tracks the viewport's
 * aspect so cells stay square and a plume goes straight up.
 */
export function gridFor(tier, viewWidth, viewHeight) {
  const long = TIERS[tier].grid
  const aspect = viewWidth / viewHeight
  let w
  let h
  if (aspect >= 1) {
    w = long
    h = Math.max(32, Math.round(long / aspect))
  } else {
    h = long
    w = Math.max(32, Math.round(long * aspect))
  }
  return { w, h }
}

/** Backing-store size for the canvas at a tier. */
export function pixelsFor(tier, cssWidth, cssHeight) {
  const t = TIERS[tier]
  const dpr = Math.min(window.devicePixelRatio || 1, t.dpr)
  return {
    dpr,
    w: Math.max(1, Math.round(cssWidth * dpr * t.scale)),
    h: Math.max(1, Math.round(cssHeight * dpr * t.scale)),
  }
}
