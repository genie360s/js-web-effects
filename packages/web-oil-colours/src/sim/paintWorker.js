// Simulation thread. Owns the wasm core, integrates at a fixed timestep, and
// ships packed half-float frames to the renderer.
//
// Flow control is a two-buffer ping-pong: the worker only posts a frame when it
// holds a free buffer, and the main thread returns one after each upload. That
// throttles the worker to the display rate without two timers having to agree
// on a number, and every hand-off is a transfer, so no frame is ever copied
// across the thread boundary.

/** Simulation rate. Decoupled from the display: paint must not flow faster on a
 *  120Hz panel than on a 60Hz one. */
const SIM_HZ = 60
const SIM_DT = 1 / SIM_HZ
/** Never catch up more than this after a stall, or one slow frame snowballs. */
const MAX_STEPS_PER_TICK = 3
/** Mean flow speed below which the canvas counts as settled. The solver's yield
 *  stress brings an untouched canvas to exactly zero; a freshly worked one
 *  chatters a little around the yield surface at well under a hundredth of a
 *  cell per step, which is invisible and not worth a timer. */
const REST_ENERGY = 0.05
/** ...but only once the cursor has been away long enough that stopping cannot
 *  be mistaken for a dropped stroke. */
const REST_AFTER_MS = 900
/** How firmly the cursor grips the paint under it, over one pass of the brush.
 *  Near one because that is the physical answer: paint touching a bristle moves
 *  with it. What slip there is in real life happens below the surface film,
 *  which a height field does not have. */
const GRIP = 0.995
/** A pointer sample claiming less than this much time gives a wild velocity;
 *  browsers do emit them. */
const MIN_SAMPLE_DT = 1 / 240
/** How fast the brush swings round to a new direction. The footprint is a flat
 *  edge, so it has to point somewhere, and following raw pointer jitter would
 *  make it spin on the spot between samples. */
const HEADING_EASE = 0.3
/** Distance, in brush radii, over which a loaded brush runs itself dry. This is
 *  what makes a stroke start solid and break up into bristle marks as it goes,
 *  instead of extruding an even ribbon forever. */
const CHARGE_SPAN = 16
/** A brush that has run dry still leaves something behind. */
const CHARGE_FLOOR = 0.18

let wasm = null
let memU16 = null
let grid = { w: 0, h: 0 }
let seed = 7
let wetness = 1
/** Start on bare linen rather than a seeded painting. */
let bare = false
/** Grid the main thread last asked for. It can move before the wasm lands. */
let want = { w: 0, h: 0 }
let free = []
let running = false
/** Set by the host, and remembered across an init: a tab hidden while the core
 *  was still downloading must not come back ticking. */
let paused = false
let frozen = false
let timer = null
let last = 0
let acc = 0
let lastPointerAt = -1e9
/** Previous pointer position, in grid cells. Null between strokes so a cursor
 *  that left the canvas and came back does not smear across the gap. */
let prev = null
let painting = false
let brush = { radius: 0.055, flow: 26, color: [0.871, 0.188, 0.125] }
/** Which way the brush is pointing, and how much paint is left on it. */
let heading = { x: 1, y: 0 }
let charge = 1
/** Chooses the bristle loads. New every stroke, so no two marks are combed the
 *  same way, and constant within one, so the furrows run its whole length. */
let strokeSeed = 1

/** Brush radius in cells. Stored as a fraction of the short side so the brush
 *  keeps its size on screen when the grid changes under a tier switch. */
function radiusCells() {
  return Math.max(2, brush.radius * Math.min(grid.w, grid.h))
}

/** Bytes one frame occupies at the current grid. */
function frameBytes() {
  return grid.w * grid.h * 4 * Uint16Array.BYTES_PER_ELEMENT
}

function allocate(w, h) {
  grid = { w, h }
  free = [new ArrayBuffer(frameBytes()), new ArrayBuffer(frameBytes())]
}

function post() {
  if (!free.length) return
  const buffer = free.pop()
  new Uint16Array(buffer).set(memU16)
  self.postMessage({ type: 'frame', buffer, w: grid.w, h: grid.h }, [buffer])
}

