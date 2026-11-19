<script setup>
// Anything inside this is seen through the tiles: text, components, images,
// video.
//
// The real element stays in the document and keeps its layout, its links, its
// focus and its screen-reader text; the engine makes it transparent once the
// GPU is actually drawing it, so a browser without WebGL2 shows the plain
// page. A form inside one stays a working form.
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { isMedia } from '../ui/capture.js'

const props = defineProps({
  reveal: { type: Number, default: undefined },      // 0..1, tile by tile
  revealSoft: { type: Number, default: undefined },  // softness of the reveal edge
  sweep: { type: Number, default: undefined },       // 0 lottery, 1 left-to-right wipe
  tiles: { type: Boolean, default: undefined },      // false draws it flat
  live: { type: Boolean, default: undefined },       // re-upload a canvas each frame
  capture: { type: Function, default: undefined },   // your own rasteriser
  disabled: { type: Boolean, default: false },
})

const engine = inject('tiles', null)
const root = ref(null)
let handle = null

// Only the props that were actually set; the rest fall through to the engine.
const options = computed(() => {
  const out = {}
  for (const key of ['reveal', 'revealSoft', 'sweep', 'tiles', 'live', 'capture']) {
    if (props[key] !== undefined) out[key] = props[key]
  }
  return out
})

// An <img> or <video> handed straight to the GPU beats rasterising a wrapper
// that only contains it.
function target() {
  const el = root.value
  if (!el) return null
  const only = el.children.length === 1 ? el.firstElementChild : null
  return only && isMedia(only) ? only : el
}

function attach() {
  if (handle || props.disabled || !engine?.value || !root.value) return
  handle = engine.value.addLayer(target(), options.value)
}

function detach() {
  handle?.destroy()
  handle = null
}

onMounted(attach)
watch(() => [engine?.value, props.disabled], () => { detach(); attach() })
watch(options, (next) => handle?.setOptions(next))
onBeforeUnmount(detach)

defineExpose({ update: () => handle?.update() })
</script>

<template>
  <!-- The engine makes this transparent once it is drawing it, and puts it
       back if the layer goes away. Until then the ordinary page shows. -->
  <div ref="root" class="tile-layer">
    <slot />
  </div>
</template>

<style scoped>
/* no transition: the GPU copy has to take over on the same frame */
.tile-layer { display: block; }
</style>
