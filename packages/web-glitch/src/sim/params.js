// The solver's tunables, by name.
//
// The solver keeps them as one flat f32 array in its own linear memory, so the
// host writes them straight in — no call per parameter, and any of them can be
// changed at any time. This file is the other half of that contract: the same
// list, in the same order, as `wasm/src/lib.rs`. `wasm/test.mjs` asserts the
// two have not drifted apart.
//
// Copyright (c) 2026 Alex Mkwizu <alexgmkwizu@gmail.com> — MIT.

/** Order matters: the index is the address. */
export const PARAMS = [
  ['speed', 0.7, 'progress per second: a reveal takes 1/speed seconds'],
  ['glitch', 0.04, 'share of arrived blocks misbehaving at rest; 0 is a still picture'],
  ['hold', 0.16, 's a block keeps its misbehaviour'],
  ['burstRate', 0.1, 'bursts per second, on its own'],
  ['burstLength', 0.6, 's a burst lasts'],
  ['switch', 0.09, 's a burst holds each rendering'],
  ['hole', 1, 'weight of a block dropping out'],
  ['pixel', 1, 'weight of a block going to coarse pixels'],
  ['shift', 0.6, 'weight of a block showing the picture from a few cells sideways'],
  ['labels', 0.2, 'share of the blocks beside the subject that carry a number'],
  ['glow', 1, 'flash as a block arrives'],
  ['glowDecay', 3, '1/s the flash fades'],
  ['threshold', 0.12, 'how much subject a cell needs to count as subject'],
  ['split', 0.45, 'chance a block that is all subject, or all background, subdivides'],
  ['dots', 0.5, 'share of subject cells that get a dot, in the dot rendering'],
  ['style', 0, 'resting rendering, as an index into STYLES'],
  ['decay', 3, '1/s pointer excitement fades'],
  ['exciteGain', 0.5, 'misbehaviour per unit of excitement'],
]

/** The renderings, in the order the solver numbers them. */
export const STYLES = ['image', 'dots', 'mosaic', 'mask', 'ascii']

export const PARAM_INDEX = Object.fromEntries(PARAMS.map(([name], i) => [name, i]))
export const PARAM_DEFAULTS = Object.fromEntries(PARAMS.map(([name, value]) => [name, value]))

/** Write a `{name: value}` patch into a Float32Array view of the solver's table. */
export function writeParams(view, patch) {
  for (const name in patch) {
    const i = PARAM_INDEX[name]
    if (i === undefined) throw new TypeError(`glitch: no such parameter "${name}"`)
    let value = patch[name]
    if (name === 'style' && typeof value === 'string') {
      value = STYLES.indexOf(value)
      if (value < 0) throw new TypeError(`glitch: style must be one of ${STYLES.join(', ')}, got "${patch[name]}"`)
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(`glitch: "${name}" must be a finite number, got ${value}`)
    }
    view[i] = value
  }
}
