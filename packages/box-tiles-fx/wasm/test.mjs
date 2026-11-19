// Self-check for the built solver: `node wasm/test.mjs` after a build.
//
// The behaviour has its own tests inside the crate, against the struct. This
// one runs the actual .wasm the browser loads, through the actual C ABI, and
// reads the actual half-float texels the shader will sample — so it catches
// what the Rust tests cannot: a packing mistake, a parameter table that has
// drifted away from the JavaScript one, an export that was renamed.
//
// It is also the regression test. A seeded run is fingerprinted and compared
// with `wasm/golden.json`; a change to the solver that was not meant to change
// what the tiles do fails here. One that was: `node wasm/test.mjs --update`.
//
// It also prints what a step costs, which is why the grid is not a quality
// tier: it is too cheap to need one.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { PARAMS, PARAM_INDEX } from '../src/sim/params.js'

const bytes = readFileSync(new URL('../src/sim/tiles-core.wasm', import.meta.url))
const { instance } = await WebAssembly.instantiate(bytes, {})
const wasm = instance.exports

// --- the boundary ----------------------------------------------------------

assert.equal(
  wasm.params_len(),
  PARAMS.length,
  'src/sim/params.js and wasm/src/lib.rs disagree on how many tunables there are',
)

const W = 48
const H = 27
assert.equal(wasm.init(W, H), 1, 'the solver refused a sane grid')
assert.equal(wasm.init(1, 1), 0, 'the solver accepted a grid too small to tile')
assert.equal(wasm.init(600, 600), 0, 'the solver accepted a grid too large to be a page')
assert.equal(wasm.init(W, H), 1)

let params = new Float32Array(wasm.memory.buffer, wasm.params_ptr(), wasm.params_len())
for (const [name, expected] of PARAMS) {
  const actual = params[PARAM_INDEX[name]]
  assert.ok(
    Math.abs(actual - expected) <= Math.abs(expected) * 1e-6,
    `default for "${name}" is ${expected} here and ${actual} in the wasm`,
  )
}
assert.equal(wasm.out_len(), W * H * 4, 'four texels a cell')

// --- reading the texels ----------------------------------------------------

function decodeHalf(u) {
  const s = u & 0x8000 ? -1 : 1
  const e = (u >> 10) & 0x1f
  const m = u & 0x3ff
  if (e === 0) return s * 2 ** -14 * (m / 1024)
  if (e === 0x1f) return m ? NaN : s * Infinity
  return s * 2 ** (e - 15) * (1 + m / 1024)
}

/** The four packed channels, per cell, as the shader sees them. */
function field() {
  const raw = new Uint16Array(wasm.memory.buffer, wasm.out_ptr(), wasm.out_len())
  const n = W * H
  const out = { dx: new Float64Array(n), dy: new Float64Array(n), lift: new Float64Array(n), lot: new Float64Array(n) }
  for (let i = 0; i < n; i++) {
    out.dx[i] = decodeHalf(raw[i * 4])
    out.dy[i] = decodeHalf(raw[i * 4 + 1])
    out.lift[i] = decodeHalf(raw[i * 4 + 2])
    out.lot[i] = decodeHalf(raw[i * 4 + 3])
  }
  return out
}

const run = (frames) => { for (let i = 0; i < frames; i++) wasm.step(1 / 60) }
const fresh = (seed = 1) => {
  wasm.init(W, H)
  params = new Float32Array(wasm.memory.buffer, wasm.params_ptr(), wasm.params_len())
  params[PARAM_INDEX.rate] = 0
  wasm.reseed(seed)
}

// --- a quiet grid is a still picture ---------------------------------------

fresh()
run(120)
let f = field()
assert.equal(wasm.active(), 0, 'tiles popped on their own with the rate at zero')
assert.equal(wasm.idle(), 1, 'a quiet grid should say so')
assert.ok(f.dx.every((v) => v === 0) && f.dy.every((v) => v === 0) && f.lift.every((v) => v === 0))
assert.ok(f.lot.every((v) => v >= 0 && v < 1), 'the lottery must sit in [0, 1)')

// --- a beat pops tiles, and the texels say which kind --------------------

wasm.beat(3)
assert.equal(wasm.idle(), 0, 'a beat must wake it')
run(6)
f = field()
const popped = wasm.active()
assert.ok(popped > 20, `a beat only popped ${popped} tiles`)
const shifted = f.dx.filter((v, i) => v !== 0 || f.dy[i] !== 0).length
const blacked = f.lift.filter((v) => v <= -8).length
const lifted = f.lift.filter((v) => v > 0).length
assert.ok(shifted > 0 && blacked > 0 && lifted > 0, `kinds: ${shifted} shifted, ${blacked} black, ${lifted} lifted`)
assert.ok(f.dx.every((v) => Number.isInteger(v) && Math.abs(v) <= 4), 'shifts must be whole cells within offsetMax')
assert.ok(f.lift.every((v) => v <= -8 || (v >= 0 && v <= 1.2)), 'a lift is either black or within liftMax')
for (const [name, channel] of Object.entries(f)) {
  assert.ok(channel.every(Number.isFinite), `the ${name} channel packed a non-finite texel`)
}

