<script setup>
// Anything inside this arrives through the glitch: an image, a video, text,
// a whole component.
//
// The real element stays in the document and keeps its layout, its links, its
// focus and its screen-reader text; the engine makes it transparent while the
// GPU is drawing it, and hands it back once the picture is whole and still.
// A browser without WebGL2 shows the plain page.
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { createGlitch } from '../engine.js'
import { isMedia } from '../ui/capture.js'
// emitted as a hashed asset, so it resolves under whatever base the app ships on
import wasmUrl from '../sim/glitch-core.wasm?url'

const props = defineProps({
  // anything in DEFAULTS (engine.js) or in src/sim/params.js
  options: { type: Object, default: () => ({}) },
  // whether the content should be there; it arrives and leaves at `speed`
  visible: { type: Boolean, default: true },
})
const emit = defineEmits(['ready', 'error'])

const content = ref(null)
const failed = ref('')
const engine = shallowRef(null)
let gone = false

// An <img> or <video> handed straight to the GPU beats rasterising a wrapper
// that only contains it.
function target() {
  const el = content.value
  const only = el.children.length === 1 ? el.firstElementChild : null
  return only && isMedia(only) ? only : el
}

onMounted(async () => {
  try {
    const created = await createGlitch(target(), { wasm: wasmUrl, ...props.options, visible: props.visible })
    // The component can be torn down while the wasm is still arriving; an
    // engine built after that would keep its listeners forever.
    if (gone) {
      created.destroy()
      return
    }
    engine.value = created
    emit('ready', created)
  } catch (err) {
    // no WebGL2, no wasm: the page keeps working, it just will not glitch
    failed.value = err?.message || String(err)
    emit('error', err)
  }
})

watch(() => props.options, (next) => engine.value?.setParams(next), { deep: true })
watch(() => props.visible, (next) => engine.value?.reveal(next ? 1 : 0))
onBeforeUnmount(() => {
  gone = true
  engine.value?.destroy()
  engine.value = null
})

defineExpose({
  engine,
  reveal: (amount) => engine.value?.reveal(amount),
  hide: () => engine.value?.hide(),
  burst: (strength) => engine.value?.burst(strength),
  pulse: (spot) => engine.value?.pulse(spot),
  reseed: (seed) => engine.value?.reseed(seed),
  update: () => engine.value?.update(),
  setParams: (patch) => engine.value?.setParams(patch),
})
</script>

<template>
  <!-- Positioned, so the engine's canvas has something to sit against. -->
  <div class="glitch-surface" :data-glitch-error="failed || undefined">
    <div ref="content" class="glitch-content"><slot /></div>
  </div>
</template>

<style scoped>
.glitch-surface { position: relative; display: block; }
.glitch-content { display: block; }
</style>
