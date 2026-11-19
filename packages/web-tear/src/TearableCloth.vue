<script setup>
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { createRenderer } from './gl'
import { FLOOR_COLOR, rasterize } from './layers'
import ClothWorker from './cloth.worker.js?worker'
// emitted as a hashed asset, so it resolves under whatever base the app ships on
import wasmUrl from './cloth.wasm?url'

// Sheets are this far apart in depth so a deep wrinkle in one cannot poke
// through the page beneath it.
const SHEET_GAP = 90
const SHADOW_STRENGTH = 0.28 // how dark a sheet's shadow falls on the page below
const SHADOW_OFFSET = 7 // px, away from the light

// The stack of pages to hang, front to back: `{ name, css, html(w, h, scale) }`
// each, as in layers.js. Required, so the component never drags the demo's own
// pages (and their media) into someone else's bundle.
const props = defineProps({
  layers: { type: Array, required: true },
  // the colour behind every sheet; a different stack can want a different one
  floor: { type: String, default: FLOOR_COLOR },
})

const emit = defineEmits(['sheets', 'firsttear', 'activate'])

const layers = props.layers
const canvas = ref(null)
const failed = ref('')
const holding = ref(false)

let renderer = null
let worker = null
let textures = []
let media = [] // video regions that need pushing into their sheet each frame
let meshes = [] // by layer index; index 0 is the page on top
let raf = 0
let resizeTimer = 0
let torn = false
let tick = 0
const pointers = new Set()
// Interactive widgets that live in the DOM on top of the paper. They hover and
// click like any other control; they disappear when their paper is torn away.
const widgets = ref([])
const widgetState = reactive({})
const standing = ref(new Set())
const paperBySheet = new Map() // sheet index -> probe ids that still have paper

// A widget shows while its own paper is there and nothing above still covers it.
function recomputeStanding() {
  const next = new Set()
  for (const c of widgets.value) {
    const own = paperBySheet.get(c.sheet)
    if (own && !own.has(c.id)) continue
    let covered = false
    for (let above = 0; above < c.sheet; above++) {
      if (paperBySheet.get(above)?.has(c.id)) { covered = true; break }
    }
    if (!covered) next.add(c.id)
  }
  const now = standing.value
  if (next.size === now.size && [...next].every((id) => now.has(id))) return
  standing.value = next
}
const size = { w: 0, h: 0, dpr: 1, radius: 40, pinch: 14, spacing: 8, tier: 'high' }
const stats = new Map()
const floor = hexToRgb(props.floor)

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16)
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
}

// What this machine can be asked for. Cores and memory are hints, not
// promises, so they only pick the starting point - the worker measures its own
// step cost and trims the solver from there.
function deviceTier() {
  const cores = navigator.hardwareConcurrency || 4
  const memory = navigator.deviceMemory || 4
  if (cores >= 8 && memory >= 8) return { name: 'high', divisor: 128, dpr: 2 }
  if (cores >= 4 && memory >= 4) return { name: 'medium', divisor: 104, dpr: 2 }
  return { name: 'low', divisor: 78, dpr: 1.5 }
}

function measure() {
  const el = canvas.value
  const tier = deviceTier()
  size.tier = tier.name
  // a collapsed or hidden container would otherwise give a zero-sized sheet,
  // and every rest length and UV in it would be NaN
  size.w = Math.max(1, el.clientWidth)
  size.h = Math.max(1, el.clientHeight)
  size.dpr = Math.min(window.devicePixelRatio || 1, tier.dpr)
  size.radius = Math.max(42, Math.min(size.w, size.h) * 0.075) // where we look for paper
  // A pinch, not a fistful. A wide rigid grip strains its whole perimeter at
  // once and punches a disc out; a small one starts a slit that follows you.
  size.pinch = Math.max(10, Math.min(size.w, size.h) * 0.022)
  // Fine enough that a rip reads as torn paper rather than as the mesh, and
  // coarse enough that a loaded sheet still steps at 60 Hz in the worker: a
  // pull wakes most of the page, which is the whole point of it.
  size.spacing = Math.min(14, Math.max(4.5, Math.min(size.w, size.h) / tier.divisor))
}

let building = 0 // generation token: only the newest build may publish