// --- and it settles --------------------------------------------------------

run(360)
assert.equal(wasm.active(), 0, 'tiles never let go')
assert.equal(wasm.idle(), 1, `still awake with energy ${wasm.energy()}`)

// --- a stroke is local -----------------------------------------------------

fresh()
wasm.pulse(10, 10, 3, 4)
run(10)
f = field()
let near = 0
let far = 0
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = y * W + x
    if (f.dx[i] === 0 && f.dy[i] === 0 && f.lift[i] === 0) continue
    if (Math.hypot(x - 10, y - 10) < 10) near++
    else far++
  }
}
assert.ok(near > 2, `a stroke popped ${near} tiles under the pointer`)
assert.equal(far, 0, `a stroke popped ${far} tiles nowhere near the pointer`)

// --- reset and reseed ------------------------------------------------------

const lotBefore = Float64Array.from(field().lot)
wasm.reset()
assert.equal(wasm.active(), 0)
assert.deepEqual(field().lot, lotBefore, 'a reset must not re-roll the lottery')
wasm.reseed(7)
assert.notDeepEqual(field().lot, lotBefore, 'a reseed must')

// --- regression: a seeded run is a fixed sequence ---------------------------
// FNV-1a over the packed texels of a scripted run. If this changes, the tiles
// the browser shows for the same inputs have changed.

function fingerprint() {
  fresh(2026)
  params[PARAM_INDEX.rate] = 0.06
  let hash = 0x811c9dc5
  const mix = () => {
    const raw = new Uint16Array(wasm.memory.buffer, wasm.out_ptr(), wasm.out_len())
    for (let i = 0; i < raw.length; i++) {
      hash ^= raw[i] & 0xff
      hash = Math.imul(hash, 0x01000193) >>> 0
      hash ^= raw[i] >> 8
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
  }
  for (let frame = 0; frame < 180; frame++) {
    if (frame === 10) wasm.beat(2)
    if (frame === 40) wasm.pulse(20, 12, 4, 3)
    if (frame === 90) wasm.drive(0.5)
    if (frame === 120) wasm.drive(0)
    wasm.step(1 / 60)
    if (frame % 15 === 0) mix()
  }
  return hash.toString(16).padStart(8, '0')
}

const goldenUrl = new URL('./golden.json', import.meta.url)
const print = fingerprint()
assert.equal(fingerprint(), print, 'the same scripted run gave two different fingerprints')
if (process.argv.includes('--update') || !existsSync(goldenUrl)) {
  writeFileSync(goldenUrl, JSON.stringify({ grid: [W, H], fingerprint: print }, null, 2) + '\n')
  console.log(`golden written: ${print}`)
} else {
  const golden = JSON.parse(readFileSync(goldenUrl, 'utf8'))
  assert.equal(
    print,
    golden.fingerprint,
    `the tiles have changed: fingerprint ${print}, golden ${golden.fingerprint}. `
      + 'If that was the point, run `node wasm/test.mjs --update`.',
  )
}

// --- what it costs ---------------------------------------------------------

function timeStep(w, h, frames = 300) {
  wasm.init(w, h)
  const p = new Float32Array(wasm.memory.buffer, wasm.params_ptr(), wasm.params_len())
  p[PARAM_INDEX.rate] = 0.3
  run(60)
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < frames; i++) wasm.step(1 / 60)
  return Number(process.hrtime.bigint() - t0) / 1e6 / frames
}

// 40 px cells at the usual viewports, and the largest grid allowed.
const grids = [
  ['phone', 10, 22],
  ['laptop', 36, 23],
  ['1080p', 48, 27],
  ['4k', 96, 54],
  ['max', 512, 512],
]
const costs = grids.map(([name, w, h]) => [name, w, h, timeStep(w, h)])

console.log('solver ok')
console.log(`  ${popped} tiles on a beat (${shifted} shifted, ${blacked} black, ${lifted} lifted), ${near} under a stroke`)
console.log(`  fingerprint ${print}`)
console.log('  cost of one 60Hz step, busy:')
for (const [name, w, h, ms] of costs) {
  const share = ((ms / 16.67) * 100).toFixed(2)
  console.log(`    ${name.padEnd(7)} ${String(w).padStart(3)}x${String(h).padEnd(3)} ${(w * h).toString().padStart(6)} cells  ${ms.toFixed(3)} ms  ${share.padStart(5)}% of a frame`)
}
