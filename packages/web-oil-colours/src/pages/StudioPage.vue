<script setup>
import { computed, ref } from 'vue'
import OilCanvas from '../components/OilCanvas.vue'
import { PALETTE } from '../ui/palette'

const loaded = ref(null) // index into PALETTE, or null for a clean brush
const wetness = ref(1)
const brushSize = ref(0.055)
const quality = ref('auto')
const seed = ref(7)
const stats = ref(null)
const panel = ref(true)

const color = computed(() => (loaded.value === null ? null : PALETTE[loaded.value].rgb))
const swatch = (rgb) => `rgb(${rgb.map((c) => Math.round(c * 255)).join(' ')})`

function load(i) {
  loaded.value = loaded.value === i ? null : i
}

function fresh() {
  seed.value = (seed.value * 1103515245 + 12345) & 0x7fffffff
}
</script>

<template>
  <div class="stage">
    <OilCanvas
      :quality="quality"
      :wetness="wetness"
      :brush-size="brushSize"
      :color="color"
      :seed="seed"
      :class="{ 'stage__surface--loaded': loaded !== null }"
      class="stage__surface"
      @stats="stats = $event"
    />

    <button class="toggle" type="button" :aria-expanded="panel" @click="panel = !panel">
      {{ panel ? 'hide' : 'palette' }}
    </button>

    <aside v-show="panel" class="panel">
      <h1 class="panel__title">wet oil</h1>
      <p class="panel__hint">
        Move the cursor to drag the paint. Pick a colour to load the brush, then
        press and drag to lay it on.
      </p>

      <div class="swatches" role="group" aria-label="palette">
        <button
          v-for="(p, i) in PALETTE"
          :key="p.name"
          type="button"
          class="swatches__chip"
          :class="{ 'swatches__chip--on': loaded === i }"
          :style="{ background: swatch(p.rgb) }"
          :title="p.name"
          :aria-label="p.name"
          :aria-pressed="loaded === i"
          @click="load(i)"
        />
      </div>

      <label class="field">
        <span>wetness</span>
        <input v-model.number="wetness" type="range" min="0" max="1" step="0.01" />
      </label>

      <label class="field">
        <span>brush</span>
        <input v-model.number="brushSize" type="range" min="0.015" max="0.14" step="0.005" />
      </label>

      <label class="field">
        <span>quality</span>
        <select v-model="quality">
          <option value="auto">auto</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
          <option value="ultra">ultra</option>
        </select>
      </label>

      <button class="panel__action" type="button" @click="fresh">new canvas</button>

      <p v-if="stats" class="panel__stats">
        {{ stats.fps.toFixed(0) }} fps · {{ stats.tier }}{{ stats.auto ? '' : ' (pinned)' }} ·
        {{ stats.grid }}{{ stats.idle ? ' · resting' : '' }}
      </p>
    </aside>
  </div>
</template>

<style scoped>
.stage {
  position: relative;
  height: 100%;
  overflow: hidden;
}

/* A clean brush pushes paint; a loaded one puts it down. Say which with the
   cursor, since nothing else on screen shows the difference. */
.stage__surface :deep(canvas) {
  cursor: grab;
}
.stage__surface--loaded :deep(canvas) {
  cursor: crosshair;
}

.toggle,
.panel__action {
  font: inherit;
  font-size: 0.75rem;
  letter-spacing: 0.12em;
  text-transform: lowercase;
  color: var(--ink);
  background: rgba(26, 21, 18, 0.62);
  border: 1px solid rgba(242, 232, 218, 0.18);
  border-radius: var(--radius);
  padding: 0.4rem 0.9rem;
  cursor: pointer;
  backdrop-filter: blur(8px);
}
.toggle:hover,
.panel__action:hover {
  border-color: rgba(242, 232, 218, 0.45);
}

.toggle {
  position: absolute;
  top: max(1rem, env(safe-area-inset-top));
  right: max(1rem, env(safe-area-inset-right));
  z-index: 2;
}

.panel {
  position: absolute;
  top: max(1rem, env(safe-area-inset-top));
  left: max(1rem, env(safe-area-inset-left));
  z-index: 2;
  width: min(19rem, calc(100vw - 2rem));
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1rem 1.1rem 1.1rem;
  border-radius: var(--radius);
  background: rgba(26, 21, 18, 0.62);
  border: 1px solid rgba(242, 232, 218, 0.14);
  backdrop-filter: blur(14px);
}

.panel__title {
  margin: 0;
  font-size: 0.9375rem;
  font-weight: 500;
  letter-spacing: 0.2em;
  text-transform: lowercase;
}

.panel__hint {
  margin: 0;
  font-size: 0.75rem;
  line-height: 1.5;
  color: rgba(242, 232, 218, 0.62);
}

.swatches {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.swatches__chip {
  width: 1.75rem;
  height: 1.75rem;
  padding: 0;
  border-radius: var(--radius);
  border: 2px solid transparent;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.45);
  cursor: pointer;
}
.swatches__chip:hover {
  transform: translateY(-1px);
}
.swatches__chip--on {
  border-color: rgba(242, 232, 218, 0.95);
}
.swatches__chip:focus-visible,
.toggle:focus-visible,
.panel__action:focus-visible {
  outline: 2px solid rgba(242, 232, 218, 0.8);
  outline-offset: 2px;
}

.field {
  display: grid;
  grid-template-columns: 4.25rem 1fr;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.75rem;
  letter-spacing: 0.08em;
  color: rgba(242, 232, 218, 0.72);
}

.field input[type='range'] {
  width: 100%;
  accent-color: #d9a441;
}

.field select {
  font: inherit;
  font-size: 0.75rem;
  color: var(--ink);
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(242, 232, 218, 0.2);
  border-radius: var(--radius);
  padding: 0.25rem 0.4rem;
}

.panel__action {
  align-self: start;
}

.panel__stats {
  margin: 0;
  font-size: 0.6875rem;
  letter-spacing: 0.08em;
  color: rgba(242, 232, 218, 0.4);
  font-variant-numeric: tabular-nums;
}
</style>