async function build() {
  const generation = ++building
  measure()
  renderer.resize(size.w, size.h, size.dpr)

  releaseMedia()
  const rasterised = await Promise.all(layers.map((l) => rasterize(l, size.w, size.h, size.dpr)))
  if (generation !== building) {
    // a newer build started while this one was decoding: drop what we made
    // rather than deleting the newer build's textures out from under it
    for (const r of rasterised) {
      for (const v of r.videos) { v.video.pause(); v.video.removeAttribute('src'); v.video.load() }
    }
    return
  }
  textures.forEach((t) => renderer.deleteTexture(t))
  textures = rasterised.map((r) => renderer.createTexture(r.source, r.videos.length > 0))
  // live media, kept per layer, with a scratch canvas sized to its rectangle
  media = rasterised.map((r, idx) =>
    r.videos.map((v) => {
      const scratch = document.createElement('canvas')
      scratch.width = v.w
      scratch.height = v.h
      return { ...v, layer: idx, scratch }
    }),
  ).flat()

  meshes.forEach((m) => m && m.dispose())
  meshes = []
  stats.clear()

  const scale = Math.min(size.w, size.h) / 820
  widgets.value = layers.flatMap((layer, sheet) =>
    (layer.components ? layer.components(size.w, size.h, scale) : []).map((c) => ({ ...c, sheet })),
  )
  for (const c of widgets.value) {
    if (widgetState[c.id] === undefined) widgetState[c.id] = !!c.on
  }
  paperBySheet.clear()
  recomputeStanding()
  report()
}

// A widget stands while there is paper under its middle.
function probePoints() {
  return widgets.value.map((c) => ({
    id: c.id, sheet: c.sheet, x: c.x + c.w / 2, y: c.y + c.h / 2, r: 10,
  }))
}

// Videos keep decoding until they are told not to, so every path that drops
// them - a rebuild, or the component going away - has to go through here.
function releaseMedia() {
  for (const m of media) {
    m.video.pause()
    m.video.removeAttribute('src')
    m.video.load()
  }
  media = []
}

function report() {
  // Count the tearable pages wherever they sit in the stack: a stack may put an
  // untearable page anywhere, not only at the back.
  let total = 0
  let remaining = 0
  let name = layers[layers.length - 1].name
  let top = true
  for (let i = 0; i < layers.length; i++) {
    if (layers[i].tearable === false) continue
    total++
    const s = stats.get(i)
    if ((s ? s.coverage : 1) > 0.06) {
      remaining++
      if (top) { name = layers[i].name; top = false }
    }
  }
  emit('sheets', { remaining, total, name })
}

function onWorkerMessage(e) {
  const m = e.data
  if (m.type === 'failed') { failed.value = m.reason; return }
  if (m.type === 'sheet') {
    const idx = m.sheet
    if (meshes[idx]) meshes[idx].dispose()
    meshes[idx] = renderer.createMesh(m.nodes, m.uv)
    return
  }
  if (m.type !== 'frame') return
  const mesh = meshes[m.sheet]
  if (mesh) {
    renderer.uploadVerts(mesh, m.verts)
    if (m.indices) renderer.uploadIndices(mesh, m.indices)
  }
  if (m.paper) {
    paperBySheet.set(m.sheet, new Set(m.paper))
    recomputeStanding()
  }
  if (!mesh) {
    // rebuilt out from under this frame: give the buffer back regardless, or
    // the worker runs out of them and stops posting
    worker.postMessage({ type: 'recycle', verts: m.verts }, [m.verts.buffer])
    return
  }
  stats.set(m.sheet, {
    coverage: m.coverage,
    awake: m.awake,
    stepMs: m.stepMs,
    copyMs: m.copyMs,
    pool: m.pool,
    iterations: m.iterations,
    intact: m.intact,
    dropped: m.dropped,
  })
  worker.postMessage({ type: 'recycle', verts: m.verts }, [m.verts.buffer])
}

let renderMs = 0 // what the page itself spends per frame, vsync aside

