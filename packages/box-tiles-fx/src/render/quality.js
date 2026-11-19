// Quality tiers and the governor that moves between them.
//
// The grid is not a quality setting here: a cell is a look, chosen in CSS
// pixels, and the solver is too cheap to care how many there are. What a
// tier buys is pixels — the backing-store resolution the layers are drawn
// at — and the governor spends that budget on holding the frame rate.
//
// Copyright (c) 2026 Alex Mkwizu <alexgmkwizu@gmail.com> — MIT.

export const TIERS = {
  low: { label: 'Low', dpr: 1, scale: 0.75 },
  medium: { label: 'Medium', dpr: 1.5, scale: 0.9 },
  high: { label: 'High', dpr: 2, scale: 1 },
  ultra: { label: 'Ultra', dpr: 3, scale: 1 },
}

export const ORDER = ['low', 'medium', 'high', 'ultra']

/** First guess, from what the machine will tell us about itself. */
export function detectTier() {
  const nav = globalThis.navigator ?? {}
  const cores = nav.hardwareConcurrency || 4
  const memory = nav.deviceMemory || 4
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent || '')
  const dpr = globalThis.devicePixelRatio || 1

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
 * @param {string} [initial] a starting tier, for tests; otherwise detected
 */
export function createGovernor(onChange, initial) {
  let current = initial ?? detectTier()
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
      if (tier !== null && !(tier in TIERS)) throw new TypeError(`tiles: no such tier "${tier}"`)
      manual = tier
      onChange(manual ?? current, manual ? 'manual' : 'auto')
    },
    /** Feed one frame interval, in ms. */
    sample(dt) {
      if (!(dt > 0) || dt > 500) return
      ema += (dt - ema) * 0.08
      samples++

      // Learn the display's own cadence: a 120Hz panel has a different idea
      // of "fine" than a 60Hz one, and neither should be judged against
      // 16.7ms. It drops to a faster cadence at once and creeps up to a
      // slower one, because a single quick frame proves the display can do
      // it while a single slow one proves nothing.
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
 * The tile grid for a viewport. Cells are `cell` CSS pixels square; the grid
 * is however many of them cover the box, rounded up, and the fractional size
 * is what the shader uses so the cells stay exactly square at the edge.
 */
export function gridFor(cell, cssWidth, cssHeight, maxDim = 512) {
  // A cell small enough to need more than maxDim columns is made bigger
  // rather than refused; the solver would refuse the grid otherwise.
  const px = Math.max(cell, cssWidth / maxDim, cssHeight / maxDim, 2)
  return {
    w: Math.max(2, Math.ceil(cssWidth / px)),
    h: Math.max(2, Math.ceil(cssHeight / px)),
    across: cssWidth / px,
    down: cssHeight / px,
    px,
  }
}

/** Backing-store size for the canvas at a tier. */
export function pixelsFor(tier, cssWidth, cssHeight) {
  const t = TIERS[tier]
  const dpr = Math.min(globalThis.devicePixelRatio || 1, t.dpr)
  return {
    dpr,
    w: Math.max(1, Math.round(cssWidth * dpr * t.scale)),
    h: Math.max(1, Math.round(cssHeight * dpr * t.scale)),
  }
}
