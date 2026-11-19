<script setup>
/**
 * An ordinary HTML card that is made of oil paint.
 *
 * Nothing here draws the card's surface. `v-oil` marks it, and the <OilSurface>
 * it sits inside lays a slab of paint underneath — so the card has a real
 * thickness, catches the same studio window as the painting, and shows the same
 * combed bristle furrows. The card itself stays ordinary markup: real text that
 * can be selected and read out, real focus order, real controls in the slots.
 *
 * There is nothing special about this component. It is just an <article> that
 * asked for paint; anything else can ask the same way.
 */
defineProps({
  title: { type: String, default: '' },
  subtitle: { type: String, default: '' },
  /** Which pigment the card is made of. A palette name, or `ground` for a
   *  scumbled neutral. */
  pigment: { type: String, default: 'ground' },
})
</script>

<template>
  <article v-oil="pigment" class="oil-card">
    <header v-if="title || subtitle" class="oil-card__head">
      <h2 v-if="title" class="oil-card__title">{{ title }}</h2>
      <p v-if="subtitle" class="oil-card__sub">{{ subtitle }}</p>
    </header>
    <div class="oil-card__body">
      <slot />
    </div>
    <footer v-if="$slots.footer" class="oil-card__foot">
      <slot name="footer" />
    </footer>
  </article>
</template>

<style scoped>
/* No background, no border, no shadow: the paint is all three. */
.oil-card {
  display: grid;
  gap: 1.15rem;
  padding: 1.5rem 1.6rem 1.7rem;
  background: none;
  border: 0;
  color: #17120e;
  /*
    The card's surface is paint, and paint is something you drag. So the pointer
    passes through the card to the canvas underneath, which is what lets a
    stroke cross it and pull its colour off. Only the things you can actually
    operate take their events back — otherwise the card would be a dead rectangle
    in the middle of a wet canvas.
  */
  pointer-events: none;
}

.oil-card :deep(input),
.oil-card :deep(textarea),
.oil-card :deep(select),
.oil-card :deep(button),
.oil-card :deep(a[href]),
.oil-card :deep([tabindex]) {
  pointer-events: auto;
}

.oil-card__head {
  display: grid;
  gap: 0.3rem;
}

.oil-card__title {
  margin: 0;
  font-size: 1.35rem;
  font-weight: 600;
  letter-spacing: 0.01em;
}

.oil-card__sub {
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.5;
  color: rgba(23, 18, 14, 0.78);
}

.oil-card__body {
  display: grid;
  gap: 1rem;
}

.oil-card__foot {
  display: flex;
  flex-wrap: wrap;
  gap: 0.7rem;
  align-items: center;
}
</style>
