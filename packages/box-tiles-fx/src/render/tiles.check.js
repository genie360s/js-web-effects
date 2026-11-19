// Does the field the solver produces mean what the shader thinks it means?
// `node src/render/tiles.check.js`
//
// The solver's tests assert the solver and the shader cannot run here, so
// this checks the seam: the numbers the solver packs have to land in the
// range the shader's expressions were written for, and the two formulas the
// renderer depends on — the reveal curve and the lift — are mirrored in
// JavaScript and asserted at their ends. Nothing else catches a tile that
// is black in the solver and merely dim on screen, or a reveal that leaves a
// few cells of a title permanently missing.
//
// Copyright (c) 2026 Alex Mkwizu <alexgmkwizu@gmail.com> — MIT.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PARAM_INDEX, PARAM_DEFAULTS } from '../sim/params.js'
import { FRAG_LAYER, revealAlpha, liftGain, BLACK_THRESHOLD, srgb } from './shaders.js'
import { DEFAULTS } from '../engine.js'

const bytes = readFileSync(new URL('../sim/tiles-core.wasm', import.meta.url))
const { instance } = await WebAssembly.instantiate(bytes, {})
const wasm = instance.exports

const W = 48
const H = 27
assert.equal(wasm.init(W, H), 1)
const params = new Float32Array(wasm.memory.buffer, wasm.params_ptr(), wasm.params_len())

function half(u) {
  const e = (u >> 10) & 0x1f
  const m = u & 0x3ff
  const s = u & 0x8000 ? -1 : 1
  if (e === 0) return s * 2 ** -14 * (m / 1024)
  return s * 2 ** (e - 15) * (1 + m / 1024)
}

// --- the GLSL and its JavaScript mirrors must be the same formula ----------

for (const token of ['uSoft + lot * (1.0 - uSoft)', 'smoothstep(t - uSoft, t, uReveal)', 'step(fd.z, -8.0)', 'exp2(clamp(fd.z, -8.0, 8.0))']) {
  assert.ok(FRAG_LAYER.includes(token), `the layer shader no longer contains "${token}"; update revealAlpha/liftGain and this check together`)
}
assert.equal(BLACK_THRESHOLD, -8)

// --- what a busy frame packs is what the shader can read -------------------

wasm.beat(3)
for (let i = 0; i < 8; i++) wasm.step(1 / 60)
const raw = new Uint16Array(wasm.memory.buffer, wasm.out_ptr(), wasm.out_len())
let blacks = 0
let lifts = 0
let shifts = 0
const offsetMax = PARAM_DEFAULTS.offsetMax
const liftMax = PARAM_DEFAULTS.liftMax
for (let i = 0; i < W * H; i++) {
  const dx = half(raw[i * 4])
  const dy = half(raw[i * 4 + 1])
  const lift = half(raw[i * 4 + 2])
  const lot = half(raw[i * 4 + 3])
  // A shifted tile samples a few cells away: never off the far side of a
  // grid this size, so the picture is always there to show.
  assert.ok(Math.abs(dx) <= offsetMax && Math.abs(dy) <= offsetMax, `shift ${dx},${dy} beyond offsetMax`)
  assert.ok(Math.abs(dx) / W < 0.25 && Math.abs(dy) / H < 0.25, 'a shift this large would show mostly nothing')
  if (dx || dy) shifts++
  const { black, gain } = liftGain(lift)
  if (black) {
    blacks++
    assert.ok(lift <= BLACK_THRESHOLD)
  } else {
    assert.ok(gain >= 1 && gain <= 2 ** liftMax + 1e-6, `gain ${gain} for lift ${lift}`)
    if (gain > 1) lifts++
  }
  assert.ok(lot >= 0 && lot < 1, `lottery ${lot}`)
}
assert.ok(blacks > 0 && lifts > 0 && shifts > 0, `a beat should produce every kind: ${blacks} black, ${lifts} lifted, ${shifts} shifted`)

// --- the reveal curve ------------------------------------------------------
// Whatever the lottery dealt a cell: nothing at 0, everything at 1, and no
// going backwards in between.

for (const soft of [DEFAULTS.revealSoft, 0.001, 0.5, 0.999]) {
  for (let k = 0; k <= 64; k++) {
    const lot = k / 64
    assert.equal(revealAlpha(lot, 0, soft), 0, `cell with lot ${lot} shows at reveal 0 (soft ${soft})`)
    assert.equal(revealAlpha(lot, 1, soft), 1, `cell with lot ${lot} is missing at reveal 1 (soft ${soft})`)
    let last = 0
    for (let r = 0; r <= 1.0001; r += 1 / 128) {
      const a = revealAlpha(lot, r, soft)
      assert.ok(Number.isFinite(a) && a >= last - 1e-9, `reveal went backwards at ${r} (lot ${lot}, soft ${soft})`)
      last = a
    }
  }
}
// Halfway through, roughly half the cells are in: it is a reveal, not a cut.
{
  let shown = 0
  const n = 1000
  for (let k = 0; k < n; k++) shown += revealAlpha(k / n, 0.5, DEFAULTS.revealSoft)
  assert.ok(shown / n > 0.4 && shown / n < 0.6, `at reveal 0.5, ${(shown / n).toFixed(2)} of the cells are in`)
}

// --- the look's constants parse to what the shader expects -----------------

for (const key of ['lineColor', 'shadows', 'highlights']) {
  const c = srgb(DEFAULTS[key])
  assert.equal(c.length, 3)
  assert.ok(c.every((v) => v >= 0 && v <= 1), `${key} out of range`)
}
assert.throws(() => srgb('blue'), /rrggbb/)
assert.ok(DEFAULTS.revealSoft > 0 && DEFAULTS.revealSoft < 1)
assert.ok(PARAM_INDEX.rate === 0, 'rate must stay the first parameter; the worker rouses on it')

console.log('tiles ok')
console.log(`  on a beat: ${blacks} black, ${lifts} lifted, ${shifts} shifted of ${W * H} cells`)
console.log(`  reveal curve holds its ends for every lottery number at soft ${DEFAULTS.revealSoft}`)
