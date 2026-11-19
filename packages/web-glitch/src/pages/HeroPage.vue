<script setup>
// The glitch over a portrait, with every dial on a slider — which is the
// point of the page. Nothing here is a special case: the panel writes
// straight into the same parameter table the solver reads.
import { onBeforeUnmount, reactive, ref } from 'vue'
import GlitchSurface from '../components/GlitchSurface.vue'
import { STYLES } from '../sim/params.js'
import photoUrl from '../../../../test_assets/portrait.png'

const surfaces = ref([])
const shown = ref(true)
const panel = ref(true)

// Everything the panel drives. It is one object, watched deeply, so a slider
// and a preset are the same code path.
const options = reactive({
  cell: 14,
  style: 'image',
  cutout: true,
  speed: 0.7,
  glitch: 0.04,
  hold: 0.16,
  burstRate: 0.1,
  burstLength: 0.6,
  switch: 0.09,
  labels: 0.2,
  glow: 1,
  split: 0.45,
  tolerance: 0.14,
})
const type = { cell: 7, glitch: 0.02, burstRate: 0.06, labels: 0 }

const SLIDERS = [
  ['cell', 6, 40, 1, 'cell', 'px — the smallest block'],
  ['speed', 0.1, 3, 0.05, 'speed', 'a reveal takes 1/speed seconds'],
  ['glitch', 0, 0.6, 0.01, 'glitch', 'share of blocks misbehaving at rest'],
  ['hold', 0.04, 1, 0.02, 'hold', 's a block keeps its misbehaviour'],
  ['burstRate', 0, 2, 0.05, 'bursts', 'per second, on its own'],
  ['burstLength', 0.1, 3, 0.05, 'length', 's a burst lasts'],
  ['switch', 0.03, 0.5, 0.01, 'switch', 's a burst holds each rendering'],
  ['labels', 0, 1, 0.05, 'numbers', 'share of edge blocks that carry one'],
  ['glow', 0, 3, 0.1, 'glow', 'flash as a block arrives'],
  ['split', 0, 1, 0.05, 'split', 'how finely the inside is cut'],
  ['tolerance', 0.02, 0.6, 0.01, 'key', 'how far from the background colour still counts as background'],
]

const PRESETS = {
  quiet: { speed: 0.5, glitch: 0.01, hold: 0.3, burstRate: 0, burstLength: 0.5, switch: 0.1, labels: 0.1, glow: 0.6 },
  titles: { speed: 0.7, glitch: 0.04, hold: 0.16, burstRate: 0.1, burstLength: 0.6, switch: 0.09, labels: 0.2, glow: 1 },
  storm: { speed: 1.2, glitch: 0.3, hold: 0.08, burstRate: 0.8, burstLength: 0.9, switch: 0.06, labels: 0.5, glow: 1.6 },
  bloom: { speed: 0.35, glitch: 0.02, hold: 0.2, burstRate: 0, burstLength: 0.6, switch: 0.09, labels: 0, glow: 3 },
}

const each = (fn) => surfaces.value.forEach(fn)

function replay() {
  shown.value = false
  setTimeout(() => { shown.value = true }, 1100)
}

function onKey(event) {
  if (event.key === 'h') panel.value = !panel.value
}
window.addEventListener('keydown', onKey)
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <main class="stage">
    <GlitchSurface :ref="(el) => (surfaces[0] = el)" :options="type" :visible="shown">
      <h1 class="display">web&nbsp;glitch</h1>
    </GlitchSurface>

    <GlitchSurface :ref="(el) => (surfaces[1] = el)" class="portrait" :options="options" :visible="shown">
      <img class="frame" :src="photoUrl" alt="A painted portrait, arriving in blocks" />
    </GlitchSurface>

    <GlitchSurface :ref="(el) => (surfaces[2] = el)" :options="type" :visible="shown">
      <p class="lede">
        A picture that arrives in blocks along its own silhouette, and now and
        then flicks through dots, a grey mosaic, a white mask and back.
        Move across it; click for a burst.
      </p>
    </GlitchSurface>
  </main>

  <nav class="hud">
    <a class="badge btn" href="#/image">image</a>
    <a class="badge btn" href="#/video">video</a>
    <a class="badge btn" href="#/text">text</a>
    <a class="badge btn" href="#/styles">styles</a>
    <a class="badge btn" href="#/login">login</a>
    <button class="badge btn" @click="replay">replay</button>
    <button class="badge btn" :class="{ on: !shown }" @click="shown = !shown">{{ shown ? 'hide' : 'reveal' }}</button>
    <button class="badge btn" @click="each((s) => s.burst(1.5))">burst</button>
  </nav>

  <aside v-show="panel" class="panel">
    <div class="presets">
      <button
        v-for="name in STYLES"
        :key="name"
        class="badge btn"
        :class="{ on: options.style === name }"
        @click="options.style = name"
      >{{ name }}</button>
    </div>
    <div class="presets">
      <button v-for="name in Object.keys(PRESETS)" :key="name" class="badge btn" @click="Object.assign(options, PRESETS[name])">
        {{ name }}
      </button>
      <button class="badge btn" :class="{ on: options.cutout }" @click="options.cutout = !options.cutout">cutout</button>
      <button class="badge btn" @click="each((s) => s.reseed(Math.floor(Math.random() * 1e9)))">reseed</button>
    </div>
    <label v-for="[key, min, max, step, label, note] in SLIDERS" :key="key" class="control">
      <span class="control-label" :title="note">{{ label }}</span>
      <input v-model.number="options[key]" type="range" :min="min" :max="max" :step="step" />
      <span class="control-value">{{ options[key] }}</span>
    </label>
  </aside>

  <p class="hint">move to unsettle it · click for a burst · <b>h</b> hides the panel</p>
</template>

<style scoped>
.stage {
  min-height: 100svh;
  display: flex; flex-direction: column; justify-content: center; align-items: center;
  gap: 22px; padding: 72px 24px 96px;
}
.display {
  margin: 0; font-size: clamp(34px, 6vw, 76px); font-weight: 700;
  letter-spacing: .14em; line-height: 1; text-transform: uppercase; text-align: center;
}
.portrait { width: fit-content; }
.frame { display: block; width: auto; height: min(56svh, 86vw); aspect-ratio: 1; }
.lede {
  margin: 0; max-width: 62ch; text-align: center;
  font-size: clamp(12px, 1.2vw, 15px); line-height: 1.7; letter-spacing: .04em; opacity: .85;
}
</style>
