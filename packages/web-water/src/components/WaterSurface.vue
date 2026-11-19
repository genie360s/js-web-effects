<script setup>
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { createRenderer } from '../render/renderer'
import { generateBed } from '../render/bed'
import { createGovernor, gridFor, pixelsFor, TIERS } from '../render/quality'
import wasmUrl from '../sim/water-core.wasm?url'
import WaterWorker from '../sim/waterWorker.js?worker'

const props = defineProps({
  breeze: { type: Number, default: 1 },
  quality: { type: String, default: 'auto' }, // 'auto' | 'low' | 'medium' | 'high' | 'ultra'
  seed: { type: Number, default: 7 },
  /** Depth of the submerged interface layer, in half-screen-height units. 0 is off. */
  uiDepth: { type: Number, default: 0 },
  /** How deep the pond reads. Drives refraction offset and absorption. */
  waterDepth: { type: Number, default: 0.14 },
  /** Whether pressing the surface drops a stone. Pages with their own controls turn this off. */
  dropOnPress: { type: Boolean, default: true },
  /** Say nothing while the pond starts, or if it cannot. For a page that shows its own placeholder until `ready`. */
  silent: { type: Boolean, default: false },
})
const emit = defineEmits(['stats', 'ready'])

const host = ref(null)
const canvas = ref(null)
const status = ref('waking the pond')

const renderer = shallowRef(null)
const worker = shallowRef(null)

let governor = null
let raf = 0
let lastFrame = 0
let grid = { w: 0, h: 0, cellAspect: 1 }
let pending = [] // pointer samples awaiting the next flush
let lastPointer = null
let hasFrame = false
let bedTier = null
let resizeTimer = 0
let bedTimer = 0
let destroyed = false
let observer = null
let statsTimer = 0
let idling = false

/** Pointer position in grid cells. Grid row 0 is the bottom, matching the texture. */
function toGrid(clientX, clientY) {
  const r = canvas.value.getBoundingClientRect()
  return {
    x: ((clientX - r.left) / r.width) * grid.w,
    y: (1 - (clientY - r.top) / r.height) * grid.h,
  }
}

function queueSample(ev, down) {
  const p = toGrid(ev.clientX, ev.clientY)
  const dt = lastPointer ? Math.max((ev.timeStamp - lastPointer) / 1000, 1 / 1000) : 0
  lastPointer = ev.timeStamp
  pending.push({ x: p.x, y: p.y, dt, down })
}

function onPointerMove(ev) {
  if (!worker.value) return
  // Coalesced events are the whole game for fast flicks: without them a quick
  // swipe arrives as two far-apart points and the wake comes out as beads.
  const events = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev]
  for (const e of events) queueSample(e, ev.pressure > 0 || ev.buttons > 0)
}

function onPointerDown(ev) {
  if (!worker.value) return
  // Capture on the canvas, not on any wrapper: a parent that captured instead
  // would stop these events reaching the canvas at all, and the water would go
  // dead for the rest of the drag.
  canvas.value.setPointerCapture?.(ev.pointerId)
  lastPointer = ev.timeStamp
  if (!props.dropOnPress) return
  const p = toGrid(ev.clientX, ev.clientY)
  worker.value.postMessage({ type: 'drop', x: p.x, y: p.y })
}

function onPointerUp() {
  lastPointer = null
  worker.value?.postMessage({ type: 'release' })
}

function onPointerLeave() {
  lastPointer = null
  worker.value?.postMessage({ type: 'release' })
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
      hasFrame = false
      worker.value?.postMessage({ type: 'resize', w: g.w, h: g.h, aspect: g.cellAspect })
    }
  }
}

/** The bed is expensive to draw, so it is only redrawn when it must be. */
function buildBed(tier) {
  const el = host.value
  const cssW = el?.clientWidth || window.innerWidth
  const cssH = el?.clientHeight || window.innerHeight
  const long = TIERS[tier].bed
  const aspect = cssW / cssH
  const w = aspect >= 1 ? long : Math.round(long * aspect)
  const h = aspect >= 1 ? Math.round(long / aspect) : long
  const bed = generateBed({ width: w, height: h, seed: props.seed, density: TIERS[tier].density })
  renderer.value.setBed(bed)
  bedTier = tier
}

function onTierChange(tier) {
  if (destroyed || !renderer.value) return
  renderer.value.setTier(tier)
  applySize()
  // A tier change moves the bed's resolution too, but redrawing it mid-stroke
  // would hitch; it can wait for the next quiet moment.
  clearTimeout(bedTimer)
  bedTimer = setTimeout(() => {
    if (!destroyed && bedTier !== tier) buildBed(tier)
  }, 600)
}

function applyUiDepth() {
  renderer.value?.setUiDepth(props.uiDepth)
}

function frame(now) {
  raf = requestAnimationFrame(frame)
  if (lastFrame) governor.sample(now - lastFrame)
  lastFrame = now

  flushPointer()
  if (hasFrame) renderer.value.render(now / 1000, { depth: props.waterDepth })
}

