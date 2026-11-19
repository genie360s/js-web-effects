<script setup>
// The tiles on their own, over a playing clip, with every dial on a slider —
// which is the point of the page. Nothing here is a special case: the panel
// writes straight into the same parameter table the grid reads, mid-frame.
import { onBeforeUnmount, reactive, ref } from 'vue'
import TileSurface from '../components/TileSurface.vue'
import TileLayer from '../components/TileLayer.vue'
import { ORDER, TIERS } from '../render/quality.js'
import { attachAudio } from '../audio/beat.js'
import reelUrl from '../../../../test_assets/elephant_video.mp4'

const surface = ref(null)
const video = ref(null)
const quality = ref({ tier: '—', auto: true })
const shown = ref(true)
const sound = ref(false)
let audio = null

// Everything the panel drives. It is one object, watched deeply, so a slider
// and a preset are the same code path.
const options = reactive({
  cell: 40,
  rate: 0.06,
  hold: 0.45,
  block: 0.3,
  offsetMax: 4,
  liftMax: 1.2,
  shift: 1,
  black: 0.7,
  lift: 0.5,
  decay: 4,
  lineAlpha: 0.14,
  grade: 0.85,
  vignette: 0.35,
  shadows: '#06142e',
  highlights: '#c2d8f7',
})

const SLIDERS = [
  ['cell', 16, 120, 1, 'cell', 'px — the size of a tile'],
  ['rate', 0, 1, 0.01, 'rate', 'flips per cell per second, on its own'],
  ['hold', 0.05, 3, 0.05, 'hold', 's a tile keeps its state'],
  ['block', 0, 1, 0.05, 'blocks', 'chance a flip takes a 2x2'],
  ['offsetMax', 0, 12, 1, 'reach', 'cells a shifted tile looks away'],
  ['liftMax', 0, 4, 0.1, 'flare', 'stops'],
  ['shift', 0, 3, 0.1, 'shift', 'weight'],
  ['black', 0, 3, 0.1, 'black', 'weight'],
  ['lift', 0, 3, 0.1, 'lift', 'weight'],
  ['decay', 0.5, 20, 0.5, 'decay', '1/s a beat fades'],
  ['lineAlpha', 0, 1, 0.02, 'grid', 'opacity of the lines'],
  ['grade', 0, 1, 0.05, 'grade', 'duotone amount'],
  ['vignette', 0, 1, 0.05, 'vignette', ''],
]

const PRESETS = {
  quiet: { rate: 0.03, hold: 0.6, block: 0.3, offsetMax: 3, liftMax: 1, shift: 1, black: 0.5, lift: 0.4, decay: 4 },
  titles: { rate: 0.06, hold: 0.45, block: 0.3, offsetMax: 4, liftMax: 1.2, shift: 1, black: 0.7, lift: 0.5, decay: 4 },
  storm: { rate: 0.4, hold: 0.25, block: 0.5, offsetMax: 8, liftMax: 1.6, shift: 1.2, black: 1, lift: 0.8, decay: 6 },
  mosaic: { rate: 0.2, hold: 2, block: 0.6, offsetMax: 6, liftMax: 0.6, shift: 2, black: 0.1, lift: 0.3, decay: 3 },
  blackout: { rate: 0.15, hold: 0.8, block: 0.4, offsetMax: 2, liftMax: 0.5, shift: 0.3, black: 2.5, lift: 0.2, decay: 4 },
}

const GRADES = {
  blue: { shadows: '#06142e', highlights: '#c2d8f7' },
  orange: { shadows: '#2a0e04', highlights: '#ffc89a' },
  mono: { shadows: '#0a0a0c', highlights: '#f2f2f2' },
}

function preset(name) {
  Object.assign(options, PRESETS[name])
}

function grade(name) {
  Object.assign(options, GRADES[name])
}

/**
 * Sound has to start from a click: browsers keep audio silent until a
 * gesture, and the clip plays muted until then.
 */
