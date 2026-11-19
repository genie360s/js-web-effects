// Self-check for the paint solver. `node test.mjs` after `cargo build --release`.
// Asserts the behaviour, not the syntax: pigment must mix subtractively, a drag
// must carry paint, the canvas must settle, and nothing may blow up.
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const W = 128, H = 128
const bytes = readFileSync(new URL('./target/wasm32-unknown-unknown/release/oil_core.wasm', import.meta.url))
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

/** Decoded frame: reflectance r/g/b and paint thickness, per cell. */
function frame() {
  const raw = new Uint16Array(wasm.memory.buffer, wasm.out_ptr(), W * H * 4)
  const out = { r: new Float64Array(W * H), g: new Float64Array(W * H), b: new Float64Array(W * H), m: new Float64Array(W * H) }
  for (let i = 0; i < W * H; i++) {
    out.r[i] = decodeHalf(raw[i * 4])
    out.g[i] = decodeHalf(raw[i * 4 + 1])
    out.b[i] = decodeHalf(raw[i * 4 + 2])
    out.m[i] = decodeHalf(raw[i * 4 + 3])
  }
  return out
}
const at = (f, x, y) => f[y * W + x]
const run = (steps) => wasm.step(1 / 60, steps)

const ULTRAMARINE = [0.125, 0.173, 0.549]
const CAD_YELLOW = [0.988, 0.761, 0.078]
const IVORY_BLACK = [0.102, 0.094, 0.102]
const TITANIUM_WHITE = [0.961, 0.957, 0.933]
/** Same grip the worker uses, so these numbers describe the shipped brush. */
const GRIP = 0.995

wasm.init(W, H, 7)

// --- a canvas nobody has touched is not moving ------------------------------
// Exactly zero, not merely small: the yield stress has to give a true fixed
// point, or a canvas nobody is touching would slump and never stop costing
// battery.
assert.equal(wasm.energy(), 0, 'a fresh canvas should have no flow')
run(300)
assert.equal(wasm.energy(), 0, 'and it should not start on its own')

// --- blue over yellow is green, which is the whole point --------------------
// An RGB average of these two would come out a muddy orange-grey (red highest).
// Kubelka-Munk mixing gives what the palette knife gives: a deep green.
const [bx, by] = [32, 32]
wasm.deposit(bx, by, bx, by, 1, 0, 10, ...ULTRAMARINE, 1.0, 1)
wasm.deposit(bx, by, bx, by, 1, 0, 10, ...CAD_YELLOW, 1.0, 1)
wasm.step(0, 0) // re-encode without advancing time
{
  const f = frame()
  const [r, g, b] = [at(f.r, bx, by), at(f.g, bx, by), at(f.b, bx, by)]
  assert.ok(g > r && g > b, `blue + yellow should read green, got r=${r.toFixed(4)} g=${g.toFixed(4)} b=${b.toFixed(4)}`)
  // ...and dark: two strong pigments together absorb more than either alone.
  assert.ok(g < 0.25, `a blue/yellow mix should be a deep green, got g=${g.toFixed(4)}`)
}

// --- white over black lightens, and black wins per unit of paint ------------
{
  wasm.init(W, H, 7)
  wasm.deposit(20, 20, 20, 20, 1, 0, 8, ...IVORY_BLACK, 1.0, 1)
  wasm.step(0, 0)
  const dark = at(frame().g, 20, 20)
  wasm.deposit(20, 20, 20, 20, 1, 0, 8, ...TITANIUM_WHITE, 1.0, 1)
  wasm.step(0, 0)
  const mixed = at(frame().g, 20, 20)
  assert.ok(mixed > dark, `adding white should lighten: ${dark.toFixed(4)} -> ${mixed.toFixed(4)}`)
  // Equal volumes of white and black do not give mid grey. They give near
  // black, because ivory black's K/S dwarfs titanium white's.
  assert.ok(mixed < 0.2, `equal white and black should stay dark, got ${mixed.toFixed(4)}`)
}

// --- a drag carries paint with it -------------------------------------------
wasm.init(W, H, 7)
// Measure against the untouched canvas, so whatever the seed happened to lay
// down cancels and only the pigment this test deposited is being tracked.
const base = frame().g.slice()
wasm.deposit(40, 64, 40, 64, 1, 0, 9, ...IVORY_BLACK, 1.4, 1)
wasm.step(0, 0)

/** Centroid x of the darkening this test caused. */
function darkCentroid(f) {
  let sum = 0, wsum = 0
  for (let y = 40; y < 88; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.max(0, base[y * W + x] - at(f.g, x, y))
      sum += d * x
      wsum += d
    }
  }
  assert.ok(wsum > 0, 'expected some dark paint to measure')
  return sum / wsum
}
const before = darkCentroid(frame())

