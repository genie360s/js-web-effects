<script setup>
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { createRenderer } from '../render/renderer'
import { createGovernor, gridFor, pixelsFor } from '../render/quality'
import wasmUrl from '../sim/oil-core.wasm?url'
import PaintWorker from '../sim/paintWorker.js?worker'

/** Room left around an element for its paint to wander past the box, in CSS
 *  pixels. Covers the widest excursion the drawing makes. */
const BLEED = 30

const props = defineProps({
  quality: { type: String, default: 'auto' }, // 'auto' | 'low' | 'medium' | 'high' | 'ultra'
  /** 0 is paint gone tacky, 1 is straight out of the tube. */
  wetness: { type: Number, default: 1 },
  /** Brush radius as a fraction of the canvas's short side. */
  brushSize: { type: Number, default: 0.055 },
  /** Loaded colour as linear-free sRGB [r, g, b] in 0..1, or null for a clean
   *  brush that only moves what is already there. */
  color: { type: Array, default: null },
  seed: { type: Number, default: 7 },
  /** Start on bare linen instead of a seeded painting. */
  bare: { type: Boolean, default: false },
})
const emit = defineEmits(['stats', 'reset', 'ready'])

const host = ref(null)
const canvas = ref(null)
const status = ref('laying the ground')

const renderer = shallowRef(null)
const worker = shallowRef(null)

let governor = null
let raf = 0
let lastFrame = 0
let grid = { w: 0, h: 0 }
let pending = [] // pointer samples awaiting the next flush
let lastStamp = 0
let hasFrame = false
let pressed = false
let idling = false
let settled = false // one frame has been drawn since the worker went quiet
let sinceStats = 0
let resizeTimer = 0
let destroyed = false
let observer = null
/** The core is instantiated asynchronously, so work can be asked for before it
 *  exists. Held here rather than dropped, and flushed when it reports in. */
let coreReady = false
let queued = []
/** One grid-sized scratch canvas, reused across frames. */
let frameCanvas = null
let frame2d = null
/** The core failed to start; nothing will ever be drawn again. */
let dead = false

/** Pointer position in grid cells. Grid row 0 is the bottom, matching the
 *  texture, so the y axis flips here and nowhere else. */
function queueSample(ev, rect) {
  const dt = lastStamp ? Math.max((ev.timeStamp - lastStamp) / 1000, 1 / 1000) : 0
  lastStamp = ev.timeStamp
  pending.push({
    x: ((ev.clientX - rect.left) / rect.width) * grid.w,
    y: (1 - (ev.clientY - rect.top) / rect.height) * grid.h,
    dt,
  })
}

/** The worker stops sending frames once the paint settles, so the render loop
 *  has to be restartable from any event that could disturb it. */
function wake() {
  if (dead) return
  settled = false
  if (!raf && !document.hidden) {
    lastFrame = 0
    raf = requestAnimationFrame(frame)
  }
}

function onPointerMove(ev) {
  if (!worker.value) return
  // Coalesced events are the whole game for fast drags: without them a quick
  // swipe arrives as two far-apart points and the smear comes out as beads.
  const events = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev]
  // One rect for the whole batch. Reading it is a forced layout, and a fast
  // drag delivers a dozen coalesced samples in a frame.
  const rect = canvas.value.getBoundingClientRect()
  for (const e of events) queueSample(e, rect)
  wake()
}

function setPainting(on) {
  pressed = on
  worker.value?.postMessage({
    type: 'paint',
    on: on && !!props.color,
    // Copied, not passed through: an array handed in from a `ref` is a reactive
    // Proxy, and structured clone refuses to post a Proxy. A caller should not
    // have to know which kind of ref its colour came out of.
    color: props.color ? Array.from(props.color) : undefined,
  })
}

function onPointerDown(ev) {
  if (!worker.value) return
  // Capture on the canvas itself: a parent that captured instead would stop
  // these events reaching it, and the paint would go dead for the whole drag.
  canvas.value.setPointerCapture?.(ev.pointerId)
  lastStamp = ev.timeStamp
  queueSample(ev, canvas.value.getBoundingClientRect())
  setPainting(true)
  wake()
}

