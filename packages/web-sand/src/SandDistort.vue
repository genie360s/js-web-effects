<script setup>
// Anything inside this feels the sand: text, components, images, video.
//
// The real element stays in the document and keeps its layout, its links and
// its screen-reader text; the surface makes it transparent once the GPU is
// actually drawing it, so a browser without WebGL2 shows the plain page.
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { isMedia } from './capture'

const props = defineProps({
  displace: { type: Number, default: undefined }, // px of slide down the slope
  warp: { type: Number, default: undefined },     // px of resting ripple bend
  shade: { type: Number, default: undefined },    // sand lighting on the content
  stain: { type: Number, default: undefined },    // turned sand discolouring it
  bury: { type: Number, default: undefined },     // piled height that hides it
  scrape: { type: Number, default: undefined },   // colour the stick lifts off it
  live: { type: Boolean, default: undefined },    // re-upload a canvas each frame
  capture: { type: Function, default: undefined }, // your own rasteriser
  disabled: { type: Boolean, default: false },
})

const engine = inject('sand', null)
const root = ref(null)
let handle = null

// Only the props that were actually set: the rest fall through to the surface.
const options = computed(() => {
  const out = {}
  for (const key of ['displace', 'warp', 'shade', 'stain', 'bury', 'scrape', 'live', 'capture']) {
    if (props[key] !== undefined) out[key] = props[key]
  }
  return out
})

// an <img> or <video> handed straight to the GPU beats rasterising a wrapper
// that only contains it
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
  <!-- The surface makes this transparent once it is drawing it, and puts it
       back if the layer goes away. Until then the ordinary page shows. -->
  <div ref="root" class="sand-distort">
    <slot />
  </div>
</template>

<style scoped>
/* no transition: the GPU copy has to take over on the same frame */
.sand-distort { display: block; }
</style>