/** Start ticking, from a clean clock so a long pause is not treated as lag. */
function resume() {
  if (!wasm || !running || frozen || timer) return
  last = performance.now()
  acc = 0
  timer = setTimeout(tick, 0)
}

/** Wake the simulation. Every message that can change the canvas calls this. */
function rouse(touched) {
  if (touched) lastPointerAt = performance.now()
  if (!frozen) return
  frozen = false
  self.postMessage({ type: 'idle', idle: false })
  resume()
}

function freeze() {
  frozen = true
  clearTimeout(timer)
  timer = null
  self.postMessage({ type: 'idle', idle: true })
}

function tick() {
  timer = null
  if (!running || frozen) return
  const now = performance.now()
  const elapsed = Math.min((now - last) / 1000, 0.25)
  last = now

  acc += elapsed
  let steps = Math.floor(acc / SIM_DT)
  if (steps > MAX_STEPS_PER_TICK) {
    steps = MAX_STEPS_PER_TICK
    acc = 0
  } else {
    acc -= steps * SIM_DT
  }

  if (steps > 0) {
    wasm.step(SIM_DT, steps)
    post()
    if (now - lastPointerAt > REST_AFTER_MS && wasm.energy() < REST_ENERGY) {
      freeze()
      return
    }
  }
  timer = setTimeout(tick, 1000 / SIM_HZ)
}

/**
 * One batch of pointer samples, each in grid cells with the seconds since the
 * one before it. Segments are handed to the core whole rather than as points:
 * a fast flick arrives as a handful of far-apart samples, and stamping only
 * where they landed would bead the stroke.
 */
function handlePointer(samples) {
  rouse(true)
  const radius = radiusCells()
  const [r, g, b] = brush.color
  for (const s of samples) {
    if (prev === null) newStroke()
    const from = prev ?? s
    const dt = Math.max(s.dt, MIN_SAMPLE_DT)
    const dx = s.x - from.x
    const dy = s.y - from.y
    const len = Math.hypot(dx, dy)
    // Only re-aim on a sample that actually went somewhere: a stationary
    // pointer still emits events, and dividing by its zero displacement would
    // point the brush at nothing.
    if (len > 0.25) {
      heading.x += (dx / len - heading.x) * HEADING_EASE
      heading.y += (dy / len - heading.y) * HEADING_EASE
      const hl = Math.hypot(heading.x, heading.y) || 1
      heading.x /= hl
      heading.y /= hl
    }

    wasm.smear(
      from.x, from.y, s.x, s.y,
      dx / dt, dy / dt, heading.x, heading.y,
      radius, GRIP, strokeSeed,
    )
    if (painting) {
      // Flow is a rate, so holding still loads the canvas per second rather
      // than per pointer event — otherwise a 240Hz mouse paints four times as
      // fast as a 60Hz one.
      const amount = brush.flow * dt * (CHARGE_FLOOR + (1 - CHARGE_FLOOR) * charge)
      wasm.deposit(
        from.x, from.y, s.x, s.y,
        heading.x, heading.y, radius,
        r, g, b, amount, strokeSeed,
      )
      charge *= Math.exp(-len / (radius * CHARGE_SPAN))
    }
    prev = { x: s.x, y: s.y }
  }
}

/** Reload the brush and recut its bristles. */
function newStroke() {
  strokeSeed = (strokeSeed * 1664525 + 1013904223) >>> 0
  charge = 1
}