// 60 frames of a cursor crossing the blob left to right at 72 cells/second.
let cx = 40
for (let i = 0; i < 60; i++) {
  const nx = cx + 1.2
  wasm.smear(cx, 64, nx, 64, 72, 0, 1, 0, 12, GRIP, 1)
  cx = nx
  run(1)
}
const after = darkCentroid(frame())
assert.ok(after > before + 12, `a drag should carry paint downstream: ${before.toFixed(1)} -> ${after.toFixed(1)}`)

// --- a flick grips as hard as a slow drag -----------------------------------
// Both passes travel the same distance at the same speed; one is delivered as
// 12 long segments, the other as 72 short ones. If the brush's grip is divided
// by the stamps in a segment rather than by the stamps that land on a cell, the
// coarse pass moves the paint a fraction as far.
function dragDistance(steps, perStep) {
  wasm.init(W, H, 7)
  const start = frame().g.slice()
  wasm.deposit(30, 64, 30, 64, 1, 0, 9, ...IVORY_BLACK, 1.4)
  wasm.step(0, 0)
  const centroid = () => {
    let sum = 0, wsum = 0
    for (let y = 40; y < 88; y++) {
      for (let x = 0; x < W; x++) {
        const d = Math.max(0, start[y * W + x] - at(frame().g, x, y))
        sum += d * x
        wsum += d
      }
    }
    return sum / wsum
  }
  const from = centroid()
  let cx = 30
  const speed = perStep * 60
  for (let i = 0; i < steps; i++) {
    wasm.smear(cx, 64, cx + perStep, 64, speed, 0, 1, 0, 12, GRIP, 1)
    cx += perStep
    run(1)
  }
  return centroid() - from
}
{
  const fine = dragDistance(72, 1.0)
  const coarse = dragDistance(12, 6.0)
  assert.ok(
    coarse > fine * 0.6,
    `a flick should grip like a drag: coarse=${coarse.toFixed(1)} fine=${fine.toFixed(1)}`,
  )
}

// --- a stamped component is paint, not a sticker ----------------------------
// This is what lets an interface be made of the stuff: its surface goes into
// the pigment field, so the cursor drags it and it mixes with what it meets.
{
  wasm.init(W, H, 7)
  const base = frame().b.slice()
  const [bw, bh] = [24, 12]
  const img = new Uint8Array(bw * bh * 4)
  for (let k = 0; k < bw * bh; k++) {
    img[k * 4] = 32
    img[k * 4 + 1] = 44
    img[k * 4 + 2] = 140
    img[k * 4 + 3] = 255
  }
  new Uint8Array(wasm.memory.buffer, wasm.in_ptr(), img.length).set(img)
  wasm.stamp(34, 58, bw, bh, 1.6, 0)

  const f = frame()
  assert.ok(at(f.b, 46, 64) > at(f.r, 46, 64), 'a stamped block should read as its own colour')

  /** Centroid x of everything the stamp made bluer than the bare canvas. */
  function blueCentroid() {
    const g = frame()
    let sum = 0, wsum = 0
    for (let y = 50; y < 78; y++) {
      for (let x = 0; x < W; x++) {
        const d = Math.max(0, at(g.b, x, y) - base[y * W + x])
        sum += d * x
        wsum += d
      }
    }
    assert.ok(wsum > 0, 'expected the stamped pigment to be measurable')
    return sum / wsum
  }
  const from = blueCentroid()
  let cx = 20
  for (let k = 0; k < 50; k++) {
    wasm.smear(cx, 64, cx + 2, 64, 120, 0, 1, 0, 12, GRIP, 1)
    cx += 2
    wasm.step(1 / 60, 1)
  }
  const to = blueCentroid()
  assert.ok(to > from + 6, `a stamped component should smear like paint: ${from.toFixed(1)} -> ${to.toFixed(1)}`)
}

// --- and the canvas settles once the cursor leaves --------------------------
assert.ok(wasm.energy() > 0.2, 'paint should still be flowing right after a drag')
run(120)
// Not exactly zero: a few cells chatter around the yield surface at well under
// a hundredth of a cell per step. The worker calls that rest and freezes.
assert.ok(wasm.energy() < 0.05, `paint should come to rest, energy=${wasm.energy()}`)

// --- nothing blows up under abuse -------------------------------------------
for (let i = 0; i < 300; i++) {
  const x = (i * 37) % W, y = (i * 61) % H
  wasm.smear(x, y, (x + 40) % W, (y + 30) % H, 800, -800, 0.6, -0.8, 14, 1.0, 1)
  wasm.deposit(x, y, x, y, 0.6, -0.8, 10, ...CAD_YELLOW, 0.4, 1)
  run(1)
}
{
  const f = frame()
  let maxM = 0
  for (let i = 0; i < W * H; i++) {
    assert.ok(Number.isFinite(f.m[i]) && Number.isFinite(f.g[i]), `non-finite cell at ${i}`)
    assert.ok(f.g[i] >= 0 && f.g[i] <= 1, `reflectance out of range: ${f.g[i]}`)
    if (f.m[i] > maxM) maxM = f.m[i]
  }
  assert.ok(maxM <= 3.3, `paint thickness should stay capped, got ${maxM}`)
}

