// Self-check for the built solver: `node wasm/test.mjs` after a build.
//
// The physics has its own tests inside the crate, against the struct. This one
// runs the actual .wasm the browser loads, through the actual C ABI, and reads
// the actual half-float texels the shader will sample — so it catches what the
// Rust tests cannot: a packing mistake, a parameter table that has drifted
// away from the JavaScript one, an export that was renamed.
//
// It also prints what a step costs, which is the number that decides the
// quality tiers.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PARAMS, PARAM_INDEX } from '../src/sim/params.js'

const bytes = readFileSync(new URL('../src/sim/fire-core.wasm', import.meta.url))
const { instance } = await WebAssembly.instantiate(bytes, {})
const wasm = instance.exports

// --- the boundary ----------------------------------------------------------

assert.equal(
  wasm.params_len(),
  PARAMS.length,
  'src/sim/params.js and wasm/src/lib.rs disagree on how many tunables there are',
)

const W = 96
const H = 128
/** A scene about a metre tall, which is what the pages run at. */
const SCENE_M = 1.2
assert.equal(wasm.init(W, H, SCENE_M / H), 1, 'the solver refused a sane grid')
assert.equal(wasm.init(4, 4, 0.01), 0, 'the solver accepted a grid too small to solve')
assert.equal(wasm.init(W, H, SCENE_M / H), 1)

const params = new Float32Array(wasm.memory.buffer, wasm.params_ptr(), wasm.params_len())
for (const [name, expected] of PARAMS) {
  const actual = params[PARAM_INDEX[name]]
  const tolerance = Math.abs(expected) * 1e-6
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `default for "${name}" is ${expected} here and ${actual} in the wasm`,
  )
}

// --- reading the texels ----------------------------------------------------

function decodeHalf(u) {
  const s = u & 0x8000 ? -1 : 1
  const e = (u >> 10) & 0x1f
  const m = u & 0x3ff
  if (e === 0) return s * 2 ** -14 * (m / 1024)
  if (e === 0x1f) return m ? NaN : s * Infinity
  return s * 2 ** (e - 15) * (1 + m / 1024)
}

const AMBIENT = params[PARAM_INDEX.ambient]
/** The four packed channels, per cell, as the shader sees them. */
function field() {
  const raw = new Uint16Array(wasm.memory.buffer, wasm.out_ptr(), wasm.out_len())
  const n = W * H
  const out = { gas: new Float64Array(n), soot: new Float64Array(n), char: new Float64Array(n), glow: new Float64Array(n) }
  for (let i = 0; i < n; i++) {
    out.gas[i] = AMBIENT + decodeHalf(raw[i * 4]) * 1000
    out.soot[i] = decodeHalf(raw[i * 4 + 1])
    out.char[i] = decodeHalf(raw[i * 4 + 2])
    out.glow[i] = AMBIENT + decodeHalf(raw[i * 4 + 3]) * 1000
  }
  return out
}

const at = (a, x, y) => a[y * W + x]
const total = (a) => a.reduce((s, v) => s + v, 0)
const peak = (a) => a.reduce((s, v) => Math.max(s, v), 0)
const run = (frames) => {
  let subs = 0
  for (let i = 0; i < frames; i++) subs = Math.max(subs, wasm.step(1 / 60))
  return subs
}

/** Light the bottom of the sheet, the way you would light a piece of paper. */
function light(x = W / 2, y = H - 6) {
  wasm.ignite(x, y, 6, 1500)
}

// --- an untouched page is inert and silent ---------------------------------

wasm.fill_fuel(1)
run(120)
assert.equal(wasm.energy(), 0, 'an untouched page is not at rest')
assert.equal(total(field().char), 0, 'the page caught fire on its own')

// --- a match lights it, and the fire feeds itself --------------------------

light()
const maxSubsteps = run(120)
let f = field()
const burning = total(f.char)
assert.ok(burning > 40, `the fire went out: ${burning.toFixed(1)} cells charred`)

const flame = peak(f.gas)
assert.ok(flame > 1000 && flame < 4001, `flame temperature is ${flame.toFixed(0)} K`)
const glow = peak(f.glow)
assert.ok(glow > 700 && glow <= 2201, `the burning edge is at ${glow.toFixed(0)} K`)
assert.ok(peak(f.soot) > 0.05, 'a sooty flame produced no soot to glow with')

for (const [name, channel] of Object.entries(f)) {
  assert.ok(channel.every(Number.isFinite), `the ${name} channel packed a non-finite texel`)
}

// --- it climbs ------------------------------------------------------------
// The fire was lit at the bottom. Two seconds later the char has to be above
// where the match was, and not below it.

const charRow = (y) => {
  let s = 0
  for (let x = 0; x < W; x++) s += at(f.char, x, y)
  return s
}
const above = charRow(H - 30) + charRow(H - 40)
const below = charRow(H - 2)
assert.ok(above > below, `the fire did not climb: ${above.toFixed(1)} above, ${below.toFixed(1)} below`)