function endStroke() {
  if (!worker.value) return
  setPainting(false)
  worker.value.postMessage({ type: 'release' })
  lastStamp = 0
}

function flushPointer() {
  if (!pending.length || !worker.value) return
  worker.value.postMessage({ type: 'pointer', samples: pending })
  pending = []
}

function applySize({ regrid = true } = {}) {
  const el = host.value
  if (!el || !renderer.value) return
  const cssW = el.clientWidth || 1
  const cssH = el.clientHeight || 1
  const tier = governor.tier

  const px = pixelsFor(tier, cssW, cssH)
  renderer.value.resize(px.w, px.h)

  if (regrid) {
    const g = gridFor(tier, cssW, cssH)
    if (g.w !== grid.w || g.h !== grid.h) {
      grid = g
      // A regrid restarts the core on a fresh canvas, so anything that laid
      // paint into it has to lay it again. Anything still waiting to be laid
      // was measured against the grid we are leaving, so it is dropped rather
      // than deposited as a ghost at the old size and position.
      queued = []
      worker.value?.postMessage({ type: 'resize', w: g.w, h: g.h })
      emit('reset')
    }
  }
  wake()
}

function onTierChange() {
  if (destroyed || !renderer.value) return
  applySize()
}

function emitStats() {
  emit('stats', {
    fps: governor.fps,
    tier: governor.tier,
    auto: governor.auto,
    grid: `${grid.w}×${grid.h}`,
    cells: grid.w * grid.h,
    idle: idling,
  })
}

function frame(now) {
  // Nothing on this canvas animates on its own, so once the worker has gone
  // quiet and the last frame is on screen there is no reason to keep a render
  // loop running. Any pointer event or new frame starts it again.
  if (idling && settled) {
    raf = 0
    return
  }
  raf = requestAnimationFrame(frame)
  if (lastFrame) governor.sample(now - lastFrame)
  lastFrame = now

  flushPointer()
  if (hasFrame) {
    renderer.value.render({ wet: props.wetness })
    if (idling) settled = true
  }
  if (++sinceStats >= 30) {
    sinceStats = 0
    emitStats()
  }
}

function onMessage({ data }) {
  if (data.type === 'ready') {
    coreReady = true
    emit('ready')
    for (const msg of queued) worker.value.postMessage(msg, [msg.rgba.buffer])
    queued = []
    return
  }
  if (data.type === 'failed') {
    status.value = `the paint core could not start: ${data.message}`
    // Nothing will ever be drawn, so stop asking for frames — and stay stopped,
    // which a flag has to say: `settled` is cleared by every `wake()`, and it is
    // only re-set once a frame has been rendered, which will never happen here.
    dead = true
    queued = []
    cancelAnimationFrame(raf)
    raf = 0
    return
  }
  if (data.type === 'idle') {
    idling = data.idle
    if (!idling) wake()
    emitStats()
    return
  }
  if (data.type !== 'frame') return

  renderer.value.uploadFrame(new Uint16Array(data.buffer), data.w, data.h)
  hasFrame = true
  settled = false
  wake()
  status.value = ''
  // Hand the buffer straight back so the worker always has one to fill.
  worker.value.postMessage({ type: 'recycle', buffer: data.buffer }, [data.buffer])
}

function onVisibility() {
  const hidden = document.hidden
  worker.value?.postMessage({ type: 'pause', paused: hidden })
  if (hidden) {
    cancelAnimationFrame(raf)
    raf = 0
  } else {
    wake()
  }
}

