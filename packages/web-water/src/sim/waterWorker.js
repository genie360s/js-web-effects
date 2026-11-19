// Simulation thread. Owns the wasm core, integrates at a fixed timestep, and
// ships packed half-float frames to the renderer.
//
// Flow control is a two-buffer ping-pong: the worker only posts a frame when it
// holds a free buffer, and the main thread returns one after each upload. That
// throttles the worker to the display rate without two timers having to agree
// on a number, and every hand-off is a transfer, so no frame is ever copied
// across the thread boundary.

/** Simulation rate. Decoupled from the display: physics must not change speed with framerate. */
const SIM_HZ = 60
const SIM_DT = 1 / SIM_HZ
/** An idling pond steps at half rate. `dt` scales with it, so the breeze stays wall-clock correct. */
const IDLE_HZ = 30
/** Never catch up more than this after a stall, or one slow frame snowballs. */
const MAX_STEPS_PER_TICK = 3
/** Below this energy, with no recent input, the surface has settled. */
const IDLE_ENERGY = 4e-4
const IDLE_AFTER_MS = 1500

/** A drag slower than this (cells/s) also sheds concentric rings. */
const GENTLE_SPEED = 90
/** Speed at which the wake is fully developed (cells/s). */
const FAST_SPEED = 900
const RING_INTERVAL_MS = 55
/** How pronounced the wake is. Dimensionless: the deposit itself is scaled by
 *  how far the point actually travelled. */
const WAKE_GAIN = 0.22
/** A wake outlives the pointer sample that made it, but not by much. */
const WAKE_HOLD_MS = 90

let wasm = null
let memU16 = null
let grid = { w: 0, h: 0 }
let free = []
let running = false
let breeze = 1
let idle = false
let lastPointerAt = -1e9
let lastRingAt = 0
let prev = null
let timer = null
let last = 0
let acc = 0
let pendingResize = null
let cellAspect = 1
/** Latest heading and speed, so the wake is laid once per tick, not once per event. */
let moving = null

function refreshMemoryView() {
  // init() allocates, which can grow wasm memory and detach any existing view.
  memU16 = new Uint16Array(wasm.memory.buffer, wasm.out_ptr(), wasm.out_len())
}

/** Bytes one frame occupies at the current grid. */
function frameBytes() {
  return grid.w * grid.h * 2 * Uint16Array.BYTES_PER_ELEMENT
}

function allocate(w, h) {
  grid = { w, h }
  const bytes = frameBytes()
  free = [new ArrayBuffer(bytes), new ArrayBuffer(bytes)]
}

function post() {
  if (!free.length) return
  const buffer = free.pop()
  new Uint16Array(buffer).set(memU16)
  self.postMessage({ type: 'frame', buffer, w: grid.w, h: grid.h }, [buffer])
}

function tick() {
  if (!running) return
  const now = performance.now()
  const elapsed = Math.min((now - last) / 1000, 0.25)
  last = now

  if (!idle && now - lastPointerAt > IDLE_AFTER_MS && wasm.energy() < IDLE_ENERGY) {
    idle = true
    self.postMessage({ type: 'idle', idle: true })
  }

  const dt = idle ? 1 / IDLE_HZ : SIM_DT
  acc += elapsed
  let steps = Math.floor(acc / dt)
  if (steps > MAX_STEPS_PER_TICK) {
    steps = MAX_STEPS_PER_TICK
    acc = 0
  } else {
    acc -= steps * dt
  }

  if (steps > 0) {
    // The wake is a per-frame deposit, not a per-event one: coalesced pointer
    // samples can arrive a dozen to a frame and would stamp it that many times.
    if (moving) {
      if (now - moving.at > WAKE_HOLD_MS) moving = null
      else {
        wasm.wake(moving.x, moving.y, moving.nx, moving.ny, moving.speed, moving.advance, WAKE_GAIN)
        moving.advance = 0
      }
    }
    wasm.step(dt, steps)
    post()
  }
  timer = setTimeout(tick, 1000 / (idle ? IDLE_HZ : SIM_HZ))
}

