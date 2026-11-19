<script setup>
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import WaterSurface from '../components/WaterSurface.vue'
import { createScene } from '../ui/scene'
import { paintScene } from '../ui/paint'

/** How deep the controls sit. Sets how much the ripples bend them. */
const UI_DEPTH = 0.075
/** The interface layer is drawn at most this dense; it is read through water. */
const MAX_DPR = 2

const surface = ref(null)
const host = ref(null)
const scene = shallowRef(createScene())

const breeze = ref(1)
const depth = ref(0.14)
const seed = ref(11)

let canvas = null
let ctx = null
let dpr = 1
let dragging = null
let ro = null

function repaint(clip) {
  if (!ctx) return
  paintScene(ctx, scene.value, dpr, clip)
  if (clip) {
    // Only the touched strip goes back to the GPU. Re-uploading the whole
    // screen for a slider drag would cost more than the rest of the frame.
    const x = Math.max(0, Math.floor(clip.x * dpr))
    const y = Math.max(0, Math.floor(clip.y * dpr))
    const w = Math.min(canvas.width - x, Math.ceil(clip.w * dpr))
    const h = Math.min(canvas.height - y, Math.ceil(clip.h * dpr))
    if (w > 0 && h > 0) surface.value?.setUiRegion(ctx.getImageData(x, y, w, h), x, y)
  } else {
    surface.value?.setUiLayer(canvas)
  }
}

function relayout() {
  const el = host.value
  if (!el || !canvas) return
  const vw = el.clientWidth || 1
  const vh = el.clientHeight || 1
  dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
  canvas.width = Math.round(vw * dpr)
  canvas.height = Math.round(vh * dpr)
  scene.value.layout(vw, vh)
  repaint()
}

/** Pointer position in CSS pixels relative to the surface. */
function local(ev) {
  const r = host.value.getBoundingClientRect()
  return { x: ev.clientX - r.left, y: ev.clientY - r.top }
}

/** Widgets nudge the water when they are used, so the interface is *in* it. */
function poke(ev, strength, radius) {
  surface.value?.splash(ev.clientX, ev.clientY, { strength, radius })
}

function onMove(ev) {
  const p = local(ev)
  const s = scene.value

  if (dragging) {
    if (dragging.type === 'slider') {
      const before = dragging.value
      dragging.value = s.valueAt(dragging, p.x)
      if (dragging.value !== before) {
        commit(dragging)
        repaint(s.damage(dragging))
        // A dragged control drags the water with it.
        poke(ev, 0.008, 0.01)
      }
    }
    return
  }

  const hit = s.hitTest(p.x, p.y)
  if (hit !== s.hover) {
    const was = s.hover
    s.hover = hit
    if (was) repaint(s.damage(was))
    if (hit) repaint(s.damage(hit))
  }
}

function onDown(ev) {
  const p = local(ev)
  const s = scene.value
  const hit = s.hitTest(p.x, p.y)
  if (!hit) {
    // Open water: the press is a stone, as it is on the pond page.
    surface.value?.splash(ev.clientX, ev.clientY, { strength: 0.06, radius: 0.035 })
    return
  }

  // The canvas has already taken pointer capture, and it is this element's only
  // child, so these events keep bubbling here for the whole drag.
  s.active = hit
  dragging = hit.type === 'slider' ? hit : null

  if (hit.type === 'slider') {
    hit.value = s.valueAt(hit, p.x)
    commit(hit)
  }
  repaint(s.damage(hit))
  poke(ev, 0.022, 0.016)
}

function onUp(ev) {
  const s = scene.value
  const hit = s.active
  dragging = null
  s.active = null
  if (!hit) return

  const p = local(ev)
  const box = s.hitBox(hit)
  const inside = p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h

  if (inside) {
    if (hit.type === 'toggle') {
      hit.value = !hit.value
      commit(hit)
    } else if (hit.type === 'button') {
      activate(hit, ev)
    }
  }
  repaint(s.damage(hit))
}

/** Push the whole control state at the water, so no control can contradict
 *  another — dragging breeze while chop is off used to switch chop back on. */
function commit() {
  const s = scene.value
  breeze.value = s.byId.chop.value ? s.byId.breeze.value : 0
  depth.value = s.byId.depth.value
}

function activate(wgt, ev) {
  if (wgt.id === 'stone') {
    // Drop it into open water, not onto the panel.
    const r = host.value.getBoundingClientRect()
    surface.value?.splash(r.left + r.width * 0.5, r.top + r.height * 0.82, { strength: 0.5, radius: 0.04 })
  } else if (wgt.id === 'bed') {
    seed.value = Math.floor(Math.random() * 1e9)
    poke(ev, 0.06, 0.025)
  }
}

onMounted(async () => {
  canvas = document.createElement('canvas')
  // The layer is read back in strips on every drag, which this hints for.
  ctx = canvas.getContext('2d', { willReadFrequently: true })

  // Text is most of this interface; painting before the face loads would bake
  // a fallback into the texture and never correct it.
  try {
    await document.fonts.load('400 14px "42dot Sans"')
    await document.fonts.load('300 25px "42dot Sans"')
    await document.fonts.ready
  } catch {
    // A missing font service is not a reason to show nothing.
  }
  relayout()

  ro = new ResizeObserver(() => relayout())
  ro.observe(host.value)
})

onBeforeUnmount(() => {
  ro?.disconnect()
  surface.value?.setUiLayer(null)
})
</script>

<template>
  <div
    ref="host"
    class="page"
    @pointermove="onMove"
    @pointerdown="onDown"
    @pointerup="onUp"
    @pointercancel="onUp"
  >
    <WaterSurface
      ref="surface"
      :breeze="breeze"
      :seed="seed"
      :ui-depth="UI_DEPTH"
      :water-depth="depth"
      :drop-on-press="false"
      quality="auto"
    />
  </div>
</template>

<style scoped>
.page {
  position: absolute;
  inset: 0;
}
</style>