onMounted(() => {
  governor = createGovernor(onTierChange)

  try {
    renderer.value = createRenderer(canvas.value)
  } catch (err) {
    status.value = err.message
    return
  }

  applySize({ regrid: false })
  grid = gridFor(governor.tier, host.value.clientWidth || 1, host.value.clientHeight || 1)

  const w = new PaintWorker()
  w.onmessage = onMessage
  w.onerror = (err) => {
    status.value = `the paint thread stopped: ${err.message ?? 'unknown error'}`
  }
  w.postMessage({ type: 'init', wasmUrl, w: grid.w, h: grid.h, seed: props.seed, bare: props.bare })
  w.postMessage({ type: 'wetness', value: props.wetness })
  w.postMessage({ type: 'brush', radius: props.brushSize })
  worker.value = w

  observer = new ResizeObserver(() => {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => !destroyed && applySize(), 120)
  })
  observer.observe(host.value)

  document.addEventListener('visibilitychange', onVisibility)

  raf = requestAnimationFrame(frame)
})

onBeforeUnmount(() => {
  destroyed = true
  observer?.disconnect()
  document.removeEventListener('visibilitychange', onVisibility)
  clearTimeout(resizeTimer)
  cancelAnimationFrame(raf)
  queued = []
  worker.value?.terminate()
  renderer.value?.dispose()
})

