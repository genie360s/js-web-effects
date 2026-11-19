// Simulation thread. Owns the wasm core, steps it at a fixed rate, and ships
// packed frames to the renderer.
//
// Flow control is a two-buffer ping-pong: the worker only posts a frame when
// it holds a free buffer, and the main thread returns one after each upload.
// That throttles the worker to the display rate without two timers having to
// agree on a number, and every hand-off is a transfer, so no frame is ever
// copied across the thread boundary.
//
// It runs unchanged under Node's worker_threads, which is how the integration
// test drives it: `self` is the browser's port, `parentPort` is Node's.
//
// Copyright (c) 2026 Alex Mkwizu <alexgmkwizu@gmail.com> — MIT.

// The specifier is hidden from the bundler: it is Node-only, and never
// reached in a browser.
const port = globalThis.self ?? (await import(/* @vite-ignore */ 'node:' + 'worker_threads')).parentPort

/** Fixed simulation rate. Tiles must not pop faster on a faster display. */
const SIM_HZ = 60
const SIM_DT = 1 / SIM_HZ
/** How often a settled grid bothers to check whether it is still settled. */
const IDLE_HZ = 10
/** Never catch up more than this after a stall, or one slow frame snowballs. */
const MAX_TICKS_PER_STEP = 2

let wasm = null
let params = null
let fieldView = null
let grid = { w: 0, h: 0 }
let free = []
let running = false
let started = false
let idle = true
let timer = null
let last = 0
let acc = 0
let pending = null

const frameBytes = () => grid.w * grid.h * 4 * 2

function refreshViews() {
  // init() allocates, which can grow wasm memory and detach existing views.
  const memory = wasm.memory.buffer
  params = new Float32Array(memory, wasm.params_ptr(), wasm.params_len())
  fieldView = new Uint16Array(memory, wasm.out_ptr(), wasm.out_len())
}

function allocate() {
  const bytes = frameBytes()
  free = [new ArrayBuffer(bytes), new ArrayBuffer(bytes)]
}

function post() {
  if (!free.length) return
  const buffer = free.pop()
  new Uint16Array(buffer).set(fieldView)
  port.postMessage({ type: 'frame', buffer, w: grid.w, h: grid.h, active: wasm.active() }, [buffer])
}

function tick() {
  if (!running) return
  const now = performance.now()
  const elapsed = Math.min((now - last) / 1000, 0.25)
  last = now

  const wasIdle = idle
  idle = wasm.idle() === 1
  if (idle !== wasIdle) port.postMessage({ type: 'idle', idle })

  acc += elapsed
  let ticks = Math.floor(acc / SIM_DT)
  if (ticks > MAX_TICKS_PER_STEP) {
    ticks = MAX_TICKS_PER_STEP
    acc = 0
  } else {
    acc -= ticks * SIM_DT
  }

  // A settled grid is not stepped and not sent. One last frame goes out as it
  // settles, so the renderer has the clean field, and then the worker does
  // nothing until something excites it again.
  if (idle) {
    if (!wasIdle) post()
  } else if (ticks > 0) {
    for (let i = 0; i < ticks; i++) wasm.step(SIM_DT)
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
  port.postMessage({ type: 'idle', idle: false })
}

function writeParams(patch) {
  for (const index in patch) params[index] = patch[index]
}

/** The clock starts once there is a grid to step. Only ever once. */
function begin() {
  started = true
  running = true
  last = performance.now()
  port.postMessage({ type: 'ready', w: grid.w, h: grid.h })
  tick()
}

/** True if the grid was built. A refused size leaves the solver unusable. */
function resize({ w, h, params: patch, seed }) {
  if (!wasm.init(w, h)) {
    port.postMessage({ type: 'error', message: `tiles: the solver refused a ${w}x${h} grid` })
    return false
  }
  grid = { w, h }
  refreshViews()
  if (patch) writeParams(patch)
  if (seed !== undefined) wasm.reseed(seed >>> 0)
  allocate()
  idle = true
  // With `rate: 0` the grid is settled from the start, and a settled grid
  // sends nothing — but the renderer draws nothing either until it has a
  // field, and the page's own elements are already hidden by then. A new
  // grid owes it the resting one.
  post()
  return true
}

port.onmessage = async ({ data: msg }) => {
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
      // A URL in the browser; the bytes themselves under Node, which has no
      // fetch for a file.
      const bytes = msg.wasm instanceof ArrayBuffer ? msg.wasm : await (await fetch(msg.wasm)).arrayBuffer()
      const { instance } = await WebAssembly.instantiate(bytes, {})
      wasm = instance.exports
      // A grid the solver refused leaves it with no state at all, and every
      // call into it from here would trap. Stay stopped and say so; the next
      // good size starts the clock instead.
      if (resize(pending ?? msg)) begin()
      pending = null
      break
    }
    case 'resize':
      if (resize(msg) && !started) begin()
      break
    case 'params':
      writeParams(msg.patch)
      // A rate switched on while idle has to restart the clock.
      rouse()
      break
    case 'pulse':
      wasm.pulse(msg.x, msg.y, msg.radius, msg.strength)
      rouse()
      break
    case 'beat':
      wasm.beat(msg.strength)
      rouse()
      break
    case 'drive':
      wasm.drive(msg.level)
      if (msg.level > 0) rouse()
      break
    case 'reseed':
      wasm.reseed(msg.seed >>> 0)
      post()
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