function rouse() {
  lastPointerAt = performance.now()
  if (idle) {
    idle = false
    self.postMessage({ type: 'idle', idle: false })
  }
}

/** One pointer segment, in grid cells. Always a stroke; rings too when gentle. */
function handlePointer({ x, y, dt, down }) {
  rouse()
  if (!prev || !dt) {
    prev = { x, y }
    return
  }

  const p0 = prev
  const dist = Math.hypot(x - p0.x, y - p0.y)
  const speed = dist / Math.max(dt, 1e-3)
  prev = { x, y }
  if (dist < 1e-3) return

  const fast = Math.min(speed / FAST_SPEED, 1)
  // A fingertip does not get fatter as it moves faster. Growing the footprint
  // with speed is what made a flick read as a circular brush being dragged;
  // shrinking it leaves a point cutting through the water, and the wake below
  // carries the sense of speed instead.
  const base = Math.max(grid.w, grid.h) * 0.014
  const radius = base * (down ? 1.4 : 1) * (1 - 0.45 * fast)

  // Gentle motion barely displaces water; a fast flick shoves it.
  const t = Math.min(speed / FAST_SPEED, 1.4)
  // Pond water barely moves under a finger: a ripple is a millimetre of
  // displacement, not a wave. These are small on purpose.
  // The direct stamp stays modest even at speed: past a walking pace it is the
  // wake, not the fingertip, that should be carrying the sense of motion.
  const strength = 0.004 + 0.004 * t * t
  wasm.stroke(p0.x, p0.y, x, y, radius, strength, speed)

  // Heading in screen space, so the wake's V opens symmetrically on screen
  // rather than on a grid whose cells need not be square.
  const hx = x - p0.x
  const hy = (y - p0.y) * cellAspect
  const hlen = Math.hypot(hx, hy)
  if (hlen > 1e-4) {
    // Accumulate distance between ticks: several coalesced samples can land in
    // one frame, and the wake is laid from their total, once.
    const advance = (moving?.advance ?? 0) + hlen
    moving = { x, y, nx: hx / hlen, ny: hy / hlen, speed, advance, at: performance.now() }
  }

  // A finger trailed slowly through a pond sheds a train of rings rather than
  // one continuous wake. Rate-limited, so a fast stroke never gets them.
  const now = performance.now()
  if (speed < GENTLE_SPEED && now - lastRingAt > RING_INTERVAL_MS) {
    lastRingAt = now
    wasm.touch(x, y, radius * 0.75, 0.005 + 0.013 * (1 - speed / GENTLE_SPEED))
  }
}

function resize(w, h, aspect) {
  cellAspect = aspect
  wasm.init(w, h, aspect)
  wasm.set_breeze(breeze)
  refreshMemoryView()
  allocate(w, h)
  prev = null
}

self.onmessage = async ({ data: msg }) => {
  // Everything below `init` needs the module. Fetching it is asynchronous, and
  // the page starts sending pointer events the moment the canvas exists, so
  // input can and does arrive first.
  if (!wasm && msg.type !== 'init') {
    if (msg.type === 'resize') pendingResize = msg
    return
  }

  switch (msg.type) {
    case 'init': {
      const res = await fetch(msg.wasmUrl)
      const { instance } = await WebAssembly.instantiate(await res.arrayBuffer(), {})
      wasm = instance.exports
      const size = pendingResize ?? msg
      pendingResize = null
      resize(size.w, size.h, size.aspect)
      running = true
      last = performance.now()
      self.postMessage({ type: 'ready', w: grid.w, h: grid.h })
      tick()
      break
    }
    case 'resize':
      resize(msg.w, msg.h, msg.aspect)
      break
    case 'pointer':
      for (const s of msg.samples) handlePointer(s)
      break
    case 'drop':
      // A dropped stone: one deep, wide dimple.
      rouse()
      wasm.touch(msg.x, msg.y, Math.max(grid.w, grid.h) * (msg.radius ?? 0.035), msg.strength ?? 0.06)
      break
    case 'release':
      prev = null
      moving = null
      break
    case 'breeze':
      breeze = msg.value
      if (wasm) wasm.set_breeze(breeze)
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
