<script setup>
// The beach. One canvas, one wasm field, sized to this element.
//
// With `fullscreen` it pins itself behind the whole page and the content stays
// where it is in the document; drop `<SandDistort>` around anything that should
// feel the sand. With a slot it fills its own box instead.
import { onBeforeUnmount, onMounted, provide, ref, shallowRef, watch } from 'vue'
import { createSand } from './engine'
// emitted as a hashed asset, so it resolves under whatever base the app ships on
import wasmUrl from './sand.wasm?url'

// This component has two roots, so Vue will not pass a class or a style
// through on its own; they are bound onto the canvas box by hand instead.
defineOptions({ inheritAttrs: false })

const props = defineProps({
  // anything in DEFAULTS (engine.js), passed straight through
  options: { type: Object, default: () => ({}) },
  fullscreen: { type: Boolean, default: true },
})
const emit = defineEmits(['ready', 'error'])

const root = ref(null)
const failed = ref('')
const engine = shallowRef(null)
let gone = false
// SandDistort children wait on this
provide('sand', engine)

onMounted(async () => {
  try {
    const created = await createSand(root.value, { wasm: wasmUrl, ...props.options })
    // The component can be torn down while the wasm is still arriving; an
    // engine built after that would keep its listeners and loop forever.
    if (gone) {
      created.destroy()
      return
    }
    engine.value = created
    emit('ready', created)
  } catch (err) {
    // no WebGL2, no wasm: the page keeps working, it just has no sand
    failed.value = err?.message || String(err)
    emit('error', err)
  }
})

watch(() => props.options, (next) => engine.value?.setParams(next), { deep: true })
onBeforeUnmount(() => {
  gone = true
  engine.value?.destroy()
  engine.value = null
})

defineExpose({
  engine,
  reset: () => engine.value?.reset(),
  setParams: (patch) => engine.value?.setParams(patch),
})
</script>

<template>
  <!-- Two roots on purpose: when the sand is fullscreen the canvas is pinned
       behind the page while the slot stays in normal flow, and <SandDistort>
       inside the slot is still a descendant, so it can find this engine. -->
  <div ref="root" v-bind="$attrs" class="sand-surface" :class="{ 'is-fullscreen': fullscreen }">
    <slot v-if="!fullscreen" />
    <p v-if="failed" class="sand-error" role="status">{{ failed }}</p>
  </div>
  <slot v-if="fullscreen" />
</template>

<style scoped>
.sand-surface { position: relative; }
.is-fullscreen { position: fixed; inset: 0; z-index: 0; }
.sand-error {
  position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%);
  margin: 0; padding: 8px 12px; border-radius: 4px;
  font: 600 11px/1.4 system-ui, sans-serif; letter-spacing: .08em;
  color: #f2f2f0; background: rgba(11, 11, 11, .82);
}
</style>
