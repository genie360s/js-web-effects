// The colour of hot things.
//
// A flame is not orange because someone picked orange. It is orange because
// soot particles in it are incandescent, and an incandescent body radiates a
// Planck spectrum whose colour is fixed by its temperature alone. So that is
// what this computes: Planck's law, integrated against the CIE 1931 colour
// matching functions, converted to sRGB primaries. The result is a small
// lookup table the shader samples by temperature.
//
// Doing it once on the CPU rather than fitting a curve in the shader costs one
// 256-pixel texture and is exact — and the curve is worth being exact about,
// because the deep red of a charring edge and the white heart of a flame are
// the same function evaluated 1500 K apart.
//
// Copyright (c) 2026 Alex Mkwizu <alexgmkwizu@gmail.com> — MIT.

const PLANCK = 6.62607015e-34 // J s
const LIGHT = 2.99792458e8 // m/s
const BOLTZMANN = 1.380649e-23 // J/K

/** Spectral radiance of a black body at `kelvin`, at `nm`. Arbitrary scale. */
function planck(nm, kelvin) {
  const l = nm * 1e-9
  const a = (2 * PLANCK * LIGHT * LIGHT) / l ** 5
  return a / (Math.exp((PLANCK * LIGHT) / (l * BOLTZMANN * kelvin)) - 1)
}

/**
 * Wyman, Sloan & Shirley's multi-lobe Gaussian fit to the CIE 1931 2-degree
 * observer. Within about one percent of the tabulated curves, and it is three
 * lines instead of three hundred numbers.
 */
const lobe = (x, mu, s1, s2) => {
  const t = (x - mu) * (x < mu ? 1 / s1 : 1 / s2)
  return Math.exp(-0.5 * t * t)
}
const xBar = (l) => 1.056 * lobe(l, 599.8, 37.9, 31.0) + 0.362 * lobe(l, 442.0, 16.0, 26.7) - 0.065 * lobe(l, 501.1, 20.4, 26.2)
const yBar = (l) => 0.821 * lobe(l, 568.8, 46.9, 40.5) + 0.286 * lobe(l, 530.9, 16.3, 31.1)
const zBar = (l) => 1.217 * lobe(l, 437.0, 11.8, 36.0) + 0.681 * lobe(l, 459.0, 26.0, 13.8)

/** CIE XYZ of a black body at `kelvin`. */
function blackbodyXyz(kelvin) {
  let x = 0
  let y = 0
  let z = 0
  for (let nm = 380; nm <= 780; nm += 5) {
    const p = planck(nm, kelvin)
    x += p * xBar(nm)
    y += p * yBar(nm)
    z += p * zBar(nm)
  }
  return [x, y, z]
}

/** CIE XYZ to linear sRGB (Rec. 709 primaries, D65). */
function xyzToLinearRgb([x, y, z]) {
  return [
    3.2406 * x - 1.5372 * y - 0.4986 * z,
    -0.9689 * x + 1.8758 * y + 0.0415 * z,
    0.0557 * x - 0.204 * y + 1.057 * z,
  ]
}

/**
 * A `size`-entry lookup table from `minK`..`maxK` to a linear-sRGB colour of
 * unit luminance, as bytes.
 *
 * Luminance is divided out on purpose: how *bright* a flame is depends on how
 * much soot is in it and how deep the eye is looking through it, which the
 * shader knows and this does not. What is stored here is only the hue, which
 * is the part temperature decides.
 *
 * Saturated primaries fall outside sRGB at low temperatures — a 900 K glow is
 * a redder red than a monitor has. Those are desaturated toward the point
 * where they fit rather than clipped, which keeps the ramp smooth instead of
 * flattening it into a bar of pure red.
 */
export function blackbodyTable(size = 256, minK = 600, maxK = 2800) {
  const bytes = new Uint8Array(size * 3)
  for (let i = 0; i < size; i++) {
    const kelvin = minK + ((maxK - minK) * i) / (size - 1)
    const rgb = xyzToLinearRgb(blackbodyXyz(kelvin))
    // Desaturate just enough to bring it inside the gamut.
    const low = Math.min(rgb[0], rgb[1], rgb[2])
    if (low < 0) for (let c = 0; c < 3; c++) rgb[c] -= low
    const peak = Math.max(rgb[0], rgb[1], rgb[2], 1e-9)
    for (let c = 0; c < 3; c++) {
      bytes[i * 3 + c] = Math.round(Math.min(rgb[c] / peak, 1) * 255)
    }
  }
  return { bytes, size, minK, maxK }
}
