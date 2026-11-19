// Self-check for the sand field: node src/sand.check.js
// Runs the real wasm module, the same one the browser loads, through the same
// wrapper. The physics has its own tests in wasm/src/lib.rs; this one guards
// the boundary between the two.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadSand } from './sim.js'

const bytes = readFileSync(fileURLToPath(new URL('./sand.wasm', import.meta.url)))
const sand = await loadSand(bytes)

const W = 192
const H = 108

// half-float back to a number, so the check reads the same texels the GPU does
function f16(x) {
  const sign = (x & 0x8000) << 16
  const exp = (x >> 10) & 0x1f
  const mant = x & 0x03ff
  if (exp === 0) return new Float32Array(new Uint32Array([sign]).buffer)[0]
  const bits = sign | ((exp - 15 + 127) << 23) | (mant << 13)
  return new Float32Array(new Uint32Array([bits >>> 0]).buffer)[0]
}

// Four half-floats per cell, matching pack() in wasm/src/lib.rs.
const channel = (field, x, y, c) => f16(field.texels[((y * field.width + x) * 4) + c])
const at = (field, x, y) => channel(field, x, y, 0)
const disturbAt = (field, x, y) => channel(field, x, y, 1)
const driftAt = (field, x, y) => [channel(field, x, y, 2), channel(field, x, y, 3)]

function settle(field, limit = 4000) {
  let frames = 0
  while (field.active && frames < limit) {
    field.step(1 / 60)
    frames++
  }
  return frames
}

// a stroke cuts a groove, piles rims beside it, and stops moving
{
  const field = sand.create(W, H)
  field.setParams({ repose: 0.62, recovery: 0, disturbDecay: 0.22, driftDecay: 5, drag: 0.6, passes: 2 })
  field.stroke(40, 54, 150, 54, 5, 1, 0)
  assert.equal(field.step(1 / 60), true, 'a fresh stroke must produce texels')

  const [x0, y0, x1, y1] = field.dirty
  assert.ok(x0 < 40 && x1 > 150, `dirty rect ${x0}..${x1} should span the stroke`)
  assert.ok(y0 < 54 && y1 > 54, `dirty rect ${y0}..${y1} should span the stroke`)

  assert.ok(at(field, 95, 54) < -0.3, 'no groove was cut')
  assert.ok(disturbAt(field, 95, 54) > 0.5, 'cut sand was not marked as turned')

  const frames = settle(field)
  assert.ok(frames > 0 && frames < 4000, `field never settled (${frames} frames)`)
  assert.equal(field.step(1 / 60), false, 'a settled field must not keep uploading')
  assert.ok(at(field, 95, 54) < -0.2, 'the groove did not survive settling')
  assert.ok(at(field, 95, 47) > 0.02, 'no rim beside the groove')
  field.destroy()
}

// sand is conserved: what comes out of the groove goes beside it
{
  const field = sand.create(W, H)
  field.setParams({ repose: 0.62, recovery: 0, disturbDecay: 0.22, driftDecay: 5, drag: 0.6, passes: 2 })
  field.stroke(40, 54, 150, 54, 6, 1.5, 0)
  settle(field)
  let total = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) total += at(field, x, y)
  }
  assert.ok(Math.abs(total) < 2, `sand was created or destroyed: ${total.toFixed(3)}`)
  field.destroy()
}

// wind flattens the beach again
{
  const field = sand.create(W, H)
  field.setParams({ repose: 0.62, recovery: 2, disturbDecay: 1, driftDecay: 5, drag: 0.6, passes: 2 })
  field.stroke(40, 54, 150, 54, 5, 1, 0)
  settle(field)
  assert.ok(Math.abs(at(field, 95, 54)) < 0.05, 'the mark never blew away')
  field.destroy()
}

// a lost GPU texture can be refilled without losing the drawing
{
  const field = sand.create(W, H)
  field.setParams({ repose: 0.62, recovery: 0, disturbDecay: 0.22, driftDecay: 5, drag: 0.6, passes: 2 })
  field.stroke(40, 54, 150, 54, 5, 1, 0)
  settle(field)
  const before = at(field, 95, 54)
  field.repack()
  assert.equal(field.step(1 / 60), true, 'repack must mark the field for upload')
  const [x0, y0, x1, y1] = field.dirty
  assert.deepEqual([x0, y0, x1, y1], [0, 0, W, H], 'repack must dirty the whole grid')
  assert.ok(Math.abs(at(field, 95, 54) - before) < 0.05, 'repack disturbed the field')
  field.destroy()
}

// reset clears it, and destroy is safe to call twice
{
  const field = sand.create(W, H)
  field.stroke(40, 54, 150, 54, 5, 1, 0.5)
  field.step(1 / 60)
  field.reset()
  field.step(1 / 60)
  assert.equal(at(field, 95, 54), 0, 'reset left sand behind')
  field.destroy()
  field.destroy()
  // none of these may touch memory that has been handed back
  field.stroke(1, 1, 2, 2, 1, 1, 0)
  field.setParams({ repose: 1, recovery: 0, disturbDecay: 1, driftDecay: 1, drag: 1, passes: 2 })
  field.reset()
  field.repack()
  assert.equal(field.step(1 / 60), false)
  assert.equal(field.texels, null, 'texels must not be readable after destroy')
  assert.equal(field.dirty, null, 'the dirty rect must not be readable after destroy')
  assert.equal(field.active, false)
}

// a travelling stroke leaves drift behind it, pointing the way it went
{
  const field = sand.create(W, H)
  field.setParams({ repose: 0.62, recovery: 0, disturbDecay: 0.4, driftDecay: 5, drag: 0.6, passes: 2 })
  field.stroke(40, 54, 150, 54, 5, 1, 1)
  field.step(1 / 60)
  const [dx, dy] = driftAt(field, 95, 54)
  assert.ok(dx > 1, `a rightward stroke must drift rightwards, got ${dx}`)
  assert.ok(Math.abs(dy) < 0.5, `and not sideways, got ${dy}`)

  const frames = settle(field)
  assert.ok(frames < 4000, 'drift never died away')
  assert.equal(driftAt(field, 95, 54)[0], 0, 'settled drift must be exactly zero')
  field.destroy()
}

// the working rectangle follows the sand rather than swallowing the grid
{
  const field = sand.create(W, H)
  field.setParams({ repose: 0.62, recovery: 0, disturbDecay: 0.4, driftDecay: 5, drag: 0.6, passes: 2 })
  field.stroke(80, 54, 110, 54, 4, 1, 0.4)
  let widest = 0
  let frames = 0
  while (field.active && frames < 4000) {
    field.step(1 / 60)
    const [x0, y0, x1, y1] = field.dirty
    widest = Math.max(widest, ((x1 - x0) * (y1 - y0)) / (W * H))
    frames++
  }
  assert.ok(frames < 4000, 'field never settled')
  assert.ok(widest < 0.35, `the upload rect reached ${(widest * 100).toFixed(0)}% of the grid`)
  field.destroy()
}

// bad sizes are refused rather than allocated
assert.throws(() => sand.create(1, 1), /could not allocate/)
assert.throws(() => sand.create(4096, 4096), /could not allocate/)

console.log('sand.check: all checks passed')
