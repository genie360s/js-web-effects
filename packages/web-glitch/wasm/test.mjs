// Self-check for the built solver: `node wasm/test.mjs` after a build.
//
// The behaviour has its own tests inside the crate, against the struct. This
// one runs the actual .wasm the browser loads, through the actual C ABI, and
// reads the actual bytes the shader will sample — so it catches what the Rust
// tests cannot: a parameter table that has drifted away from the JavaScript
// one, an export that was renamed, a buffer that is not the size the host
// uploads.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PARAMS, PARAM_INDEX, STYLES, writeParams } from '../src/sim/params.js'

const bytes = readFileSync(new URL('../src/sim/glitch-core.wasm', import.meta.url))
const { instance } = await WebAssembly.instantiate(bytes, {})
const wasm = instance.exports

// --- the boundary ----------------------------------------------------------

const W = 48
const H = 27
assert.equal(wasm.init(1, 1), 0, 'the solver accepted a grid too small to cut')
assert.equal(wasm.init(600, 600), 0, 'the solver accepted a grid too large to be a page')
assert.equal(wasm.init(W, H), 1, 'the solver refused a sane grid')

assert.equal(
  wasm.params_len(),
  PARAMS.length,
  'src/sim/params.js and wasm/src/lib.rs disagree on how many tunables there are',
)
const params = () => new Float32Array(wasm.memory.buffer, wasm.params_ptr(), wasm.params_len())
for (const [name, expected] of PARAMS) {
  const actual = params()[PARAM_INDEX[name]]
  assert.ok(
    Math.abs(actual - expected) <= Math.abs(expected) * 1e-6,
    `default for "${name}" is ${expected} here and ${actual} in the wasm`,
  )
}

const KIND = { off: 0, image: 1, pixel: 2, shift: 3, grey: 4, white: 5, dot: 6, ascii: 7, hline: 8, vline: 9, cross: 10, label: 11 }
const kinds = () => {
  const out = new Uint8Array(wasm.memory.buffer, wasm.out_ptr(), W * H * 4)
  return Array.from({ length: W * H }, (_, i) => out[i * 4])
}
const glow = () => new Uint8Array(wasm.memory.buffer, wasm.glow_ptr(), W * H)
const run = (seconds) => { for (let i = 0; i < seconds * 30; i++) wasm.step(1 / 30) }

// A disc of subject, which is what the host would have read off a portrait.
const subject = new Uint8Array(W * H)
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) subject[y * W + x] = Math.hypot(x - 24, y - 13) < 9 ? 255 : 0
new Uint8Array(wasm.memory.buffer, wasm.presence_ptr(), W * H).set(subject)
writeParams(params(), { glitch: 0, burstRate: 0 })
wasm.layout()

// --- hidden, then revealed -------------------------------------------------

run(0.5)
assert.ok(kinds().every((k) => k === KIND.off), 'something was drawn before anything was revealed')
assert.equal(wasm.idle(), 1, 'a hidden picture is still asking for frames')

wasm.set_target(1)
run(0.5)
const early = kinds()
assert.ok(early.some((k) => k !== KIND.off), 'nothing had arrived half a second into a reveal')
assert.ok(glow().some((v) => v > 0), 'blocks arrived without a flash')
early.forEach((k, i) => {
  // labels and their like live in the background; the picture itself may not
  if (k >= KIND.image && k <= KIND.shift && !subject[i]) {
    const near = [-1, 1, -W, W, -W - 1, -W + 1, W - 1, W + 1].some((d) => subject[i + d])
    assert.ok(near, `background cell ${i} arrived before the subject was in`)
  }
})

run(6)
assert.equal(wasm.progress(), 1)
assert.ok(kinds().every((k) => k === KIND.image), 'a finished reveal with glitch 0 is not the whole picture')
assert.equal(wasm.idle(), 1, 'a finished, still picture is still asking for frames')

// --- a burst ---------------------------------------------------------------

wasm.burst(1)
const seen = new Set()
for (let i = 0; i < 30; i++) {
  wasm.step(1 / 30)
  for (const k of kinds()) seen.add(k)
}
for (const name of ['dot', 'grey', 'white', 'image']) {
  assert.ok(seen.has(KIND[name]), `the burst never drew a ${name}`)
}
run(3)
assert.ok(kinds().every((k) => k === KIND.image), 'the burst did not let go')

// --- the resting styles ----------------------------------------------------

for (const [style, kind] of [['dots', 'dot'], ['mosaic', 'grey'], ['mask', 'white'], ['ascii', 'ascii']]) {
  writeParams(params(), { style })
  assert.equal(params()[PARAM_INDEX.style], STYLES.indexOf(style))
  wasm.step(1 / 30)
  const drawn = kinds()
  assert.ok(drawn.includes(KIND[kind]), `style "${style}" drew no ${kind}`)
  assert.ok(!drawn.includes(KIND.image), `style "${style}" drew the picture`)
}
assert.throws(() => writeParams(params(), { style: 'vhs' }), /style must be one of/)
assert.throws(() => writeParams(params(), { speed: NaN }), /finite/)
assert.throws(() => writeParams(params(), { nope: 1 }), /no such parameter/)

// --- what a step costs -----------------------------------------------------

assert.equal(wasm.init(160, 90), 1)
wasm.set_target(1)
const started = performance.now()
for (let i = 0; i < 300; i++) wasm.step(1 / 30)
const each = (performance.now() - started) / 300
assert.ok(each < 4, `a step of a 160x90 grid took ${each.toFixed(2)} ms`)

console.log(`glitch-core: ok — ${bytes.length} bytes, ${each.toFixed(3)} ms a step at 160x90`)
