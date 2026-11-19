// Self-check for the cloth sim: node src/cloth.check.js
// Runs the real wasm module, the same one the worker loads in the browser.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadSim } from './sim.js'

const wasm = readFileSync(fileURLToPath(new URL('./cloth.wasm', import.meta.url)))
const sim = await loadSim(wasm)

const W = 1200, H = 705
const SPACING = 5.5 // what the app runs at; a coarser sheet strains differently

// Runs a pull and reports what it did to the sheet.
function pull({ steps, dx, dy, settle = 120, regrip = false }) {
  const id = sim.create(W, H, SPACING, 7)
  const whole = sim.indexCount(id)
  let grip = sim.grab(id, 600, 260, 15)
  let regrips = 0
  for (let i = 0; i < steps; i++) {
    const x = 600 + dx * i, y = 260 + dy * i
    sim.moveGrip(id, grip, x, y)
    sim.update(id, 1 / 60)
    // the worker re-grips when the piece in your fingers comes away
    if (regrip && !sim.gripAttached(id, grip) && sim.hasMaterial(id, x, y, 40)) {
      const next = sim.grab(id, x, y, 15)
      if (next >= 0) { sim.release(id, grip); grip = next; regrips++ }
    }
  }
  const torn = whole - sim.indexCount(id)
  sim.release(id, grip)
  for (let i = 0; i < settle; i++) sim.update(id, 1 / 60)
  return { id, whole, torn, tornAfterSettling: whole - sim.indexCount(id), regrips }
}

// an untouched sheet is flat, fully covering, and costs nothing to step
const idle = sim.create(W, H, SPACING, 3)
assert.equal(sim.coverage(idle), 1, 'a fresh sheet covers the screen')
const restY = sim.packed(idle)[1]
for (let i = 0; i < 120; i++) sim.update(idle, 1 / 60)
assert.equal(sim.moving(idle), false, 'an untouched sheet never moves')
assert.equal(sim.packed(idle)[1], restY, 'an intact page does not sag under its own weight')

// every vertex ships a unit normal facing the viewer while the sheet is flat
const packed = sim.packed(idle)
const mid = Math.floor(sim.nodeCount(idle) / 2) * 7
assert.ok(Math.abs(Math.hypot(packed[mid + 3], packed[mid + 4], packed[mid + 5]) - 1) < 1e-3, 'normals are unit length')
assert.ok(packed[mid + 5] > 0.99, 'a flat sheet faces the viewer')

// the material has tensile strength: it takes a real pull to tear it
const nudge = pull({ steps: 40, dx: 1, dy: 0.8 })
assert.equal(nudge.torn, 0, 'a nudge deforms the page without tearing it')

const gentle = pull({ steps: 60, dx: 2.5, dy: 2 })
assert.equal(gentle.torn, 0, 'a gentle pull folds the page without tearing it')

const firm = pull({ steps: 70, dx: 9, dy: 7 })
assert.ok(firm.torn > 0, 'a firm pull does tear')

// a tear stops when you stop pulling: it must not run on down the page
assert.ok(
  firm.tornAfterSettling < firm.torn * 1.6,
  `a tear arrests when released (${firm.torn} -> ${firm.tornAfterSettling})`,
)

// how far it tears follows how far you drag
const shortDrag = pull({ steps: 40, dx: 6, dy: 4, regrip: true })
const longDrag = pull({ steps: 120, dx: 6, dy: 4, regrip: true })
assert.ok(
  longDrag.torn > shortDrag.torn * 1.5,
  `a longer drag tears further (${shortDrag.torn} vs ${longDrag.torn})`,
)

// settled paper goes back to sleep, which is what keeps the sim affordable
assert.ok(sim.awake(longDrag.id) < sim.nodeCount(longDrag.id), 'settled paper sleeps')

// a grip never takes hold of thin air
assert.equal(sim.grab(idle, -500, -500, 30), -1, 'no grip off the sheet')

console.log('cloth.check.js: all assertions passed')
