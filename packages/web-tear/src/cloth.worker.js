// Owns every sheet and the wasm sim. The main thread never touches sim state:
// it posts pointer events and receives packed vertex buffers back.
//
// Buffers travel as transferables and are handed back for reuse, so a frame
// copies once (out of wasm memory) and allocates nothing.

import { loadSim } from './sim.js'

let sim = null
let sheets = [] // { id, layer }
let spacing = 8
let size = { w: 0, h: 0 }
let probes = [] // component hit points, per sheet, reported back each frame
let radius = 40 // how far we look for paper under the pointer
let pinch = 14 // how much of it your fingers actually hold
let running = false
let lastTime = 0
const pool = []
let inFlight = 0 // buffers the renderer currently holds
const MAX_BUFFERS = 6 // two in flight per sheet is plenty
const grips = new Map() // pointerId -> { sheet, handle }

// Buffers come back from the renderer after it has uploaded them. Handing out
// only what has come back is the backpressure: the worker keeps simulating at
// its own rate but never queues frames the page has not caught up with.
function take(length) {
  for (let i = 0; i < pool.length; i++) {
    if (pool[i].length === length) {
      inFlight++
      return pool.splice(i, 1)[0]
    }
  }
  if (pool.length + inFlight >= MAX_BUFFERS) return null
  inFlight++
  return new Float32Array(length)
}

function build() {
  sim.clearAll()
  // Sheets change size on a rebuild, so pooled buffers of the old length are no
  // use to anyone. Buffers the renderer still holds come back through recycle
  // and are dropped there; the in-flight count is what keeps the budget honest.
  pool.length = 0
  sheets = sheets.map((s, i) => {
    const id = sim.create(size.w, size.h, spacing, 0x9e3779b9 ^ (i * 2654435761))
    sim.setTearable(id, s.tearable !== false)
    return { ...s, id }
  })
  for (const s of sheets) {
    const uv = sim.uv(s.id)
    const copy = new Float32Array(uv) // static, sent once per build
    self.postMessage({ type: 'sheet', sheet: s.layer, nodes: sim.nodeCount(s.id), uv: copy }, [copy.buffer])
  }
}

// V8 compiles wasm with its baseline compiler first and only tiers up once the
// code is hot - that is a 3x difference here, and without this the first few
// seconds of tearing run at a third of the speed. Burn a small sheet in.
function warmUp() {
  // A small sheet, hammered: tier-up goes by how often the code runs, so many
  // cheap calls buy it sooner than a few expensive ones. This happens while the
  // page is still rasterising its layers, so none of it is visible.
  const id = sim.create(320, 220, 6, 1)
  const grip = sim.grab(id, 160, 110, 14)
  const until = performance.now() + 700
  for (let i = 0; i < 4000 && performance.now() < until; i++) {
    sim.moveGrip(id, grip, 160 + (i % 90), 110 + (i % 60))
    sim.update(id, 1 / 60)
  }
  sim.clearAll()
}

// The sheet you take hold of is the topmost one with paper right under the
// pointer. Only if there is none there do we look wider - otherwise standing in
// a hole would still grab the torn page around it instead of the page you can
// actually see through it.
function sheetAt(x, y) {
  for (const s of sheets) if (sim.hasMaterial(s.id, x, y, pinch)) return s
  for (const s of sheets) if (sim.hasMaterial(s.id, x, y, radius)) return s
  return null
}

const cost = { step: 0 } // rolling average of step time, for the debug readout
// The sim trims itself rather than the page trimming it: if steps run long on
// this machine, drop a solver pass; if there is room, put it back. Iterations
// are the right dial because changing them costs nothing and keeps every tear,
// where changing mesh density would mean rebuilding the sheets from scratch.
const STEP_BUDGET_MS = 12
const MIN_ITERATIONS = 3
const MAX_ITERATIONS = 6
let adjustAt = 0

function adaptToMachine(now) {
  if (now < adjustAt) return
  adjustAt = now + 500 // no faster than twice a second, and never mid-gesture
  const current = sim.params.iterations
  if (cost.step > STEP_BUDGET_MS && current > MIN_ITERATIONS) {
    sim.params.iterations = current - 1
  } else if (cost.step < STEP_BUDGET_MS * 0.45 && current < MAX_ITERATIONS) {
    sim.params.iterations = current + 1
  }
}

function frame(now) {
  adaptToMachine(now)
  const dt = Math.min((now - lastTime) / 1000 || 0, 1 / 20)
  lastTime = now

  for (const s of sheets) {
    const wasMoving = sim.moving(s.id)
    const t0 = performance.now()
    sim.update(s.id, dt)
    const t1 = performance.now()
    // only the sheet doing work, or the average is diluted by sleeping ones
    if (wasMoving) cost.step = cost.step * 0.9 + (t1 - t0) * 0.1
    if (!sim.moving(s.id) && !sim.indicesChanged(s.id)) continue

    const packed = sim.packed(s.id)
    const verts = take(packed.length)
    if (!verts) continue // renderer is behind; simulate on, post next time
    verts.set(packed)
    const message = {
      type: 'frame', sheet: s.layer, verts,
      coverage: sim.coverage(s.id), awake: sim.awake(s.id),
      stepMs: +cost.step.toFixed(2), iterations: sim.params.iterations, intact: sim.intact(s.id), dropped: sim.dropped(s.id),
      // where this sheet still has paper under a widget. The page decides
      // visibility from all the sheets: a widget shows when its own sheet is
      // still there and every sheet above it has been torn away at that point.
      paper: probes.filter((pr) => sim.hasMaterial(s.id, pr.x, pr.y, pr.r || 12)).map((pr) => pr.id),
    }
    const transfer = [verts.buffer]
    if (sim.indicesChanged(s.id)) {
      const idx = sim.indices(s.id)
      const copy = new Uint32Array(idx) // only when the topology actually changed
      message.indices = copy
      transfer.push(copy.buffer)
      sim.indicesUploaded(s.id)
    }
    self.postMessage(message, transfer)
  }
}

