// Does the field the solver produces actually make a flame the renderer can
// see? `node src/render/flame.check.js`
//
// The physics tests assert the physics and the shader is not runnable here,
// so this checks the seam between them: the numbers the solver packs have to
// land in the range the shader's constants were chosen for. Nothing else
// catches that. The first version of this project produced a perfectly good
// fire — a real burning front, the right temperatures, char in the right
// places — and rendered nothing at all, because the soot it made was a
// hundredth of what `sootEmit` expected and every flame pixel came out
// transparent.
//
// It also checks the blackbody table is a blackbody table, since that is the
// other half of what makes a flame orange rather than red.
//
// Copyright (c) 2026 Alex Mkwizu <alexgmkwizu@gmail.com> — MIT.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PARAM_INDEX } from '../sim/params.js'
import { blackbodyTable } from './blackbody.js'
import { DEFAULTS } from '../engine.js'

const bytes = readFileSync(new URL('../sim/fire-core.wasm', import.meta.url))
const { instance } = await WebAssembly.instantiate(bytes, {})
const wasm = instance.exports

const GW = 288
const GH = 162
const SCENE = DEFAULTS.scene
assert.equal(wasm.init(GW, GH, SCENE / GH), 1)
const params = new Float32Array(wasm.memory.buffer, wasm.params_ptr(), wasm.params_len())
const AMBIENT = params[PARAM_INDEX.ambient]

function half(u) {
  const e = (u >> 10) & 0x1f
  const m = u & 0x3ff
  const s = u & 0x8000 ? -1 : 1
  if (e === 0) return s * 2 ** -14 * (m / 1024)
  return s * 2 ** (e - 15) * (1 + m / 1024)
}

// A block of content, lit along its bottom edge: the image page, in miniature.
const fuel = new Uint8Array(wasm.memory.buffer, wasm.fuel_in_ptr(), GW * GH)
const [x0, x1, y0, y1] = [88, 198, 28, 118]
for (let y = y0; y < y1; y++) {
  for (let x = x0; x < x1; x++) fuel[y * GW + x] = 255
}
wasm.commit_fuel()
for (let i = 0; i <= 12; i++) {
  wasm.ignite(x0 + 6 + (i / 12) * (x1 - x0 - 12), y1 - 3, 6, DEFAULTS.torchHeat)
}

/**
 * What the flame pass would make of this frame. `glowing` is the shader's
 * own expression, and it is the whole ball game: at soot far below
 * 1 / sootEmit the flame is transparent however hot the gas is.
 */
function survey() {
  const raw = new Uint16Array(wasm.memory.buffer, wasm.out_ptr(), GW * GH * 4)
  let visible = 0
  let hot = 0
  let peakGlow = 0
  let peakK = 0
  for (let i = 0; i < GW * GH; i++) {
    const kelvin = AMBIENT + half(raw[i * 4]) * 1000
    const soot = Math.max(half(raw[i * 4 + 1]), 0)
    const glowing = 1 - Math.exp(-soot * DEFAULTS.sootEmit)
    const radiance = (kelvin / 2000) ** 4
    peakK = Math.max(peakK, kelvin)
    peakGlow = Math.max(peakGlow, glowing * radiance)
    if (kelvin > 1200) hot++
    // Bright enough to read as flame rather than as a stain on the page.
    if (glowing * radiance > 0.25) visible++
  }
  return { visible, hot, peakGlow, peakK }
}

const history = []
for (let frame = 0; frame <= 240; frame++) {
  wasm.step(1 / 60)
  if (frame % 10 === 0) history.push({ frame, ...survey() })
}

const peak = history.reduce((a, b) => (b.visible > a.visible ? b : a))
assert.ok(
  peak.visible > 500,
  `the flame is invisible: at best ${peak.visible} cells were bright enough to see, `
    + `out of ${peak.hot} hot ones. Either the fire is not sooty enough or sootEmit is wrong.`,
)
assert.ok(
  peak.peakGlow > 0.6,
  `the brightest part of the flame only reached ${peak.peakGlow.toFixed(2)} of full emission`,
)

// It has to stay visible long enough to be a fire and not a flash.
const litFrames = history.filter((h) => h.visible > 200).length
assert.ok(litFrames >= 6, `the flame was only visible in ${litFrames} of the sampled frames`)

// --- and the colour --------------------------------------------------------

const table = blackbodyTable()
const at = (kelvin) => {
  const f = (kelvin - table.minK) / (table.maxK - table.minK)
  const i = Math.round(Math.max(0, Math.min(1, f)) * (table.size - 1))
  return [0, 1, 2].map((c) => table.bytes[i * 3 + c] / 255)
}
const cool = at(800)
const warm = at(1800)
const hotter = at(2600)
// Red saturates first and stays there; what changes with temperature is how
// much green and blue come up behind it. That progression is the whole reason
// a flame reads as a flame.
assert.ok(cool[0] > 0.98, 'a dull red heat should be saturated red')
assert.ok(cool[1] < 0.1, `800 K should be barely green, got ${cool[1].toFixed(2)}`)
assert.ok(warm[1] > cool[1] * 2, 'green must rise with temperature')
assert.ok(hotter[1] > warm[1] && hotter[2] > warm[2], 'hotter must mean whiter')
assert.ok(hotter[2] < hotter[1], 'a 2600 K body is not blue')

console.log('flame ok')
console.log(`  ${peak.visible} cells bright enough to see at the peak, ${peak.hot} hot`)
console.log(`  brightest emission ${peak.peakGlow.toFixed(2)}, hottest gas ${Math.round(peak.peakK)} K`)
console.log(`  alight for ${litFrames} of ${history.length} sampled frames`)
console.log(`  blackbody 800 K ${cool.map((v) => v.toFixed(2)).join(' ')} -> 2600 K ${hotter.map((v) => v.toFixed(2)).join(' ')}`)
