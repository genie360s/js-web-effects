<script setup>
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import WaterSurface from '../components/WaterSurface.vue'
import { ORDER, TIERS } from '../render/quality'

const quality = ref('auto')
const breeze = ref(1)
const seed = ref(7)
const showUi = ref(true)
const hint = ref(true)

const stats = reactive({ fps: 0, tier: 'high', auto: true, grid: '—', cells: 0, idle: false })

function onStats(s) {
  Object.assign(stats, s)
}

function onReady() {
  setTimeout(() => (hint.value = false), 7000)
}

function reseed() {
  seed.value = Math.floor(Math.random() * 1e9)
}

function onKey(e) {
  if (e.key === 'h' || e.key === 'H') showUi.value = !showUi.value
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="page">
    <WaterSurface
      :breeze="breeze"
      :quality="quality"
      :seed="seed"
      @stats="onStats"
      @ready="onReady"
    />

    <header class="title">
      <h1>still water</h1>
      <Transition name="fade">
        <p v-if="hint" class="title__hint">
          move slowly for ripples · flick to drive a wake · click to drop a stone
        </p>
      </Transition>
    </header>

    <Transition name="slide">
      <aside v-if="showUi" class="panel">
        <div class="panel__row">
          <span class="panel__label">quality</span>
          <div class="seg">
            <button
              :class="{ on: quality === 'auto' }"
              @click="quality = 'auto'"
            >auto</button>
            <button
              v-for="t in ORDER"
              :key="t"
              :class="{ on: quality === t }"
              @click="quality = t"
            >{{ TIERS[t].label.toLowerCase() }}</button>
          </div>
        </div>

        <div class="panel__row">
          <span class="panel__label">breeze</span>
          <input v-model.number="breeze" type="range" min="0" max="2" step="0.05" />
          <span class="panel__value">{{ breeze.toFixed(2) }}</span>
        </div>

        <div class="panel__row">
          <span class="panel__label">bed</span>
          <button class="ghost" @click="reseed">grow a new one</button>
        </div>

        <dl class="readout">
          <div><dt>fps</dt><dd>{{ stats.fps.toFixed(0) }}</dd></div>
          <div><dt>tier</dt><dd>{{ stats.tier }}<small v-if="stats.auto"> auto</small></dd></div>
          <div><dt>grid</dt><dd>{{ stats.grid }}</dd></div>
          <div><dt>sim</dt><dd>{{ stats.idle ? '30' : '60' }}<small> hz</small></dd></div>
        </dl>

        <p class="panel__foot">h hides this</p>
      </aside>
    </Transition>
  </div>
</template>

<style scoped>
.page {
  position: absolute;
  inset: 0;
}

.title {
  position: absolute;
  top: clamp(1.5rem, 4vh, 3rem);
  left: clamp(1.5rem, 4vw, 3.5rem);
  pointer-events: none;
  text-shadow: 0 2px 18px rgba(0, 0, 0, 0.6);
}

.title h1 {
  margin: 0;
  font-size: clamp(1.75rem, 4.5vw, 3rem);
  font-weight: 300;
  letter-spacing: 0.02em;
  color: rgba(238, 244, 232, 0.92);
}

.title__hint {
  margin: 0.6rem 0 0;
  max-width: 34ch;
  font-size: 0.8125rem;
  font-weight: 400;
  line-height: 1.6;
  letter-spacing: 0.06em;
  color: rgba(226, 238, 216, 0.62);
}

.panel {
  position: absolute;
  top: clamp(1.5rem, 4vh, 3rem);
  right: clamp(1.5rem, 4vw, 3.5rem);
  width: min(19rem, calc(100vw - 3rem));
  padding: 1.1rem 1.2rem 0.9rem;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  border-radius: 0.9rem;
  border: 1px solid rgba(226, 240, 214, 0.12);
  background: rgba(14, 22, 14, 0.42);
  backdrop-filter: blur(16px) saturate(1.1);
  -webkit-backdrop-filter: blur(16px) saturate(1.1);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.35);
  color: rgba(232, 242, 224, 0.85);
}

.panel__row {
  display: flex;
  align-items: center;
  gap: 0.7rem;
}

.panel__label {
  flex: 0 0 3.6rem;
  font-size: 0.6875rem;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: rgba(226, 240, 214, 0.45);
}

.panel__value {
  flex: 0 0 2.4rem;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
  text-align: right;
  color: rgba(226, 240, 214, 0.6);
}

.seg {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}

.seg button,
.ghost {
  font: inherit;
  font-size: 0.75rem;
  letter-spacing: 0.04em;
  padding: 0.28rem 0.55rem;
  border-radius: 0.45rem;
  border: 1px solid rgba(226, 240, 214, 0.14);
  background: rgba(226, 240, 214, 0.04);
  color: rgba(232, 242, 224, 0.72);
  cursor: pointer;
  transition: background 0.18s ease, color 0.18s ease, border-color 0.18s ease;
}

.seg button:hover,
.ghost:hover {
  background: rgba(226, 240, 214, 0.1);
  color: rgba(244, 250, 238, 0.95);
}

.seg button.on {
  background: rgba(150, 214, 170, 0.18);
  border-color: rgba(150, 214, 170, 0.4);
  color: rgba(226, 250, 232, 0.98);
}

input[type='range'] {
  flex: 1;
  height: 2px;
  appearance: none;
  background: rgba(226, 240, 214, 0.2);
  border-radius: 2px;
  outline: none;
}

input[type='range']::-webkit-slider-thumb {
  appearance: none;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: rgba(198, 232, 206, 0.9);
  cursor: pointer;
}

input[type='range']::-moz-range-thumb {
  width: 11px;
  height: 11px;
  border: none;
  border-radius: 50%;
  background: rgba(198, 232, 206, 0.9);
  cursor: pointer;
}

.readout {
  display: flex;
  gap: 1.1rem;
  margin: 0.1rem 0 0;
  padding-top: 0.75rem;
  border-top: 1px solid rgba(226, 240, 214, 0.1);
}

.readout div {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.readout dt {
  font-size: 0.625rem;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: rgba(226, 240, 214, 0.38);
}

.readout dd {
  margin: 0;
  font-size: 0.875rem;
  font-variant-numeric: tabular-nums;
  color: rgba(236, 246, 228, 0.9);
}

.readout small {
  font-size: 0.625rem;
  letter-spacing: 0.1em;
  color: rgba(150, 214, 170, 0.75);
}

.panel__foot {
  margin: 0;
  font-size: 0.625rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: rgba(226, 240, 214, 0.28);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.9s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.slide-enter-active,
.slide-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}
.slide-enter-from,
.slide-leave-to {
  opacity: 0;
  transform: translateY(-0.4rem);
}

@media (max-width: 640px) {
  .panel {
    top: auto;
    bottom: 4.5rem;
    left: 1rem;
    right: 1rem;
    width: auto;
  }
}
</style>
