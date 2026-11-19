// The solver's tunables, by name.
//
// The solver keeps them as one flat f32 array in its own linear memory, so the
// host writes them straight in — no call per parameter, and any of them can be
// changed at any time, including mid-frame. This file is the other half of
// that contract: the same list, in the same order, as `wasm/src/lib.rs`.
// `wasm/test.mjs` asserts the two have not drifted apart.
//
// Copyright (c) 2026 Alex Mkwizu <alexgmkwizu@gmail.com> — MIT.

/** Order matters: the index is the address. */
export const PARAMS = [
  ['rate', 0.06, 'ambient flips per cell per second; 0 is a still picture'],
  ['hold', 0.45, 's a tile holds its state'],
  ['holdJitter', 0.6, 'how much that varies, as a fraction of hold'],
  ['shift', 1, 'weight of a tile showing the picture from a few cells away'],
  ['black', 0.7, 'weight of a tile going black'],
  ['lift', 0.5, 'weight of a tile flaring up'],
  ['block', 0.3, 'chance a flip takes a 2x2 block rather than one cell'],
  ['offsetMax', 4, 'cells; furthest a shifted tile reaches'],
  ['liftMax', 1.2, 'stops; brightest a flare gets'],
  ['decay', 4, '1/s excitement fades after a stroke or a beat'],
  ['pulseGain', 1, 'flips per cell per second per unit of excitement'],
  ['beatGain', 0.6, 'excitement per unit of beat'],
  ['maxActive', 0.6, 'most of the grid that may be active at once'],
]

export const PARAM_INDEX = Object.fromEntries(PARAMS.map(([name], i) => [name, i]))
export const PARAM_DEFAULTS = Object.fromEntries(PARAMS.map(([name, value]) => [name, value]))

/** Write a `{name: value}` patch into a Float32Array view of the solver's table. */
export function writeParams(view, patch) {
  for (const name in patch) {
    const i = PARAM_INDEX[name]
    if (i === undefined) throw new TypeError(`tiles: no such parameter "${name}"`)
    const value = patch[name]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(`tiles: "${name}" must be a finite number, got ${value}`)
    }
    view[i] = value
  }
}