function frame() {
  raf = requestAnimationFrame(frame)
  const t0 = performance.now()
  if (++tick % 20 === 0) report() // coverage keeps changing as shreds sag away

  // A playing video is part of the paper: push its new frame into that sheet's
  // texture, but only while there is still paper there to show it on.
  for (const m of media) {
    const s = stats.get(m.layer)
    if (s && s.intact !== undefined && s.intact < 0.02) continue
    renderer.updateTextureRegion(textures[m.layer], m, m.scratch)
  }

  renderer.begin(floor[0], floor[1], floor[2])
  // fibre scale, not mesh scale: ~6 px per lump, so the fringe stays organic
  // whatever density the sheet runs at
  const grain = [size.w / 6, size.h / 6]
  for (let i = meshes.length - 1; i >= 0; i--) { // deepest first
    if (!meshes[i]) continue
    // its shadow lands on everything already drawn, then the sheet itself
    renderer.drawShadow(meshes[i], i * SHEET_GAP + SHEET_GAP * 0.75, grain, SHADOW_STRENGTH, SHADOW_OFFSET)
    renderer.drawCloth(meshes[i], textures[i], i * SHEET_GAP, grain)
  }
  renderMs = renderMs * 0.9 + (performance.now() - t0) * 0.1
}

function localPoint(e) {
  const r = canvas.value.getBoundingClientRect()
  return [e.clientX - r.left, e.clientY - r.top]
}

// Pressing a widget must still be able to tear: we hand the gesture to the
// cloth immediately and only count it as a click if the pointer never moved.
let pressed = null

function onWidgetDown(widget, e) {
  pressed = { id: widget.id, x: e.clientX, y: e.clientY }
  e.currentTarget.setPointerCapture(e.pointerId)
  onDown(e, false)
}

function onWidgetUp(widget, e) {
  const p = pressed
  pressed = null
  onUp(e)
  if (!p || p.id !== widget.id) return
  if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 6) return // that was a tear
  if (widget.kind === 'toggle') widgetState[widget.id] = !widgetState[widget.id]
  emit('activate', widget.id)
}

function onDown(e, capture = true) {
  const [x, y] = localPoint(e)
  // Capturing on the canvas would retarget every later event for this pointer,
  // and a widget's own pointerup would never arrive - so it never clicks.
  if (capture) canvas.value.setPointerCapture(e.pointerId)
  pointers.add(e.pointerId)
  holding.value = true
  worker.postMessage({ type: 'down', id: e.pointerId, x, y })
  if (!torn) { torn = true; emit('firsttear') }
}

function onMove(e) {
  if (!pointers.has(e.pointerId)) return
  // coalesced moves keep the pull smooth on high-rate pointers
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e]
  const points = []
  for (const ev of events) points.push(...localPoint(ev))
  worker.postMessage({ type: 'move', id: e.pointerId, points })
}

function onUp(e) {
  if (!pointers.delete(e.pointerId)) return
  holding.value = pointers.size > 0
  worker.postMessage({ type: 'up', id: e.pointerId })
}

function onResize() {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(async () => {
    if (!renderer) return
    await build()
    worker.postMessage({
      type: 'resize', width: size.w, height: size.h,
      spacing: size.spacing, radius: size.radius, pinch: size.pinch,
    })
    worker.postMessage({ type: 'probes', probes: probePoints() })
  }, 250)
}

function onVisibility() {
  if (document.hidden) {
    cancelAnimationFrame(raf)
    raf = 0
    worker.postMessage({ type: 'stop' })
  } else if (!raf) {
    worker.postMessage({ type: 'start' })
    raf = requestAnimationFrame(frame)
  }
}

function reset() {
  if (!worker) return // startup failed; there is nothing to reset
  torn = false
  stats.clear()
  worker.postMessage({ type: 'reset' })
}

