// Quality tiers and the governor that moves between them.
//
// Paint that stutters stops reading as a fluid: the eye tracks the leading edge
// of a smear, and a dropped frame makes it jump rather than flow. So the
// governor spends its budget on holding the frame rate, and only climbs back up
// after a long comfortable stretch.

const TIERS = {
  low: { grid: 208, scale: 0.65, dpr: 1.25 },
  medium: { grid: 288, scale: 0.85, dpr: 1.5 },
  high: { grid: 384, scale: 1.0, dpr: 2.0 },
  ultra: { grid: 512, scale: 1.0, dpr: 2.0 },
}

const ORDER = ['low', 'medium', 'high', 'ultra']

/** Points for the first [threshold, points] pair the value clears. */
function bracket(value, table) {
  return table.find(([min]) => value >= min)?.[1] ?? 0
}

const CORE_SCORE = [[12, 2], [8, 1.5], [6, 1], [4, 0.5]]
const MEMORY_SCORE = [[8, 1], [4, 0.5]]

/** First guess from what the machine will tell us about itself. */
function detectTier() {
  let score =
    bracket(navigator.hardwareConcurrency || 4, CORE_SCORE) +
    bracket(navigator.deviceMemory || 4, MEMORY_SCORE)

  if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) score -= 1.5
  // A high-DPI screen means more pixels for the same picture.
  if ((window.devicePixelRatio || 1) > 2.5) score -= 0.5

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

      // Learn the display's own cadence: a 120Hz panel has a different idea of
      // "fine" than a 60Hz one, and neither should be judged against 16.7ms.
      // It drops fast and climbs slowly, so a burst of short intervals is
      // believed at once but is not permanent: a window dragged from a 120Hz
      // laptop panel to a 60Hz monitor would otherwise keep judging every
      // healthy 16.7ms frame against 8.3ms, demote twice, and then be barred
      // from ever climbing back by the `demotions` guard below.
      if (samples > 20) refresh += (dt - refresh) * (dt < refresh ? 0.5 : 0.002)
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
 * aspect so cells stay square — a stretched cell would make a round dab
 * elliptical and a straight drag curve.
 */
export function gridFor(tier, viewWidth, viewHeight) {
  const long = TIERS[tier].grid
  const aspect = viewWidth / viewHeight
  if (aspect >= 1) return { w: long, h: Math.max(64, Math.round(long / aspect)) }
  return { w: Math.max(64, Math.round(long * aspect)), h: long }
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
