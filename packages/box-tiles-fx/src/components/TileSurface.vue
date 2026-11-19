<script setup>
// The tiles. One canvas, one worker running the grid, sized to this element.
//
// With `fullscreen` it pins itself over the whole page and the content stays
// where it is in the document; drop `<TileLayer>` around anything that should
// be seen through the tiles. With a slot it fills its own box instead.
import { onBeforeUnmount, onMounted, provide, ref, shallowRef, watch } from 'vue'
import { createTiles } from '../engine.js'
// emitted as a hashed asset, so it resolves under whatever base the app ships on
import wasmUrl from '../sim/tiles-core.wasm?url'
import TileWorker from '../sim/tileWorker.js?worker'

// Two roots, so Vue will not pass a class or a style through on its own; they
// are bound onto the canvas box by hand instead.
defineOptions({ inheritAttrs: false })

const props = defineProps({
  // anything in DEFAULTS (engine.js) or in src/sim/params.js
  options: { type: Object, default: () => ({}) },
  fullscreen: { type: Boolean, default: true },
})
const emit = defineEmits(['ready', 'error', 'quality'])

const root = ref(null)
const failed = ref('')
const engine = shallowRef(null)
let gone = false
// TileLayer children wait on this
provide('tiles', engine)

function onQuality(event) {
  emit('quality', event.detail)
}

onMounted(async () => {
  try {
    root.value.addEventListener('tiles:quality', onQuality)
    const created = await createTiles(root.value, {
      wasm: wasmUrl,
      worker: () => new TileWorker(),
      ...props.options,
    })
    // The component can be torn down while the wasm is still arriving; an
    // engine built after that would keep its listeners and loop forever.
    if (gone) {
      created.destroy()
      return
    }
    engine.value = created
    emit('ready', created)
  } catch (err) {
    // no WebGL2, no wasm: the page keeps working, it just will not tile
    failed.value = err?.message || String(err)
    emit('error', err)
  }
})

watch(() => props.options, (next) => engine.value?.setParams(next), { deep: true })
onBeforeUnmount(() => {
  gone = true
  root.value?.removeEventListener('tiles:quality', onQuality)
  engine.value?.destroy()
  engine.value = null
})

defineExpose({
  engine,
  reset: () => engine.value?.reset(),
  pulse: (spot) => engine.value?.pulse(spot),
  beat: (strength) => engine.value?.beat(strength),
  drive: (level) => engine.value?.drive(level),
  reseed: (seed) => engine.value?.reseed(seed),
  setParams: (patch) => engine.value?.setParams(patch),
  setQuality: (tier) => engine.value?.setQuality(tier),
})
</script>

<template>
  <!-- Two roots on purpose: when the surface is fullscreen the canvas is
       pinned over the page while the slot stays in normal flow, and
       <TileLayer> inside the slot is still a descendant, so it can find this
       engine. -->
  <div ref="root" v-bind="$attrs" class="tile-surface" :class="{ 'is-fullscreen': fullscreen }">
    <slot v-if="!fullscreen" />
    <p v-if="failed" class="tile-error" role="status">{{ failed }}</p>
  </div>
  <slot v-if="fullscreen" />
</template>

<style scoped>
.tile-surface { position: relative; }
/* Over the page, not behind it: the layers are drawn into the canvas and the
   real elements under it are made transparent. */
.is-fullscreen { position: fixed; inset: 0; z-index: 2; pointer-events: none; }
.tile-error {
  position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%);
  margin: 0; padding: 8px 12px; border-radius: 4px;
  font: 600 11px/1.4 system-ui, sans-serif; letter-spacing: .08em;
  color: #e8eef8; background: rgba(4, 8, 20, .82);
}
</style>
