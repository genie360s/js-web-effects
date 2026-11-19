// The solver's tunables, by name.
//
// The solver keeps them as one flat f32 array in its own linear memory, so the
// host writes them straight in — no call per parameter, and any of them can be
// changed at any time, including mid-frame. This file is the other half of
// that contract: the same list, in the same order, as `wasm/src/lib.rs`.
// `wasm/test.mjs` asserts the two have not drifted apart.
//
// Everything here is SI. That is what makes the numbers mean something: the
// defaults describe paper burning in still room air, and `scene` (in
// engine.js) is what ties a metre to a pixel.
//
// Copyright (c) 2026 Alex Mkwizu <alexgmkwizu@gmail.com> — MIT.

/** Order matters: the index is the address. */
export const PARAMS = [
  ['ambient', 293, 'room temperature, K'],
  ['pyrolysisActivation', 2600, 'K; how sharp the ignition threshold is'],
  ['pyrolysisRate', 8, '1/s; how fast a hot surface gives off vapour'],
  ['surfaceHeat', 1450, 'K the surface gains per unit of fuel it gives off'],
  ['burnActivation', 6000, 'K; how hot the gas must be for vapour to light'],
  ['burnRate', 2e4, '1/s; gas-phase reaction speed'],
  ['heatRelease', 50000, 'K the gas gains per unit of vapour burned'],
  ['sootYield', 8, 'soot per unit of vapour burned; this is the yellow'],
  ['oxygenUse', 25, 'cells of air consumed per unit of vapour'],
  ['oxygenRefresh', 1, '1/s that fresh air replaces what was burned'],
  ['oxygenDiffuse', 0.004, 'm^2/s'],
  ['vapourDecay', 0.6, '1/s; unburned vapour turning into pale smoke'],
  ['gasConduct', 4e-5, 'm^2/s'],
  ['gasCool', 0.55, '1/s to the room'],
  ['gasRadiate', 6e-11, 'K^-3 s^-1'],
  ['surfaceConduct', 8e-7, 'm^2/s along the burning surface'],
  ['surfaceRadiateK', 2e-6, 'm^2/s at 1000 K; how the front creeps sideways'],
  ['surfaceCool', 0.8, '1/s to the room'],
  ['surfaceRadiate', 3e-10, 'K^-3 s^-1; the brake on a runaway'],
  ['coupleSurface', 0.3, '1/s convection, gas to surface'],
  ['coupleGas', 3, '1/s convection, surface to gas'],
  ['buoyancy', 1, 'multiplier on g (T - Ta) / Ta'],
  ['gravity', 9.81, 'm/s^2'],
  ['sootWeight', 2.4, 'm/s^2 of downward pull per unit of soot'],
  ['windX', 0, 'm/s'],
  ['windY', 0, 'm/s'],
  ['windCouple', 0.7, '1/s the air relaxes onto the far-field wind'],
  ['gust', 0.35, 'gust amplitude, as a fraction of the wind'],
  ['gustHz', 0.5, 'Hz'],
  ['turbulence', 12, 'vorticity confinement; the curl in the flame'],
  ['drag', 0.05, '1/s viscous damping'],
  ['sootDecay', 0.45, '1/s; how fast smoke thins out'],
  ['fuelDensity', 1, 'multiplier on the fuel the content provides'],
  ['charRate', 1.1, 'blackening per unit of fuel burned'],
  ['emberRate', 1.6, 'sparks per burning cell per second'],
  ['emberLife', 1.5, 's'],
  ['emberDrag', 2.2, '1/s; how hard the air pulls a spark along'],
  ['pressureIterations', 8, 'over-relaxed Gauss-Seidel sweeps per sub-step'],
  ['cfl', 2, 'cells a sub-step may advect'],
  ['maxSubsteps', 3, 'hard cap on sub-steps per frame'],
  ['spread', 1, 'multiplier on how fast the front creeps sideways'],
  ['flameFeedback', 800, 'K/s the flame radiates into the surface'],
  ['flameReach', 4, 'how far that radiation carries: passes at 1, 2, 4, ... cells'],
  ['flameTemp', 2200, 'K; adiabatic flame temperature, the hottest burning gets'],
  ['fuelSupply', 0, '1/s that spent fuel is replaced; 0 is paper, high is a gas burner'],
]

export const PARAM_INDEX = Object.fromEntries(PARAMS.map(([name], i) => [name, i]))
export const PARAM_DEFAULTS = Object.fromEntries(PARAMS.map(([name, value]) => [name, value]))

/** Write a `{name: value}` patch into a Float32Array view of the solver's table. */
export function writeParams(view, patch) {
  for (const name in patch) {
    const i = PARAM_INDEX[name]
    if (i === undefined) throw new TypeError(`fire: no such parameter "${name}"`)
    const value = patch[name]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(`fire: "${name}" must be a finite number, got ${value}`)
    }
    view[i] = value
  }
}
