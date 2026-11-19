<script setup>
// The fire on its own, with every dial the solver has wired to a slider —
// which is the point of the page. Nothing here is a special case: the panel
// writes straight into the same parameter table the physics reads, mid-frame,
// while it is burning.
import { onBeforeUnmount, reactive, ref } from 'vue'
import FireSurface from '../components/FireSurface.vue'
import FireLayer from '../components/FireLayer.vue'
import { ORDER, TIERS } from '../render/quality.js'

const surface = ref(null)
const quality = ref({ tier: '—', auto: true })
const shown = ref(true)

// Everything the panel drives. It is one object, watched deeply, so a slider
// and a preset are the same code path.
const options = reactive({
  scene: 1.2,
  windX: 0,
  gust: 0.35,
  turbulence: 12,
  sootYield: 8,
  flameFeedback: 800,
  oxygenRefresh: 1,
  haze: 26,
  exposure: 1.15,
  emberSize: 3.2,
  blue: 0.35,
  smoke: 0.55,
})

const SLIDERS = [
  ['scene', 0.2, 6, 0.1, 'scene', 'metres tall — the size of the fire'],
  ['windX', -8, 8, 0.1, 'wind', 'm/s across the screen'],
  ['gust', 0, 2, 0.05, 'gust', 'how much the wind wanders'],
  ['turbulence', 0, 40, 1, 'curl', 'vorticity confinement'],
  ['sootYield', 0, 20, 0.5, 'soot', 'per unit burned — this is the yellow'],
  ['flameFeedback', 0, 2500, 25, 'radiance', 'K/s the flame puts back into the page'],
  ['oxygenRefresh', 0, 8, 0.1, 'air', '1/s of fresh oxygen; 0 suffocates it'],
  ['haze', 0, 80, 1, 'haze', 'px of refraction through hot air'],
  ['exposure', 0.2, 3, 0.05, 'exposure', ''],
  ['emberSize', 0, 8, 0.2, 'sparks', 'px'],
  ['blue', 0, 1.5, 0.05, 'blue', 'the reaction zone at the base'],
  ['smoke', 0, 3, 0.05, 'smoke', 'optical depth'],
]

const PRESETS = {
  paper: { scene: 0.5, windX: 0, gust: 0.35, turbulence: 12, sootYield: 8, flameFeedback: 800, oxygenRefresh: 1, haze: 18, exposure: 1.15, emberSize: 2.4, blue: 0.5, smoke: 0.45 },
  bonfire: { scene: 3, windX: 0, gust: 0.5, turbulence: 20, sootYield: 11, flameFeedback: 1400, oxygenRefresh: 1.6, haze: 40, exposure: 1.1, emberSize: 4.5, blue: 0.2, smoke: 0.8 },
  gale: { scene: 1.5, windX: 5.5, gust: 0.8, turbulence: 24, sootYield: 7, flameFeedback: 1000, oxygenRefresh: 2.4, haze: 30, exposure: 1.2, emberSize: 4, blue: 0.3, smoke: 0.5 },
  smoulder: { scene: 1.2, windX: 0, gust: 0.2, turbulence: 6, sootYield: 16, flameFeedback: 420, oxygenRefresh: 0.25, haze: 14, exposure: 1.0, emberSize: 2, blue: 0.05, smoke: 1.6 },
}

function preset(name) {
  Object.assign(options, PRESETS[name])
}

function onKey(event) {
  if (event.key === 'h') shown.value = !shown.value
}
window.addEventListener('keydown', onKey)
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <FireSurface
    ref="surface"
    :options="options"
    @quality="quality = $event"
    @ready="quality = $event.quality"
  >
    <main class="stage">
      <FireLayer>
        <h1 class="display">web&nbsp;fire</h1>
      </FireLayer>
      <FireLayer>
        <p class="lede">
          Combustion, solved. A hot surface gives off vapour, the vapour finds
          oxygen and burns, the hot gas rises because it is less dense, and
          the flame radiates back down and keeps the surface going. Drag
          across the page to hold a match to it.
        </p>
      </FireLayer>
      <FireLayer :fuel="0">
        <p class="foot">
          This paragraph is <code>:fuel="0"</code>. It will not catch.
        </p>
      </FireLayer>
    </main>
  </FireSurface>

  <nav class="hud">
    <span class="badge">{{ quality.tier }}{{ quality.auto ? '' : ' (pinned)' }}</span>
    <a class="badge btn" href="#/text">text</a>
    <a class="badge btn" href="#/login">login</a>
    <a class="badge btn" href="#/image">image</a>
    <a class="badge btn" href="#/video">video</a>
    <a class="badge btn" href="#/all">all</a>
    <a class="badge btn" href="#/eternal">eternal</a>
    <button class="badge btn" @click="surface.reset()">put it out</button>
  </nav>

  <aside v-show="shown" class="panel">
    <div class="presets">
      <button v-for="name in Object.keys(PRESETS)" :key="name" class="badge btn" @click="preset(name)">
        {{ name }}
      </button>
    </div>
    <label v-for="[key, min, max, step, label, note] in SLIDERS" :key="key" class="control">
      <span class="control-label" :title="note">{{ label }}</span>
      <input v-model.number="options[key]" type="range" :min="min" :max="max" :step="step" />
      <span class="control-value">{{ options[key] }}</span>
    </label>
    <div class="presets">
      <button
        v-for="tier in ORDER"
        :key="tier"
        class="badge btn"
        :class="{ on: !quality.auto && quality.tier === tier }"
        @click="surface.setQuality(tier)"
      >{{ TIERS[tier].label }}</button>
      <button class="badge btn" :class="{ on: quality.auto }" @click="surface.setQuality(null)">auto</button>
    </div>
  </aside>

  <p class="hint">drag to light it · <b>h</b> hides the panel</p>
</template>

<style scoped>
.stage {
  position: relative; z-index: 1; min-height: 100svh;
  display: flex; flex-direction: column; justify-content: center; align-items: center;
  gap: 24px; padding: 96px 24px 120px;
}
.display {
  margin: 0; font-size: clamp(64px, 16vw, 200px); font-weight: 800;
  letter-spacing: -.055em; line-height: .9; text-align: center;
}
.lede { margin: 0; max-width: 52ch; text-align: center; font-size: clamp(15px, 1.7vw, 19px); line-height: 1.65; }
.foot { margin: 0; font-size: 13px; opacity: .55; }
.foot code { font-size: 12px; }

.panel {
  position: fixed; left: 16px; bottom: 16px; z-index: 4;
  display: flex; flex-direction: column; gap: 7px;
  padding: 14px 16px; border-radius: 8px;
  background: rgba(14, 10, 8, .86); backdrop-filter: blur(6px);
  max-height: min(70svh, 620px); overflow: auto;
}
.presets { display: flex; flex-wrap: wrap; gap: 6px; }
.control { display: grid; grid-template-columns: 70px 132px 46px; align-items: center; gap: 9px; }
.control-label { font-size: 11px; letter-spacing: .1em; text-transform: uppercase; opacity: .7; }
.control-value { font-size: 11px; text-align: right; opacity: .8; font-variant-numeric: tabular-nums; }
.badge.on { background: #c2703a; color: #14100c; }
</style>