function onMessage({ data }) {
  if (data.type === 'idle') {
    idling = data.idle
    return
  }
  if (data.type === 'frame') {
    const view = new Uint16Array(data.buffer)
    renderer.value.uploadFrame(view, data.w, data.h)
    hasFrame = true
    if (status.value) {
      status.value = ''
      emit('ready')
    }
    // Hand the buffer straight back so the worker always has one to fill.
    worker.value.postMessage({ type: 'recycle', buffer: data.buffer }, [data.buffer])
  }
}

function onVisibility() {
  const hidden = document.hidden
  worker.value?.postMessage({ type: 'pause', paused: hidden })
  if (hidden) {
    cancelAnimationFrame(raf)
    raf = 0
  } else if (!raf) {
    lastFrame = 0
    raf = requestAnimationFrame(frame)
  }
}

onMounted(async () => {
  governor = createGovernor(onTierChange)

  try {
    renderer.value = createRenderer(canvas.value)
  } catch (err) {
    status.value = err.message
    return
  }

  // Let the loading state paint before the bed generation blocks the thread.
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))
  status.value = 'growing the pond bed'
  await new Promise((r) => setTimeout(r, 0))

  renderer.value.setTier(governor.tier)
  applyUiDepth()
  buildBed(governor.tier)
  applySize({ regrid: false })
  grid = gridFor(governor.tier, host.value.clientWidth || 1, host.value.clientHeight || 1)

  const w = new WaterWorker()
  w.onmessage = onMessage
  w.postMessage({ type: 'init', wasmUrl, w: grid.w, h: grid.h, aspect: grid.cellAspect })
  w.postMessage({ type: 'breeze', value: props.breeze })
  worker.value = w

  observer = new ResizeObserver(() => {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => !destroyed && applySize(), 120)
  })
  observer.observe(host.value)

  document.addEventListener('visibilitychange', onVisibility)
  statsTimer = setInterval(() => {
    emit('stats', {
      fps: governor.fps,
      tier: governor.tier,
      auto: governor.auto,
      grid: `${grid.w}×${grid.h}`,
      cells: grid.w * grid.h,
      idle: idling,
    })
  }, 500)

  raf = requestAnimationFrame(frame)
})

onBeforeUnmount(() => {
  destroyed = true
  observer?.disconnect()
  document.removeEventListener('visibilitychange', onVisibility)
  clearInterval(statsTimer)
  clearTimeout(resizeTimer)
  clearTimeout(bedTimer)
  cancelAnimationFrame(raf)
  worker.value?.terminate()
  renderer.value?.dispose()
})

watch(() => props.breeze, (v) => worker.value?.postMessage({ type: 'breeze', value: v }))
watch(() => props.quality, (v) => governor?.setManual(v === 'auto' ? null : v))
watch(() => props.seed, () => {
  if (renderer.value) buildBed(governor.tier)
})

watch(() => props.uiDepth, applyUiDepth)

defineExpose({
  /** Disturb the water at a point in CSS pixels. */
  splash(clientX, clientY, { radius = 0.035, strength = 0.06 } = {}) {
    if (!worker.value) return
    const p = toGrid(clientX, clientY)
    worker.value.postMessage({ type: 'drop', x: p.x, y: p.y, radius, strength })
  },
  /** Publish the whole submerged interface layer. */
  setUiLayer(source) {
    renderer.value?.setUiLayer(source)
  },
  /** Replace one rectangle of it. */
  setUiRegion(image, x, y) {
    renderer.value?.setUiRegion(image, x, y)
  },
})
</script>

<template>
  <div ref="host" class="surface">
    <canvas
      ref="canvas"
      class="surface__canvas"
      @pointermove="onPointerMove"
      @pointerdown="onPointerDown"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @pointerleave="onPointerLeave"
    />
    <Transition name="fade">
      <p v-if="status && !silent" class="surface__status">{{ status }}</p>
    </Transition>
  </div>
</template>

<style scoped>
.surface {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: #11150f;
}

.surface__canvas {
  display: block;
  width: 100%;
  height: 100%;
  touch-action: none; /* the pointer belongs to the water, not to scrolling */
  /* A fingertip, with the hotspot on the tip — you are dipping a finger in,
     so the cursor should be the thing doing the dipping. */
  cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 34 34'%3E%3Cpath d='M10 6 a2 2 0 0 1 4 0 L14 14.4 L15.6 14.4 a1.9 1.9 0 0 1 3.8 0 L19.4 15.4 a1.85 1.85 0 0 1 3.7 0 L23.1 16.6 a1.75 1.75 0 0 1 3.5 0 L26.6 22.2 a7.6 7.6 0 0 1 -7.6 7.6 L17 29.8 c-4.3 0 -7 -2.8 -7 -7 Z' fill='%23eef3e8' fill-opacity='.92' stroke='%230d120c' stroke-opacity='.75' stroke-width='1.5' stroke-linejoin='round'/%3E%3C/svg%3E") 11 4, pointer;
}

.surface__status {
  position: absolute;
  inset: auto 0 2.5rem 0;
  margin: 0;
  text-align: center;
  font-size: 0.8125rem;
  letter-spacing: 0.14em;
  text-transform: lowercase;
  color: rgba(226, 236, 218, 0.5);
}

.fade-leave-active {
  transition: opacity 0.8s ease;
}
.fade-leave-to {
  opacity: 0;
}
</style>
