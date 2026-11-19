// Self-check for the solver. `node test.mjs` after `cargo build --release`.
// Asserts the physics, not the syntax: ripples must spread, stay round, decay,
// and drift downstream when the surface is dragged.
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const W = 128, H = 128
const bytes = readFileSync(new URL('./target/wasm32-unknown-unknown/release/water_core.wasm', import.meta.url))
const { instance } = await WebAssembly.instantiate(bytes, {})
const wasm = instance.exports

function decodeHalf(u) {
  const s = (u & 0x8000) ? -1 : 1
  const e = (u >> 10) & 0x1f
  const m = u & 0x3ff
  if (e === 0) return s * Math.pow(2, -14) * (m / 1024)
  if (e === 0x1f) return m ? NaN : s * Infinity
  return s * Math.pow(2, e - 15) * (1 + m / 1024)
}

/** Decoded height field as a W*H Float64Array. */
function heights() {
  const raw = new Uint16Array(wasm.memory.buffer, wasm.out_ptr(), W * H * 2)
  const out = new Float64Array(W * H)
  for (let i = 0; i < W * H; i++) out[i] = decodeHalf(raw[i * 2])
  return out
}
const at = (h, x, y) => h[y * W + x]
const run = (frames) => { for (let i = 0; i < frames; i++) wasm.step(1 / 60, 1) }

wasm.init(W, H, 1.0)
wasm.set_breeze(0) // dead calm, so every measurement below is the touch alone

// --- a still pond is still -------------------------------------------------
run(10)
assert.ok(wasm.energy() < 1e-6, `still water should have no energy, got ${wasm.energy()}`)

// --- a touch makes a ripple that travels outward ---------------------------
const cx = 64, cy = 64
wasm.touch(cx, cy, 6, 1.0)
run(8)
const early = heights()
run(40)
const late = heights()

/** Radius of the strongest disturbance along +x from the centre. */
function crestRadius(h) {
  let best = 0, bestR = 0
  for (let r = 1; r < 60; r++) {
    const v = Math.abs(at(h, cx + r, cy))
    if (v > best) { best = v; bestR = r }
  }
  return bestR
}
const r1 = crestRadius(early), r2 = crestRadius(late)
assert.ok(r2 > r1 + 4, `ripple should travel outward: r=${r1} -> ${r2}`)

// --- and it stays round (this is what the 9-point Laplacian buys) ----------
const R = r2
const axis = Math.abs(at(late, cx + R, cy))
const diag = Math.abs(at(late, cx + Math.round(R * 0.7071), cy + Math.round(R * 0.7071)))
const anisotropy = Math.abs(axis - diag) / Math.max(axis, diag, 1e-9)
assert.ok(anisotropy < 0.35, `ripple should be round, axis=${axis.toFixed(4)} diag=${diag.toFixed(4)} (${(anisotropy * 100).toFixed(0)}% off)`)

// --- nothing blows up, nothing goes NaN ------------------------------------
let peak = 0
for (const v of late) {
  assert.ok(Number.isFinite(v), 'height field went non-finite')
  peak = Math.max(peak, Math.abs(v))
}
assert.ok(peak < 4.001, `height must stay clamped, peak=${peak}`)

// --- energy decays: ripples die out, they do not ring forever --------------
const eBefore = wasm.energy()
run(900)
const eAfter = wasm.energy()
assert.ok(eAfter < eBefore * 0.5, `ripples should decay: ${eBefore.toExponential(2)} -> ${eAfter.toExponential(2)}`)

// --- a hard flick carries the surface downstream ---------------------------
/** Centre of mass of |height| along x. */
function centroidX(h) {
  let num = 0, den = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const m = Math.abs(h[y * W + x])
      num += x * m; den += m
    }
  }
  return num / den
}

wasm.clear()
wasm.stroke(40, 64, 70, 64, 8, 0.5, 4400) // a real flick, left to right
run(20)
const c1 = centroidX(heights())
run(45)
const c2 = centroidX(heights())
const drift = c2 - c1
assert.ok(drift > 2.0, `a hard flick should drag the surface with it: +${drift.toFixed(2)} cells`)

// Control: a stone carries no drift field, so its rings must stay put. Without
// this, the check above would pass on any disturbance that merely spreads.
wasm.clear()
wasm.touch(W / 2, H / 2, 8, 0.5)
run(20)
const s1 = centroidX(heights())
run(45)
const still = Math.abs(centroidX(heights()) - s1)
assert.ok(still < 0.3, `a stone should not travel: moved ${still.toFixed(2)} cells`)

// --- the wake behind a driven point ----------------------------------------
// Geometry only: one stamp, no propagation, so this measures what the wake
// lays down rather than what the solver then does with it.
const LONG = Math.max(W, H)

/** Half-angle of the V, in degrees, or null if nothing was laid down. */
function wakeAngle(speed) {
  wasm.init(W, H, 1.0)
  wasm.set_breeze(0)
  const apexX = W - 12, apexY = H / 2
  wasm.wake(apexX, apexY, 1, 0, speed, 40, 0.5)
  wasm.step(1 / 60, 1) // only so the output buffer is packed
  const h = heights()

  const f = Math.min(Math.max((speed - 220) / 1000, 0), 1)
  const reach = LONG * (0.05 + 0.30 * f)
  const pts = []
  for (let d = reach * 0.3; d < reach * 0.95; d += reach / 12) {
    const x = Math.round(apexX - d)
    if (x < 2) break
    const prof = []
    let peak = 0
    for (let lat = 0; lat < H / 2 - 2; lat++) {
      const v = Math.abs(at(h, x, Math.round(apexY + lat)))
      prof.push(v)
      peak = Math.max(peak, v)
    }
    if (peak < 1e-4) continue
    let edge = 0
    for (let lat = 0; lat < prof.length; lat++) if (prof[lat] > peak * 0.4) edge = lat
    pts.push([d, edge])
  }
  if (pts.length < 3) return null
  let num = 0, den = 0
  for (const [d, lat] of pts) { num += d * lat; den += d * d }
  return (Math.atan(num / den) * 180) / Math.PI
}

const slowWake = wakeAngle(120)
assert.equal(slowWake, null, 'a point below wake speed should leave no V at all')

const midWake = wakeAngle(500)
const fastWake = wakeAngle(2400)
assert.ok(midWake > 24 && midWake < 45, `a moderate wake should open wide: ${midWake?.toFixed(1)}deg`)
// Deep-water Kelvin half-angle is 19.47 degrees; allow for the crests bulging
// back at the edges, which pulls the measured edge in a little.
assert.ok(fastWake > 14 && fastWake < 26, `a fast wake should tighten onto Kelvin: ${fastWake.toFixed(1)}deg`)
assert.ok(fastWake < midWake - 3, `the V must narrow with speed: ${midWake.toFixed(1)} -> ${fastWake.toFixed(1)}deg`)

console.log('solver ok')
console.log(`  ripple travel   ${r1} -> ${r2} cells`)
console.log(`  anisotropy      ${(anisotropy * 100).toFixed(1)}%`)
console.log(`  peak amplitude  ${peak.toFixed(3)}`)
console.log(`  decay           ${eBefore.toExponential(2)} -> ${eAfter.toExponential(2)}`)
console.log(`  drift           +${drift.toFixed(2)} cells on a flick, ${still.toFixed(2)} on a stone`)
console.log(`  wake half-angle ${midWake.toFixed(1)}deg at moderate speed, ${fastWake.toFixed(1)}deg at full`)
