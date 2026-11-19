// Quality tiers and the governor that moves between them.
//
// The rule is "quality first, but never at the cost of the illusion": water
// that stutters stops looking like water long before a softer one does. So the
// governor spends its budget on holding the frame rate, and only climbs back up
// when it has been comfortable for a sustained stretch.

export const TIERS = {
  low: { label: 'Low', grid: 224, scale: 0.6, dpr: 1.25, bed: 1024, density: 0.6 },
  medium: { label: 'Medium', grid: 320, scale: 0.8, dpr: 1.5, bed: 1536, density: 0.8 },
  high: { label: 'High', grid: 448, scale: 1.0, dpr: 2.0, bed: 2048, density: 1.0 },
  ultra: { label: 'Ultra', grid: 592, scale: 1.0, dpr: 2.0, bed: 2560, density: 1.15 },
}

export const ORDER = ['low', 'medium', 'high', 'ultra']

/** First guess from what the machine will tell us about itself. */
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

  // Start one rung below the ceiling: climbing up after a smooth second costs
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

      // Learn the display's own cadence: a 120Hz panel has a different idea of
      // "fine" than a 60Hz one, and neither should be judged against 16.7ms.
      if (samples > 20 && dt < refresh) refresh += (dt - refresh) * 0.5
      const period = Math.min(Math.max(refresh, 6.5), 20)

      if (cooldown > 0) {
        cooldown--
        return
      }
      if (manual !== null) return

      const idx = ORDER.indexOf(current)
      if (ema > period * 1.45) {
        overBudget++
        underBudget = 0
        if (overBudget > 45 && idx > 0) {
          current = ORDER[idx - 1]
          demotions++
          overBudget = 0
          cooldown = 90
          onChange(current, 'slow')
        }
      } else if (ema < period * 1.12) {
        underBudget++
        overBudget = 0
        // Only climb if we have not already been knocked down twice: past that,
        // the machine has told us where it stands and we stop bothering it.
        if (underBudget > 300 && idx < ORDER.length - 1 && demotions < 2) {
          current = ORDER[idx + 1]
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
 * aspect so cells stay square and ripples stay round.
 */
export function gridFor(tier, viewWidth, viewHeight) {
  const t = TIERS[tier]
  const long = t.grid
  const aspect = viewWidth / viewHeight
  let w, h
  if (aspect >= 1) {
    w = long
    h = Math.max(64, Math.round(long / aspect))
  } else {
    h = long
    w = Math.max(64, Math.round(long * aspect))
  }
  // Cell height / cell width: ~1, but the rounding above leaves a little error
  // and the solver would otherwise draw slightly oval ripples.
  const cellAspect = (viewHeight / h) / (viewWidth / w)
  return { w, h, cellAspect }
}

/** Backing-store size for the canvas at a tier. */
export function pixelsFor(tier, cssWidth, cssHeight) {
  const t = TIERS[tier]
  const dpr = Math.min(window.devicePixelRatio || 1, t.dpr)
  return {
    w: Math.max(1, Math.round(cssWidth * dpr * t.scale)),
    h: Math.max(1, Math.round(cssHeight * dpr * t.scale)),
  }
}