watch(() => props.wetness, (v) => worker.value?.postMessage({ type: 'wetness', value: v }))
watch(() => props.brushSize, (v) => worker.value?.postMessage({ type: 'brush', radius: v }))
watch(() => props.quality, (v) => governor?.setManual(v === 'auto' ? null : v))
watch(() => props.seed, (v) => {
  queued = []
  worker.value?.postMessage({ type: 'reseed', seed: v })
  emit('reset')
})
watch(() => props.color, () => setPainting(pressed))
defineExpose({
  /**
   * Lay a whole picture into the paint: an image, a video frame, a canvas.
   *
   * Cover-fitted to the grid and deposited like any other paint, so from here
   * it is paint — the cursor drags it and it mixes. `amount` is how much is
   * laid: enough to cover in one go for a still picture, or a little each frame
   * for a moving one, which reads as a painter re-laying the same picture over
   * and over while your smears slowly get painted back in. `relief` lays the
   * lights thicker than the darks, which is what gives a photograph a surface
   * instead of leaving it looking like a photograph.
   */
  paintFrame(source, amount = 3.2, relief = 0.85) {
    if (dead || !worker.value || !coreReady || !grid.w) return false
    const sw = source.videoWidth || source.naturalWidth || source.width
    const sh = source.videoHeight || source.naturalHeight || source.height
    if (!sw || !sh) return false

    if (!frameCanvas) {
      frameCanvas = document.createElement('canvas')
      frame2d = frameCanvas.getContext('2d', { willReadFrequently: true })
    }
    if (frameCanvas.width !== grid.w || frameCanvas.height !== grid.h) {
      frameCanvas.width = grid.w
      frameCanvas.height = grid.h
    }
    // Cleared first: drawImage composites source-over, the canvas is reused
    // between sources, and a picture with transparency in it would otherwise
    // show whatever was laid last through its own holes.
    frame2d.clearRect(0, 0, grid.w, grid.h)
    // Cover, not stretch: the grid's aspect follows the viewport's, which is
    // rarely the picture's.
    const scale = Math.max(grid.w / sw, grid.h / sh)
    const cw = grid.w / scale
    const ch = grid.h / scale
    frame2d.drawImage(source, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, grid.w, grid.h)

    // A view of the pixels, not a copy of them: it is transferred away on the
    // next line and never read here again.
    const { data } = frame2d.getImageData(0, 0, grid.w, grid.h)
    const rgba = new Uint8Array(data.buffer, data.byteOffset, data.length)
    worker.value.postMessage(
      { type: 'stamp', rgba, x: 0, y: 0, w: grid.w, h: grid.h, amount, relief },
      [rgba.buffer],
    )
    wake()
    return true
  },
  /** Scrape the canvas back to bare linen. Anything still waiting for the core
   *  to finish starting is dropped with it — it was going to be scraped off a
   *  moment later anyway, and a caller that wants it back lays it again. */
  clear() {
    queued = []
    worker.value?.postMessage({ type: 'clear' })
    wake()
  },
  /**
   * Lay something into the paint. `rect` is in CSS pixels relative to the
   * canvas. `draw(ctx, w, h, where, at)` fills a canvas of that CSS size with
   * the surface to deposit — colour plus an alpha that says how much paint each
   * pixel is worth. `where` is the element's own box inside that canvas, which
   * is not simply inset by the bleed once the canvas has been clipped at an
   * edge; `at` is where the canvas sits relative to this one, for callers
   * placing things by their own coordinates.
   *
   * It is drawn at CSS size and then scaled down to the simulation grid, so the
   * caller can work in the units its CSS already uses and gets the browser's
   * filtering on the way down for free.
   */
  stamp(rect, draw, amount) {
    const el = canvas.value
    if (dead || !worker.value || !el || !grid.w) return false
    const box = el.getBoundingClientRect()
    if (!box.width || !box.height) return false

    // Room for the drawing to wander past the element's box, and then clipped
    // to the canvas: a full-bleed element plus its bleed overshoots the grid,
    // and refusing it outright would leave it unpainted and retried for ever.
    const left = Math.max(0, rect.x - BLEED)
    const top = Math.max(0, rect.y - BLEED)
    const right = Math.min(box.width, rect.x + rect.w + BLEED)
    const bottom = Math.min(box.height, rect.y + rect.h + BLEED)
    if (right <= left || bottom <= top) return false

    const cellX = (px) => (px / box.width) * grid.w
    // Grid row 0 is the bottom, so the rect's lower edge is the lower row.
    const cellY = (py) => (1 - py / box.height) * grid.h
    const x = Math.max(0, Math.floor(cellX(left)))
    const y = Math.max(0, Math.floor(cellY(bottom)))
    const w = Math.max(1, Math.min(grid.w - x, Math.ceil(cellX(right)) - x))
    const h = Math.max(1, Math.min(grid.h - y, Math.ceil(cellY(top)) - y))

    const css = document.createElement('canvas')
    css.width = Math.max(1, Math.round(right - left))
    css.height = Math.max(1, Math.round(bottom - top))
    const where = { x: rect.x - left, y: rect.y - top, w: rect.w, h: rect.h }
    draw(css.getContext('2d'), css.width, css.height, where, { x: left, y: top })

    const cells = document.createElement('canvas')
    cells.width = w
    cells.height = h
    const cctx = cells.getContext('2d', { willReadFrequently: true })
    cctx.drawImage(css, 0, 0, w, h)
    const { data } = cctx.getImageData(0, 0, w, h)
    const rgba = new Uint8Array(data)
    const msg = { type: 'stamp', rgba, x, y, w, h, amount }
    if (coreReady) worker.value.postMessage(msg, [rgba.buffer])
    else queued.push(msg)
    wake()
    return true
  },
})
</script>

<template>
  <div ref="host" class="paint">
    <canvas
      ref="canvas"
      class="paint__canvas"
      @pointermove="onPointerMove"
      @pointerdown="onPointerDown"
      @pointerup="endStroke"
      @pointercancel="endStroke"
      @pointerleave="endStroke"
    />
    <Transition name="fade">
      <p v-if="status" class="paint__status">{{ status }}</p>
    </Transition>
  </div>
</template>

<style scoped>
.paint {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: #1a1512;
}

.paint__canvas {
  display: block;
  width: 100%;
  height: 100%;
  touch-action: none; /* the pointer belongs to the paint, not to scrolling */
}

.paint__status {
  position: absolute;
  inset: auto 0 2.5rem 0;
  margin: 0;
  text-align: center;
  font-size: 0.8125rem;
  letter-spacing: 0.14em;
  text-transform: lowercase;
  color: rgba(242, 232, 218, 0.5);
}

.fade-leave-active {
  transition: opacity 0.8s ease;
}
.fade-leave-to {
  opacity: 0;
}
</style>
