// Simulation thread. Owns the wasm core, integrates at a fixed timestep, and
// ships packed frames to the renderer.
//
// Flow control is a two-buffer ping-pong: the worker only posts a frame when
// it holds a free buffer, and the main thread returns one after each upload.
// That throttles the worker to the display rate without two timers having to
// agree on a number, and every hand-off is a transfer, so no frame is ever
// copied across the thread boundary.
//
// Copyright (c) 2026 Alex Mkwizu <alexgmkwizu@gmail.com> — MIT.

/** Fixed simulation rate. Physics must not change speed with framerate. */
const SIM_HZ = 60
const SIM_DT = 1 / SIM_HZ
/** How often a burned-out page bothers to check whether it is still out. */
const IDLE_HZ = 10
/** Never catch up more than this after a stall, or one slow frame snowballs. */
const MAX_TICKS_PER_STEP = 2
/** Below this, nothing is burning, glowing, smoking or moving. */
const IDLE_ENERGY = 2e-5
/** Mirrors MAX_EMBERS in wasm/src/lib.rs. */
const MAX_EMBERS = 768
const EMBER_STRIDE = 4

let wasm = null
let params = null
let fieldView = null
let emberView = null
let grid = { w: 0, h: 0 }
let free = []
let running = false
let idle = true
let timer = null
let last = 0
let acc = 0
let pending = null

/** Bytes one frame occupies: the field, then the sparks. */
function frameBytes() {
  return grid.w * grid.h * 4 * 2 + MAX_EMBERS * EMBER_STRIDE * 4
}

const fieldBytes = () => grid.w * grid.h * 4 * 2

function refreshViews() {
  // init() allocates, which can grow wasm memory and detach existing views.
  const memory = wasm.memory.buffer
  params = new Float32Array(memory, wasm.params_ptr(), wasm.params_len())
  fieldView = new Uint16Array(memory, wasm.out_ptr(), wasm.out_len())
  emberView = new Float32Array(memory, wasm.ember_ptr(), MAX_EMBERS * EMBER_STRIDE)
}

function allocate() {
  const bytes = frameBytes()
  free = [new ArrayBuffer(bytes), new ArrayBuffer(bytes)]
}

function post() {
  if (!free.length) return
  const buffer = free.pop()
  const embers = wasm.ember_count()
  new Uint16Array(buffer, 0, fieldView.length).set(fieldView)
  if (embers > 0) {
    const out = new Float32Array(buffer, fieldBytes(), embers * EMBER_STRIDE)
    out.set(emberView.subarray(0, embers * EMBER_STRIDE))
  }
  self.postMessage({ type: 'frame', buffer, w: grid.w, h: grid.h, embers }, [buffer])
}

function tick() {
  if (!running) return
  const now = performance.now()
  const elapsed = Math.min((now - last) / 1000, 0.25)
  last = now

  const wasIdle = idle
  idle = wasm.energy() < IDLE_ENERGY
  if (idle !== wasIdle) self.postMessage({ type: 'idle', idle })

  acc += elapsed
  let ticks = Math.floor(acc / SIM_DT)
  if (ticks > MAX_TICKS_PER_STEP) {
    ticks = MAX_TICKS_PER_STEP
    acc = 0
  } else {
    acc -= ticks * SIM_DT
  }

  // A fire that has gone out is not stepped and not sent. One last frame goes
  // out as it dies, so the renderer has the cold field to draw, and then the
  // worker does nothing at all until something is lit again — otherwise a
  // page that burned down an hour ago is still solving an empty room sixty
  // times a second, and the main thread is still waking up to draw it.
  if (idle) {
    if (!wasIdle) post()
  } else if (ticks > 0) {
    // The solver sub-steps internally by the CFL condition, so several ticks
    // are handed over as one longer step rather than as repeated calls: it
    // can then split the whole interval once instead of three times.
    wasm.step(SIM_DT * ticks)
    post()
  }
  timer = setTimeout(tick, 1000 / (idle ? IDLE_HZ : SIM_HZ))
}

/** Anything that puts energy back in has to restart the clock as well. */
function rouse() {
  if (!idle) return
  idle = false
  acc = 0
  last = performance.now()
  self.postMessage({ type: 'idle', idle: false })
}

function writeParams(patch) {
  for (const index in patch) params[index] = patch[index]
}

/** True if the grid was built. A refused size leaves the solver unusable. */
function resize({ w, h, cellMetres, params: patch }) {
  if (!wasm.init(w, h, cellMetres)) {
    self.postMessage({ type: 'error', message: `fire: the solver refused a ${w}x${h} grid` })
    return false
  }
  grid = { w, h }
  refreshViews()
  if (patch) writeParams(patch)
  allocate()
  idle = true
  return true
}

self.onmessage = async ({ data: msg }) => {
  // Everything below `init` needs the module. Fetching it is asynchronous and
  // the page starts sending input the moment the canvas exists, so a resize
  // can and does arrive first.
  if (!wasm && msg.type !== 'init') {
    if (msg.type === 'resize') pending = msg
    return
  }
  // A second `init` is a resize. Instantiating the module again would leave
  // two timer chains stepping the same solver, and only one of them
  // stoppable.
  if (msg.type === 'init' && wasm) msg = { ...msg, type: 'resize' }

  switch (msg.type) {
    case 'init': {
      const res = await fetch(msg.wasmUrl)
      const { instance } = await WebAssembly.instantiate(await res.arrayBuffer(), {})
      wasm = instance.exports
      const built = resize(pending ?? msg)
      pending = null
      // A grid the solver refused leaves it with no state at all, and every
      // call into it from here would trap. Stay stopped and say so.
      if (!built) break
      running = true
      last = performance.now()
      self.postMessage({ type: 'ready', w: grid.w, h: grid.h })
      tick()
      break
    }
    case 'resize':
      resize(msg)
      break
    case 'params':
      writeParams(msg.patch)
      break
    case 'fuel': {
      // The page, rasterised and downsampled to the grid: one byte per cell
      // saying how much there is there to burn.
      const bytes = new Uint8Array(msg.buffer)
      const staging = new Uint8Array(wasm.memory.buffer, wasm.fuel_in_ptr(), grid.w * grid.h)
      if (bytes.length === staging.length) {
        staging.set(bytes)
        wasm.commit_fuel()
      }
      break
    }
    case 'fillFuel':
      wasm.fill_fuel(msg.amount)
      break
    case 'ignite':
      wasm.ignite(msg.x, msg.y, msg.radius, msg.heat)
      rouse()
      break
    case 'blow':
      wasm.blow(msg.x, msg.y, msg.radius, msg.vx, msg.vy)
      rouse()
      break
    case 'reset':
      wasm.reset()
      post()
      break
    case 'recycle':
      // A frame in flight when the grid changed comes back at the old size.
      // Keeping it would overflow the next write, so swap it for a fresh one.
      if (msg.buffer.byteLength === frameBytes()) free.push(msg.buffer)
      else if (free.length < 2) free.push(new ArrayBuffer(frameBytes()))
      break
    case 'pause':
      running = !msg.paused
      clearTimeout(timer)
      if (running) {
        last = performance.now()
        acc = 0
        tick()
      }
      break
  }
}