onMounted(async () => {
  try {
    renderer = createRenderer(canvas.value)
    await build()
    const wasm = await fetch(wasmUrl).then((r) => r.arrayBuffer())
    worker = new ClothWorker()
    worker.onmessage = onWorkerMessage
    worker.postMessage({
      type: 'init', wasm, width: size.w, height: size.h,
      spacing: size.spacing, radius: size.radius, pinch: size.pinch,
      // every layer is a sheet; the last one declares itself untearable
      layers: layers.map((l, i) => ({ index: i, tearable: l.tearable !== false })),
      probes: probePoints(),
    }, [wasm])
  } catch (err) {
    failed.value = err.message || String(err)
    return
  }
  raf = requestAnimationFrame(frame)
  window.addEventListener('resize', onResize)
  document.addEventListener('visibilitychange', onVisibility)
  if (import.meta.env.DEV) {
    window.__tearDebug = () => ({
      sheets: [...stats.entries()].map(([idx, s]) => ({ idx, ...s })),
      renderMs: +renderMs.toFixed(2),
      tier: size.tier,
      spacing: +size.spacing.toFixed(1),
    })
  }
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  clearTimeout(resizeTimer)
  window.removeEventListener('resize', onResize)
  document.removeEventListener('visibilitychange', onVisibility)
  if (worker) worker.terminate()
  releaseMedia()
  textures.forEach((tex) => renderer && renderer.deleteTexture(tex))
  meshes.forEach((m) => m && m.dispose())
})

defineExpose({ reset })
</script>

<template>
  <div class="stage">
    <canvas
      ref="canvas"
      class="sheet"
      :class="{ holding }"
      @pointerdown.prevent="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
      @contextmenu.prevent
    ></canvas>
    <div class="widgets">
      <template v-for="widget in widgets" :key="widget.id">
        <button
          v-if="standing.has(widget.id) && widget.kind === 'button'"
          class="widget button"
          :style="{ left: widget.x + 'px', top: widget.y + 'px', width: widget.w + 'px', height: widget.h + 'px' }"
          @pointerdown.stop="onWidgetDown(widget, $event)"
          @pointermove.stop="onMove"
          @pointerup.stop="onWidgetUp(widget, $event)"
          @pointercancel.stop="onUp"
        >
          {{ widget.label }}
        </button>
        <div
          v-else-if="standing.has(widget.id) && widget.kind === 'toggle'"
          class="widget row"
          :style="{ left: widget.x + 'px', top: widget.y + 'px', width: widget.w + 'px', height: widget.h + 'px' }"
          @pointerdown.stop="onWidgetDown(widget, $event)"
          @pointermove.stop="onMove"
          @pointerup.stop="onWidgetUp(widget, $event)"
          @pointercancel.stop="onUp"
        >
          <span class="widget-label">{{ widget.label }}</span>
          <span class="switch" :class="{ on: widgetState[widget.id] }"><i></i></span>
        </div>
      </template>
    </div>
    <p v-if="failed" class="failed">{{ failed }}</p>
  </div>
</template>

<style scoped>
.stage { position: absolute; inset: 0; }
.sheet {
  display: block;
  width: 100%;
  height: 100%;
  touch-action: none;
  cursor: grab;
}
.sheet.holding { cursor: grabbing; }
.widgets { position: absolute; inset: 0; pointer-events: none; }
.widget {
  position: absolute;
  pointer-events: auto;
  font: 600 14px/1 '42dot Sans', system-ui, sans-serif;
  touch-action: none;
  transition: transform .12s ease, background .12s ease, color .12s ease;
}
.widget.button {
  display: grid; place-items: center;
  border: none; border-radius: 4px;
  background: #0b0b0b; color: #f2f2f0; cursor: pointer;
}
.widget.button:hover { background: #2e2e2e; transform: translateY(-1px); }
.widget.button:active { transform: translateY(1px); }
.widget.row {
  display: flex; align-items: center; justify-content: space-between;
  cursor: pointer; color: #6f6f6f;
}
.widget.row:hover .widget-label { color: #0b0b0b; }
.widget-label { font-weight: 500; transition: color .12s ease; }
.switch {
  position: relative; width: 44px; height: 24px; border-radius: 4px;
  background: #d8d8d6; transition: background .15s ease;
}
.switch.on { background: #0b0b0b; }
.switch > i {
  position: absolute; top: 3px; left: 3px; width: 18px; height: 18px;
  background: #f2f2f0; border-radius: 2px; transition: left .15s ease;
}
.switch.on > i { left: 23px; }
.failed {
  position: absolute; inset: 0; display: grid; place-content: center;
  font: 500 15px/1.5 system-ui, sans-serif; color: #f2f2f0; text-align: center; padding: 24px;
}
</style>
