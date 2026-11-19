<script setup>
// Anything inside this can burn: text, components, images, video.
//
// The real element stays in the document and keeps its layout, its links, its
// focus and its screen-reader text; the engine makes it transparent once the
// GPU is actually drawing it, so a browser without WebGL2 shows the plain
// page. A form inside one stays a working form right up until it is ash.
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { isMedia } from '../ui/capture.js'

const props = defineProps({
  fuel: { type: Number, default: undefined },    // how combustible, 0 = fireproof
  haze: { type: Number, default: undefined },    // px of refraction through hot air
  scorch: { type: Number, default: undefined },  // how dark the char goes
  burn: { type: Number, default: undefined },    // damage at which it is gone
  glow: { type: Number, default: undefined },    // brightness of the burning edge
  invisible: { type: Boolean, default: undefined }, // fuel, but never drawn
  live: { type: Boolean, default: undefined },   // re-upload a canvas each frame
  capture: { type: Function, default: undefined }, // your own rasteriser
  disabled: { type: Boolean, default: false },
})

const engine = inject('fire', null)
const root = ref(null)
let handle = null

// Only the props that were actually set; the rest fall through to the engine.
const options = computed(() => {
  const out = {}
  for (const key of ['fuel', 'haze', 'scorch', 'burn', 'glow', 'invisible', 'live', 'capture']) {
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
  <div ref="root" class="fire-layer">
    <slot />
  </div>
</template>

<style scoped>
/* no transition: the GPU copy has to take over on the same frame */
.fire-layer { display: block; }
</style>
