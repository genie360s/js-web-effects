<script setup>
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import OilCanvas from './OilCanvas.vue'
import { drawPlaque } from '../ui/paint'

/**
 * A canvas of wet oil paint, with ordinary HTML laid over it.
 *
 * Anything in the slot marked `v-oil` (or `data-oil`) has its surface laid into
 * the paint: a slab of the pigment it asked for, combed with bristle furrows.
 * It is not composited on top — it goes into the pigment field, so from that
 * moment it *is* paint. Drag across a card and its colour smears off it and
 * mixes with the canvas, subtractively, like the rest of the picture.
 *
 * The element itself keeps no background of its own, and keeps everything the
 * DOM is good at: focus order, keyboard, screen readers, selectable text, and
 * event routing, so working a control cannot also leave a stroke.
 */
const props = defineProps({
  quality: { type: String, default: 'auto' },
  wetness: { type: Number, default: 1 },
  brushSize: { type: Number, default: 0.055 },
  color: { type: Array, default: null },
  seed: { type: Number, default: 7 },
  /** Start on bare linen instead of a seeded painting, so the only paint on the
   *  canvas is whatever the components put there. */
  bare: { type: Boolean, default: false },
  /** Paint thickness a fully opaque pixel of a component is worth. */
  amount: { type: Number, default: 2.8 },
})
defineEmits(['stats'])

const host = ref(null)
const content = ref(null)
const surface = shallowRef(null)

let pending = 0
let boxes = null
let tree = null
/** Exactly the elements `boxes` is watching, in order. */
let watched = []
/** One stable wobble per element, so a slab does not re-roll when re-laid. */
const seeds = new WeakMap()
let nextSeed = 11
/** Where each element was last laid, so an unchanged one is not laid twice. */
const placed = new WeakMap()

function seedFor(el) {
  if (!seeds.has(el)) {
    seeds.set(el, nextSeed)
    nextSeed += 37
  }
  return seeds.get(el)
}

/** Lay every marked element that has moved since it was last laid. */
function lay() {
  pending = 0
  if (!host.value || !content.value || !surface.value) return
  const origin = host.value.getBoundingClientRect()
  const nodes = [...content.value.querySelectorAll('[data-oil]')]

  // Only re-target when the set of elements has actually changed. A newly
  // observed target is reported on the next frame whether or not it moved, so
  // re-observing on every pass — even reusing the same observer — is a loop
  // that re-lays the whole interface at display rate and never settles.
  if (boxes && (watched.length !== nodes.length || watched.some((n, i) => n !== nodes[i]))) {
    boxes.disconnect()
    for (const n of nodes) boxes.observe(n)
    watched = nodes
  }

  for (const node of nodes) {
    const r = node.getBoundingClientRect()
    if (!r.width || !r.height) continue
    const pad = Number(node.dataset.oilPad ?? 0)
    const rect = {
      x: r.left - origin.left - pad,
      y: r.top - origin.top - pad,
      w: r.width + pad * 2,
      h: r.height + pad * 2,
    }
    const key = `${node.dataset.oil}|${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.w)},${Math.round(rect.h)}`
    if (placed.get(node) === key) continue
    const seed = seedFor(node)
    const laid = surface.value.stamp(
      rect,
      (ctx, w, h, where) => drawPlaque(ctx, where, node.dataset.oil, seed),
      props.amount,
    )
    // Only remembered once the paint was actually accepted, so an element the
    // canvas was not ready for is tried again rather than silently skipped.
    if (laid) placed.set(node, key)
  }
}

/** Coalesce to one pass a frame: observers fire these in bursts. */
function schedule() {
  if (pending) return
  pending = requestAnimationFrame(lay)
}

/** Lay everything again, whatever it did last time.
 *
 *  On a bare canvas the components are the only paint there is, so their
 *  smeared remains are scraped off first — otherwise every re-lay stacks a
 *  fresh card on top of the ghost of the last one. On a canvas that already
 *  holds a painting there is nothing here that would be safe to scrape. */
function relay() {
  if (props.bare) surface.value?.clear()
  for (const node of content.value?.querySelectorAll('[data-oil]') ?? []) placed.delete(node)
  schedule()
}

onMounted(async () => {
  boxes = new ResizeObserver(schedule)
  tree = new MutationObserver(schedule)
  tree.observe(content.value, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-oil', 'data-oil-pad'],
  })
  schedule()
  // Web fonts change a card's height after first paint, and the paint has to
  // land where the text ended up rather than where it started.
  await document.fonts?.ready
  schedule()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(pending)
  boxes?.disconnect()
  tree?.disconnect()
  watched = []
})

defineExpose({ relay })
</script>

<template>
  <div ref="host" class="oil-surface">
    <OilCanvas
      ref="surface"
      :quality="props.quality"
      :wetness="props.wetness"
      :brush-size="props.brushSize"
      :color="props.color"
      :seed="props.seed"
      :bare="props.bare"
      @stats="$emit('stats', $event)"
      @reset="relay"
    />
    <div ref="content" class="oil-surface__content">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.oil-surface {
  position: absolute;
  inset: 0;
  overflow: hidden;
}

/*
  The content sits over the whole canvas, so by default the pointer goes
  straight through it to the paint. Components opt back in for the parts you can
  actually operate — `pointer-events: none` on an ancestor does not stop a
  descendant that sets `auto`. A blanket rule re-enabling direct children would
  hand the whole canvas-sized wrapper back to the DOM and kill the paint.
*/
.oil-surface__content {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
</style>
