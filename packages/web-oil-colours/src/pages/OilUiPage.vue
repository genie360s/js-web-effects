<script setup>
import { ref } from 'vue'
import OilSurface from '../components/OilSurface.vue'
import OilCard from '../components/OilCard.vue'

const surface = ref(null)
const email = ref('')
const password = ref('')
const stats = ref(null)
const said = ref('')

function submit() {
  said.value = email.value ? `Signed in as ${email.value}.` : 'Enter an email address.'
}

/** Lay the card's paint again, for when it has been dragged off the canvas. */
function relay() {
  surface.value?.relay()
  said.value = ''
}
</script>

<template>
  <!--
    `bare` starts the canvas on empty linen, so the only paint anywhere is what
    the card put there. No brush colour is passed either, so the cursor can only
    move paint, never add any.
  -->
  <OilSurface ref="surface" bare @stats="stats = $event">
    <div class="centre">
      <!--
        An ordinary login form. `v-oil` marks the card, its fields and its
        button; their surfaces are laid into the paint rather than drawn on top
        of it, so dragging across them pulls their colour off and mixes it,
        subtractively, with the painting underneath.
      -->
          <form @submit.prevent="submit">
      <OilCard
        title="Sign in"
        pigment="titanium white"
        subtitle="This card is made of oil paint, and it is still wet. Drag across it."
      >
        <label class="field">
          <span class="field__label">Email</span>
          <input
            v-model="email"
            v-oil="{ pigment: 'burnt umber', pad: 3 }"
            type="email"
            name="email"
            autocomplete="email"
            placeholder="you@example.com"
          />
        </label>

        <label class="field">
          <span class="field__label">Password</span>
          <input
            v-model="password"
            v-oil="{ pigment: 'burnt umber', pad: 3 }"
            type="password"
            name="password"
            autocomplete="current-password"
            placeholder="••••••••"
          />
        </label>

        <template #footer>
          <!-- A real submit in a real form: pressing Enter in either field is
               how a sign-in card is expected to work. -->
          <button v-oil="{ pigment: 'alizarin crimson', pad: 5 }" type="submit" class="submit">
            Sign in
          </button>
          <button type="button" class="link" @click="relay">re-lay the paint</button>
          <!-- Present from the start: a live region created in the same
               mutation as its text is not announced. -->
          <p class="said" role="status">{{ said }}</p>
        </template>
      </OilCard>
      </form>
    </div>

    <p v-if="stats" class="readout">
      {{ stats.fps.toFixed(0) }} fps · {{ stats.tier }} · {{ stats.grid
      }}{{ stats.idle ? ' · resting' : '' }}
    </p>
  </OilSurface>
</template>

<style scoped>
.centre {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
}

.centre :deep(.oil-card) {
  width: min(22rem, calc(100vw - 4rem));
}

/* The paint under the text can be dragged away, so the text has to stay
   readable on whatever ends up behind it. */
.centre :deep(.oil-card__title),
.centre :deep(.oil-card__sub),
.field__label,
.link,
.said {
  text-shadow: 0 1px 2px rgba(247, 241, 230, 0.55);
}

/* The same goes for the light text on the field and button slabs, which the
   card explicitly invites you to drag away — once it is gone they are
   near-white on light linen. */
.field input,
.submit {
  text-shadow: 0 1px 2px rgba(23, 18, 14, 0.55);
}

.field {
  display: grid;
  gap: 0.3rem;
}

.field__label {
  font-size: 0.75rem;
  letter-spacing: 0.06em;
  color: rgba(23, 18, 14, 0.85);
}

/* No background, no border: the slab of paint underneath is both. */
.field input {
  font: inherit;
  font-size: 0.875rem;
  width: 100%;
  padding: 0.55rem 0.7rem;
  color: #f7f1e6;
  background: none;
  border: 0;
}
.field input::placeholder {
  color: rgba(247, 241, 230, 0.45);
}

.submit {
  font: inherit;
  font-size: 0.875rem;
  letter-spacing: 0.04em;
  color: #f7f1e6;
  background: none;
  border: 0;
  padding: 0.6rem 1.4rem;
  cursor: pointer;
}

.link {
  font: inherit;
  font-size: 0.75rem;
  color: rgba(23, 18, 14, 0.7);
  background: none;
  border: 0;
  padding: 0.2rem;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
.link:hover {
  color: #17120e;
}

.said {
  flex-basis: 100%;
  margin: 0;
  font-size: 0.75rem;
  color: rgba(23, 18, 14, 0.85);
}

.field input:focus-visible,
.submit:focus-visible,
.link:focus-visible {
  outline: 2px solid #17120e;
  outline-offset: 3px;
}

.readout {
  position: absolute;
  right: max(1rem, env(safe-area-inset-right));
  bottom: max(1rem, env(safe-area-inset-bottom));
  margin: 0;
  font-size: 0.6875rem;
  letter-spacing: 0.08em;
  /* Bare linen renders light, so this needs to be dark enough to carry
     against it rather than merely visible. */
  color: rgba(23, 18, 14, 0.85);
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}

@media (max-width: 640px) {
  .readout {
    bottom: calc(max(1rem, env(safe-area-inset-bottom)) + 3rem);
  }
}
</style>