// Chained setTimeout in a worker gets throttled hard - it was pacing the whole
// simulation at 9 Hz. A MessageChannel task is not clamped, so we schedule the
// next step through it and only fall back to a timer when we are ahead of the
// target rate and want to idle.
const STEP_TARGET = 1000 / 120
const clock = new MessageChannel()
let timer = 0
// A tick already posted to the port cannot be cancelled, so each run of the
// loop carries a ticket. Stop bumps the ticket and any tick still in flight
// from the previous run retires instead of starting a second chain.
let ticket = 0

clock.port1.onmessage = (e) => {
  if (!running || e.data !== ticket) return
  const mine = ticket
  const now = performance.now()
  frame(now)
  const spent = performance.now() - now
  if (spent >= STEP_TARGET) {
    clock.port2.postMessage(mine) // already behind: go straight on
  } else {
    timer = setTimeout(() => clock.port2.postMessage(mine), STEP_TARGET - spent)
  }
}

function loop() {
  clock.port2.postMessage(ticket)
}

// One handler per message. A switch this size trips every complexity check
// going, and the page only ever sends these eleven things.
const handlers = {
  async init(m) {
    // If the wasm cannot be loaded there is no experience at all, and the page
    // needs to be told rather than left with an empty canvas.
    try {
      const loaded = await loadSim(m.wasm)
      sim = loaded
      warmUp()
    } catch (err) {
      self.postMessage({ type: 'failed', reason: err.message || String(err) })
      return
    }
    size = { w: m.width, h: m.height }
    spacing = m.spacing
    radius = m.radius
    pinch = m.pinch
    sheets = m.layers.map((l) => ({ layer: l.index, tearable: l.tearable, id: -1 }))
    probes = m.probes || []
    build()
    lastTime = performance.now()
    if (!running) { running = true; loop() }
    self.postMessage({ type: 'ready' })
  },

  probes(m) {
    probes = m.probes
  },

  resize(m) {
    size = { w: m.width, h: m.height }
    spacing = m.spacing
    radius = m.radius
    pinch = m.pinch
    grips.clear()
    build()
  },

  reset() {
    grips.clear()
    build()
  },

  down(m) {
    const s = sheetAt(m.x, m.y)
    if (!s) return
    const handle = sim.grab(s.id, m.x, m.y, pinch)
    if (handle < 0) return
    grips.set(m.id, { sheet: s.id, handle })
  },

  move(m) {
    const g = grips.get(m.id)
    if (!g) return
    let x = 0, y = 0
    for (let i = 0; i < m.points.length; i += 2) {
      x = m.points[i]
      y = m.points[i + 1]
      sim.moveGrip(g.sheet, g.handle, x, y)
    }
    regrip(m.id, g, x, y)
  },

  up(m) {
    const g = grips.get(m.id)
    if (!g) return
    sim.release(g.sheet, g.handle)
    grips.delete(m.id)
  },

  recycle(m) {
    if (inFlight > 0) inFlight--
    // only keep it if it still fits the sheets we are simulating now
    const wanted = sheets.length ? sim.packed(sheets[0].id).length : 0
    if (m.verts.length === wanted && pool.length < MAX_BUFFERS) pool.push(m.verts)
  },

  stop() {
    clearTimeout(timer)
    ticket++
    running = false
  },

  start() {
    if (!running) { running = true; lastTime = performance.now(); loop() }
  },
}

// Hands re-grip as they tear. Once the piece in your fingers has come away,
// take hold of the paper under the pointer that is still part of the page, so a
// long drag keeps the tear running along it. A dropped sheet has nothing
// attached left, so there is nothing to re-grip.
function regrip(pointerId, grip, x, y) {
  if (sim.dropped(grip.sheet) || sim.gripAttached(grip.sheet, grip.handle)) return
  const s = sheetAt(x, y)
  if (!s) return
  const handle = sim.grab(s.id, x, y, pinch)
  if (handle < 0) return
  sim.release(grip.sheet, grip.handle)
  grips.set(pointerId, { sheet: s.id, handle })
}

self.onmessage = (e) => {
  const m = e.data
  // Look the handler up safely: a message typed 'constructor' or '__proto__'
  // would otherwise find something on Object.prototype and throw.
  const handler = Object.hasOwn(handlers, m.type) ? handlers[m.type] : null
  if (typeof handler !== 'function') return
  // 'init' is async: anything that arrives while the wasm is still loading has
  // no sim to talk to yet.
  if (m.type !== 'init' && !sim) return
  handler(m)
}