async function toggleSound() {
  const engine = surface.value?.engine
  if (!engine || !video.value) return
  if (audio) {
    audio.detach()
    audio = null
    video.value.muted = true
    sound.value = false
    return
  }
  audio = attachAudio(engine, video.value, { gain: 1.2, drive: 0.5 })
  await audio.resume()
  video.value.muted = false
  if (video.value.paused) await video.value.play().catch(() => {})
  sound.value = true
}

function onKey(event) {
  if (event.key === 'h') shown.value = !shown.value
}
window.addEventListener('keydown', onKey)
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  audio?.detach()
})
</script>

<template>
  <TileSurface
    ref="surface"
    :options="options"
    @quality="quality = $event"
    @ready="quality = $event.quality"
  >
    <!-- The clip is the floor: a layer that fills the viewport, added first
         so everything else is drawn over it. -->
    <div class="backdrop">
      <TileLayer>
        <video ref="video" class="reel" :src="reelUrl" autoplay muted loop playsinline crossorigin="anonymous"></video>
      </TileLayer>
    </div>

    <main class="stage">
      <TileLayer :sweep="0.6">
        <h1 class="display">box&nbsp;tiles</h1>
      </TileLayer>
      <TileLayer>
        <p class="lede">
          A grid of squares over the picture. On their own time, and harder
          when something happens, tiles go black, show the picture from a few
          cells away, or flare up — and let go again. Move across the page;
          click to knock it; turn the sound on and let the beat do it.
        </p>
      </TileLayer>
      <TileLayer :tiles="false">
        <p class="foot">This line is <code>:tiles="false"</code>. The grid leaves it alone.</p>
      </TileLayer>
    </main>
  </TileSurface>

  <nav class="hud">
    <span class="badge">{{ quality.tier }}{{ quality.auto ? '' : ' (pinned)' }}</span>
    <a class="badge btn" href="#/titles">titles</a>
    <a class="badge btn" href="#/text">text</a>
    <a class="badge btn" href="#/login">login</a>
    <a class="badge btn" href="#/image">image</a>
    <a class="badge btn" href="#/video">video</a>
    <a class="badge btn" href="#/all">all</a>
    <button class="badge btn" :class="{ on: sound }" @click="toggleSound">{{ sound ? 'sound on' : 'sound' }}</button>
    <button class="badge btn" @click="surface.beat(1.5)">beat</button>
    <button class="badge btn" @click="surface.reset()">settle</button>
  </nav>

  <aside v-show="shown" class="panel">
    <div class="presets">
      <button v-for="name in Object.keys(PRESETS)" :key="name" class="badge btn" @click="preset(name)">
        {{ name }}
      </button>
    </div>
    <div class="presets">
      <button v-for="name in Object.keys(GRADES)" :key="name" class="badge btn" @click="grade(name)">
        {{ name }}
      </button>
      <button class="badge btn" @click="surface.reseed(Math.floor(Math.random() * 1e9))">reseed</button>
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

  <p class="hint">move to disturb it · click to knock it · <b>h</b> hides the panel</p>
</template>

<style scoped>
.backdrop { position: fixed; inset: 0; z-index: 0; overflow: hidden; }
.reel { display: block; width: 100%; height: 100%; object-fit: cover; }
.stage {
  position: relative; z-index: 1; min-height: 100svh;
  display: flex; flex-direction: column; justify-content: center; align-items: center;
  gap: 24px; padding: 96px 24px 120px;
}
.display {
  margin: 0; font-size: clamp(64px, 16vw, 200px); font-weight: 800;
  letter-spacing: -.055em; line-height: .9; text-align: center;
  text-shadow: 0 2px 30px rgba(0, 0, 0, .6);
}
.lede {
  margin: 0; max-width: 52ch; text-align: center; font-size: clamp(15px, 1.7vw, 19px); line-height: 1.65;
  text-shadow: 0 1px 12px rgba(0, 0, 0, .8);
}
.foot { margin: 0; font-size: 13px; opacity: .7; }
.foot code { font-size: 12px; }
</style>