// --- wet paint bleeds across a colour boundary, tacky paint does not ---------
/** Steepest colour step along the row through a blob's edge. Total variation
 *  would not do: blurring a monotone edge leaves it unchanged. */
function edgeSharpness() {
  const f = frame()
  let peak = 0
  for (let x = 30; x < 80; x++) peak = Math.max(peak, Math.abs(at(f.g, x + 1, 64) - at(f.g, x, 64)))
  return peak
}
function bleedRun(wetness) {
  wasm.init(W, H, 3)
  wasm.set_wetness(wetness)
  wasm.deposit(55, 64, 55, 64, 1, 0, 12, ...ULTRAMARINE, 1.6, 1)
  wasm.step(0, 0)
  const start = edgeSharpness()
  run(180)
  return start - edgeSharpness()
}
const wetSoftening = bleedRun(1.0)
const drySoftening = bleedRun(0.0)
assert.ok(wetSoftening > 0.002, `wet paint should bleed, edge softened by only ${wetSoftening.toFixed(4)}`)
assert.ok(
  wetSoftening > drySoftening * 3 + 0.001,
  `wetness should govern bleeding: wet=${wetSoftening.toFixed(4)} dry=${drySoftening.toFixed(4)}`,
)

// --- a cleared canvas is bare, and what is laid on it is the only paint -----
{
  wasm.init(W, H, 7)
  wasm.clear()
  let f = frame()
  let total = 0
  for (let i = 0; i < W * H; i++) total += f.m[i]
  assert.equal(total, 0, 'a cleared canvas should hold no paint at all')
  assert.equal(wasm.energy(), 0, 'and nothing should be flowing on it')

  const [bw, bh] = [16, 10]
  const img = new Uint8Array(bw * bh * 4)
  for (let k = 0; k < bw * bh; k++) {
    img[k * 4] = 222
    img[k * 4 + 1] = 48
    img[k * 4 + 2] = 32
    img[k * 4 + 3] = 255
  }
  new Uint8Array(wasm.memory.buffer, wasm.in_ptr(), img.length).set(img)
  wasm.stamp(40, 60, bw, bh, 2.0, 0)
  f = frame()
  assert.ok(at(f.m, 46, 64) > 1.5, 'the stamp should be the paint that is there')
  assert.equal(at(f.m, 10, 10), 0, 'and nowhere else should have any')
  assert.ok(at(f.r, 46, 64) > at(f.g, 46, 64), 'laid on bare canvas it keeps its own colour')
}

// --- relief lays the lights thicker without touching the colour -------------
{
  const [bw, bh] = [8, 8]
  const img = new Uint8Array(bw * bh * 4)
  for (let k = 0; k < bw * bh; k++) {
    // Left half dark, right half light; same hue, very different lightness.
    const light = (k % bw) >= bw / 2
    img[k * 4] = light ? 240 : 40
    img[k * 4 + 1] = light ? 150 : 25
    img[k * 4 + 2] = light ? 60 : 10
    img[k * 4 + 3] = 255
  }

  const run = (relief) => {
    wasm.init(W, H, 7)
    wasm.clear()
    new Uint8Array(wasm.memory.buffer, wasm.in_ptr(), img.length).set(img)
    wasm.stamp(40, 40, bw, bh, 2.0, relief)
    const f = frame()
    return {
      dark: at(f.m, 41, 44),
      light: at(f.m, 46, 44),
      darkHue: at(f.r, 41, 44) / Math.max(at(f.g, 41, 44), 1e-6),
      lightHue: at(f.r, 46, 44) / Math.max(at(f.g, 46, 44), 1e-6),
    }
  }

  const flat = run(0)
  assert.ok(
    Math.abs(flat.dark - flat.light) < 1e-3,
    `without relief a picture is laid at one thickness, got ${flat.dark} vs ${flat.light}`,
  )
  const lit = run(1)
  assert.ok(
    lit.light > lit.dark * 1.5,
    `with relief the lights should stand proud: dark=${lit.dark.toFixed(2)} light=${lit.light.toFixed(2)}`,
  )
  // Reflectance is K/S over mass, so changing how much paint is laid must not
  // move the colour it reads as.
  assert.ok(
    Math.abs(lit.darkHue - flat.darkHue) < 0.02 && Math.abs(lit.lightHue - flat.lightHue) < 0.02,
    'relief must change the thickness and not the hue',
  )
}

console.log('paint core ok')