/** Instantiate the core, streaming if the server will allow it. */
async function load(url) {
  try {
    return (await WebAssembly.instantiateStreaming(fetch(url), {})).instance
  } catch (streamed) {
    // Streaming refuses anything not served as `application/wasm`, which plenty
    // of static hosts get wrong. The fallback costs one extra copy of 48kB.
    const res = await fetch(url)
    // Checked before handing the body to the compiler: a 404 page compiled as
    // wasm reports "magic word expected", which sends you looking in the wrong
    // place entirely.
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} fetching ${url}`)
    try {
      return (await WebAssembly.instantiate(await res.arrayBuffer(), {})).instance
    } catch (buffered) {
      throw new Error(`${buffered.message} (streaming first said: ${streamed.message})`)
    }
  }
}

function start(w, h) {
  allocate(w, h)
  wasm.init(w, h, seed)
  // init always lays a canvas; scraping it back costs a fill and keeps one
  // code path rather than threading a flag through the core's constructor.
  if (bare) wasm.clear()
  wasm.set_wetness(wetness)
  // init() allocates, which can grow wasm memory and detach any existing view.
  memU16 = new Uint16Array(wasm.memory.buffer, wasm.out_ptr(), wasm.out_len())
  frozen = false
  prev = null
  post()
  clearTimeout(timer)
  timer = null
  resume()
}

const handlers = {
  async init({ wasmUrl, w, h, seed: s, bare: b }) {
    seed = s ?? seed
    bare = !!b
    want = { w, h }
    try {
      wasm = (await load(wasmUrl)).exports
    } catch (err) {
      // An unhandled rejection inside a worker does not reach the page's
      // `onerror`, so without this the canvas sits on its loading message for
      // ever and says nothing about why.
      self.postMessage({ type: 'failed', message: String(err?.message ?? err) })
      return
    }
    running = !paused
    // `want`, not the size this message carried: the wasm fetch easily outlives
    // the resize debounce, and the main thread has already committed to the new
    // grid when it maps pointer positions into cells. Starting at a stale size
    // would put every stroke in the wrong place until the next resize.
    start(want.w, want.h)
    self.postMessage({ type: 'ready' })
  },
  resize({ w, h }) {
    want = { w, h }
    if (!wasm || (w === grid.w && h === grid.h)) return
    // The canvas cannot be carried across a regrid — the core has no resampler,
    // and adding one to survive a window drag is not worth the code.
    // ponytail: resize restarts the painting. Resample in Rust if that bites.
    start(w, h)
  },
  pointer({ samples }) {
    if (wasm) handlePointer(samples)
  },
  /** Pressing lays new colour; releasing goes back to smearing what is there. */
  paint({ on, color }) {
    painting = on
    if (color) brush.color = color
    // Picking up a colour is dipping the brush: it comes back loaded.
    if (on) charge = 1
    rouse(true)
  },
  release() {
    prev = null
    painting = false
  },
  brush({ radius }) {
    brush.radius = radius
  },
  wetness({ value }) {
    wetness = value
    // Held here, not only pushed into the core: init() is async, so a value
    // that arrives while the wasm is still downloading has nowhere to go yet.
    wasm?.set_wetness(value)
    rouse(true)
  },
  reseed({ seed: s }) {
    // Recorded before the guard: a reseed that lands during the wasm fetch
    // still has to be the canvas that gets laid when start() runs.
    seed = s
    if (!wasm) return
    if (bare) wasm.clear()
    else wasm.reseed(s)
    rouse(true)
  },
  pause({ paused: stop }) {
    paused = stop
    running = !stop
    if (stop) {
      clearTimeout(timer)
      timer = null
    } else {
      resume()
    }
  },
  /** Scrape the canvas back to bare linen. */
  clear() {
    if (!wasm) return
    wasm.clear()
    rouse(true)
  },
  /** Lay a component's surface into the paint. From here it is paint like any
   *  other: the cursor drags it and it mixes with what it is dragged into. */
  stamp({ rgba, x, y, w, h, amount, relief }) {
    if (!wasm) return
    const into = new Uint8Array(wasm.memory.buffer, wasm.in_ptr(), wasm.in_len())
    if (rgba.length > into.length) return
    into.set(rgba)
    wasm.stamp(x, y, w, h, amount, relief ?? 0)
    rouse(true)
  },
  recycle({ buffer }) {
    // A frame can still be in flight when a resize reallocates the pool, and it
    // comes back sized for the grid we just left. Taking it would mean the next
    // post copies a larger frame into a smaller buffer, which throws and kills
    // the worker — the canvas then freezes for good. Let the stale one go.
    if (buffer.byteLength === frameBytes()) free.push(buffer)
  },
}

self.onmessage = ({ data }) => handlers[data.type]?.(data)
