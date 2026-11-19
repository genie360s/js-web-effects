<script setup>
// A title sequence. A looping clip, a grade that switches with the cut, names
// that arrive and leave tile by tile on the clip's own clock, a burst of tiles
// on every cue, and — with the sound on — a burst on every beat too.
//
// Nothing here is a special mode of the engine. The names are <TileLayer>s
// whose `reveal` is driven from the video's currentTime; the grade is two
// colours written through setParams; the bursts are `beat()`.
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import TileSurface from '../components/TileSurface.vue'
import TileLayer from '../components/TileLayer.vue'
import { attachAudio } from '../audio/beat.js'
import reelUrl from '../../../../test_assets/elephant_video.mp4'

const GRADES = {
  blue: { shadows: '#06142e', highlights: '#c2d8f7', lineColor: '#9fc4ff' },
  orange: { shadows: '#2a0e04', highlights: '#ffc89a', lineColor: '#ffb27a' },
}

/** Seconds into the clip; the clip is ten seconds and loops. */
const CUES = [
  { at: 0.3, over: 'starring', text: 'ADA LOVELL', grade: 'blue' },
  { at: 2.4, over: '', text: 'MARCUS OKONKWO', grade: 'blue' },
  { at: 4.4, over: 'with', text: 'YUKI TANAKA', grade: 'orange' },
  { at: 6.3, over: 'and', text: 'LENA VOSS', grade: 'orange' },
  { at: 8.1, over: '', text: 'TILES', logo: true, grade: 'blue' },
]
const IN = 0.55
const HOLD = 1.1
const OUT = 0.35

const surface = ref(null)
const video = ref(null)
const sound = ref(false)
const time = ref(0)
let audio = null
let rafId = 0
let lastCue = -1

const options = reactive({
  cell: 44,
  rate: 0.05,
  hold: 0.5,
  block: 0.35,
  offsetMax: 4,
  liftMax: 1.3,
  black: 0.9,
  shift: 1,
  lift: 0.6,
  decay: 4,
  lineAlpha: 0.16,
  lineGlow: 0.15,
  grade: 0.9,
  vignette: 0.45,
  ...GRADES.blue,
})

/** How far in each cue is, 0..1, from the clip's clock. */
const reveals = computed(() => CUES.map((cue) => {
  const t = time.value - cue.at
  if (t < 0) return 0
  const arrive = Math.min(t / IN, 1)
  const leave = Math.min(Math.max((t - IN - HOLD) / OUT, 0), 1)
  return cue.logo ? arrive : arrive * (1 - leave)
}))

function clock() {
  rafId = requestAnimationFrame(clock)
  const v = video.value
  if (!v) return
  time.value = v.currentTime
  // The cue that most recently began. Crossing into one is a cut: the grade
  // switches and the grid is knocked.
  let current = -1
  for (let i = 0; i < CUES.length; i++) if (v.currentTime >= CUES[i].at) current = i
  if (current !== lastCue) {
    lastCue = current
    if (current >= 0) {
      Object.assign(options, GRADES[CUES[current].grade])
      surface.value?.beat(CUES[current].logo ? 2.5 : 1.6)
    }
  }
}

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
  audio = attachAudio(engine, video.value, { gain: 1.2, drive: 0.4 })
  await audio.resume()
  video.value.muted = false
  if (video.value.paused) await video.value.play().catch(() => {})
  sound.value = true
}

onMounted(() => { rafId = requestAnimationFrame(clock) })
onBeforeUnmount(() => {
  cancelAnimationFrame(rafId)
  audio?.detach()
})
</script>

<template>
  <TileSurface ref="surface" :options="options">
    <div class="backdrop">
      <TileLayer>
        <video ref="video" class="reel" :src="reelUrl" autoplay muted loop playsinline crossorigin="anonymous"></video>
      </TileLayer>
    </div>

    <!-- Each credit sits in its own centred slot, and the layer wraps the
         credit itself: a layer measures its element, so the element has to
         be in normal flow, not fixed. -->
    <main class="stage">
      <div v-for="(cue, i) in CUES" :key="cue.text" class="slot">
        <TileLayer :reveal="reveals[i]" :sweep="cue.logo ? 0.85 : 0.6" :reveal-soft="cue.logo ? 0.04 : 0.1">
          <div class="credit" :class="{ 'is-logo': cue.logo }">
            <span v-if="cue.over" class="over">{{ cue.over }}</span>
            <span class="name">{{ cue.text }}</span>
          </div>
        </TileLayer>
      </div>
    </main>

    <!-- The reticle at the centre of the logo, and the letterbox: chrome, not
         content, so they sit over the canvas and the tiles never touch them. -->
    <svg class="reticle" :style="{ opacity: reveals[CUES.length - 1] }" viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r="14" fill="none" stroke="currentColor" stroke-width="1.2" />
      <circle cx="20" cy="20" r="7" fill="none" stroke="currentColor" stroke-width="1" />
      <circle cx="20" cy="20" r="2" fill="currentColor" />
    </svg>
    <div class="bar top"></div>
    <div class="bar bottom"></div>
  </TileSurface>

  <nav class="hud">
    <a class="badge btn" href="#/">home</a>
    <a class="badge btn" href="#/text">text</a>
    <a class="badge btn" href="#/video">video</a>
    <button class="badge btn" :class="{ on: sound }" @click="toggleSound">{{ sound ? 'sound on' : 'sound' }}</button>
    <button class="badge btn" @click="surface.beat(1.5)">beat</button>
  </nav>

  <p class="hint">the names arrive on the clip's clock · <b>sound</b> lets the beat knock the grid</p>
</template>

<style scoped>
.backdrop { position: fixed; inset: 0; z-index: 0; overflow: hidden; }
.reel { display: block; width: 100%; height: 100%; object-fit: cover; }
.stage { position: fixed; inset: 0; z-index: 1; pointer-events: none; }
.slot { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); }
.credit {
  display: flex; flex-direction: column; align-items: center; gap: 10px;
  text-align: center; white-space: nowrap;
  text-shadow: 0 2px 24px rgba(0, 0, 0, .7);
}
.over { font-size: clamp(11px, 1.3vw, 15px); font-weight: 500; letter-spacing: .5em; text-transform: uppercase; opacity: .85; }
.name { font-size: clamp(22px, 4vw, 46px); font-weight: 500; letter-spacing: .42em; text-transform: uppercase; padding-left: .42em; }
.is-logo .name { font-size: clamp(72px, 16vw, 220px); font-weight: 300; letter-spacing: .5em; padding-left: .5em; line-height: 1; }
.reticle {
  position: fixed; left: 50%; top: 50%; width: 44px; height: 44px; transform: translate(-50%, -50%);
  z-index: 3; color: #e8eef8; pointer-events: none;
}
.bar { position: fixed; left: 0; right: 0; height: 10svh; background: #000; z-index: 3; }
.bar.top { top: 0; }
.bar.bottom { bottom: 0; }
</style>