// --- and it goes out when there is nothing left ---------------------------

const hot = wasm.energy()
run(1800)
const cold = wasm.energy()
assert.ok(cold < hot * 0.01, `the fire never went out: ${hot.toExponential(2)} -> ${cold.toExponential(2)}`)
assert.ok(peak(field().gas) < AMBIENT + 20, 'the room never cooled back down')

// --- char is burn damage, and a reset undoes it ---------------------------

const scar = total(field().char)
assert.ok(scar > 40, 'nothing was left charred')
wasm.reset()
assert.equal(total(field().char), 0, 'reset left the page burnt')
assert.equal(wasm.energy(), 0, 'reset left the room warm')

// --- wind leans it --------------------------------------------------------

function flameCentre(wind) {
  wasm.init(W, H, SCENE_M / H)
  const p = new Float32Array(wasm.memory.buffer, wasm.params_ptr(), wasm.params_len())
  p[PARAM_INDEX.windX] = wind
  p[PARAM_INDEX.gust] = 0
  wasm.fill_fuel(1)
  light(W / 2, H - 20)
  run(90)
  const g = field().gas
  let mx = 0
  let m = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const q = Math.max(at(g, x, y) - AMBIENT, 0)
      mx += x * q
      m += q
    }
  }
  return mx / Math.max(m, 1e-6)
}
const still = flameCentre(0)
const blown = flameCentre(4)
assert.ok(Math.abs(still - W / 2) < 6, `a still flame should stand up: ${still.toFixed(1)}`)
assert.ok(blown > still + 3, `wind must lean it: ${still.toFixed(1)} -> ${blown.toFixed(1)}`)

// --- the fuel map is what burns -------------------------------------------
// This is the whole point of the thing: an image, a video or a login form is
// uploaded as a fuel map, and only the parts of it that exist can catch.

wasm.init(W, H, SCENE_M / H)
const fuelIn = new Uint8Array(wasm.memory.buffer, wasm.fuel_in_ptr(), W * H)
fuelIn.fill(0)
for (let y = 0; y < H; y++) {
  for (let x = 20; x < 50; x++) fuelIn[y * W + x] = 255
}
wasm.commit_fuel()
wasm.ignite(35, H - 6, 6, 1500)
run(600)
f = field()
let burntOutside = 0
for (let y = 0; y < H; y++) {
  for (let x = 60; x < W; x++) burntOutside += at(f.char, x, y)
}
assert.ok(total(f.char) > 30, 'the strip of fuel never caught')
assert.equal(burntOutside, 0, 'bare canvas with no content in it burned')

// --- embers ----------------------------------------------------------------

wasm.init(W, H, SCENE_M / H)
wasm.fill_fuel(1)
assert.equal(wasm.ember_count(), 0, 'sparks before there was a fire')
light()
run(120)
const sparks = wasm.ember_count()
assert.ok(sparks > 0, 'a burning fire threw no sparks')
const embers = new Float32Array(wasm.memory.buffer, wasm.ember_ptr(), sparks * 4)
for (let k = 0; k < sparks; k++) {
  const [x, y, temp, life] = embers.subarray(k * 4, k * 4 + 4)
  assert.ok(x >= 0 && x < W && y >= 0 && y < H, `spark ${k} is off the grid at ${x},${y}`)
  assert.ok(temp > AMBIENT, `spark ${k} is cold`)
  assert.ok(life > 0, `spark ${k} is already dead`)
}

// --- what it costs ---------------------------------------------------------

function timeStep(w, h, frames = 90) {
  wasm.init(w, h, SCENE_M / h)
  wasm.fill_fuel(1)
  wasm.ignite(w / 2, h - 6, 6, 1500)
  run(30) // get the fire going before timing it
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < frames; i++) wasm.step(1 / 60)
  return Number(process.hrtime.bigint() - t0) / 1e6 / frames
}

// Mirrors TIERS in src/render/quality.js.
const tiers = [
  ['low', 160, 90],
  ['medium', 224, 126],
  ['high', 288, 162],
  ['ultra', 384, 216],
]
const costs = tiers.map(([name, w, h]) => [name, w, h, timeStep(w, h)])

console.log('solver ok')
console.log(`  ${burning.toFixed(0)} cells charred by a match, flame ${flame.toFixed(0)} K, edge ${glow.toFixed(0)} K`)
console.log(`  wind 4 m/s leans the plume ${(blown - still).toFixed(1)} cells`)
console.log(`  ${sparks} sparks in flight, ${maxSubsteps} sub-steps at the busiest frame`)
console.log('  cost of one 60Hz step, with the fire running:')
for (const [name, w, h, ms] of costs) {
  const share = ((ms / 16.67) * 100).toFixed(1)
  console.log(`    ${name.padEnd(7)} ${String(w).padStart(3)}x${String(h).padEnd(3)} ${(w * h / 1000).toFixed(0).padStart(3)}k cells  ${ms.toFixed(2)} ms  ${share.padStart(5)}% of a frame`)
}
