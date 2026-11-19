<script setup>
import { reactive, ref } from 'vue'
import SandSurface from './SandSurface.vue'
import SandDistort from './SandDistort.vue'

const surface = ref(null)
const tweaking = ref(false)

// the knobs worth having at hand; everything else lives in DEFAULTS
const options = reactive({
  radius: 7,
  depth: 0.85,
  displace: 26,
  bury: 1.1,
  drag: 0.6,
  pickup: 0.35,
  scrape: 0.18,
  recovery: 0,
  sparkle: 1,
})

const controls = [
  { key: 'radius', label: 'stick', min: 1, max: 60, step: 0.5 },
  { key: 'depth', label: 'press', min: 0.1, max: 3, step: 0.05 },
  { key: 'displace', label: 'drag', min: 0, max: 90, step: 1 },
  { key: 'bury', label: 'bury', min: 0, max: 3, step: 0.05 },
  { key: 'drag', label: 'haul', min: 0, max: 1, step: 0.02 },
  { key: 'pickup', label: 'stir', min: 0, max: 1, step: 0.02 },
  { key: 'scrape', label: 'lift', min: 0, max: 1, step: 0.02 },
  { key: 'recovery', label: 'wind', min: 0, max: 0.4, step: 0.005 },
  { key: 'sparkle', label: 'glint', min: 0, max: 3, step: 0.05 },
]

const pages = [
  { href: './text.html', label: 'text' },
  { href: './text-distortion.html', label: 'distortion' },
  { href: './login.html', label: 'login card' },
  { href: './colour.html', label: 'colour' },
  { href: './image.html', label: 'image' },
  { href: './video.html', label: 'video' },
]
</script>

<template>
  <SandSurface ref="surface" :options="options">
  <main class="page">
    <SandDistort><p class="kicker">rust &middot; wasm &middot; webgl2</p></SandDistort>
    <SandDistort><h1 class="display">web&#8209;sand</h1></SandDistort>
    <SandDistort>
      <p class="lede">
        Move the cursor. The grains under it are pushed aside, piled along the
        rim of the groove, and left to slump until nothing stands steeper than
        sand can stand. Drag faster and the sand is thrown further ahead of the
        stick; hold the button down and it presses in deeper. Whatever is
        already written in the sand is dragged along with it.
      </p>
    </SandDistort>
    <SandDistort>
      <nav class="pages">
        <a v-for="page in pages" :key="page.href" class="page-link" :href="page.href">{{ page.label }}</a>
      </nav>
    </SandDistort>
  </main>
  </SandSurface>

  <div class="hud">
    <button class="badge btn" @click="tweaking = !tweaking">{{ tweaking ? 'close' : 'tune' }}</button>
    <button class="badge btn" @click="surface.reset()">smooth over</button>
  </div>

  <div v-if="tweaking" class="panel">
    <label v-for="control in controls" :key="control.key" class="control">
      <span class="control-label">{{ control.label }}</span>
      <input
        v-model.number="options[control.key]"
        type="range"
        :min="control.min"
        :max="control.max"
        :step="control.step"
      />
      <span class="control-value">{{ options[control.key] }}</span>
    </label>
  </div>

  <p class="hint">run a stick through it</p>
</template>

<style scoped>
.page {
  position: relative; z-index: 1; height: 100svh;
  max-width: 1100px; margin: 0 auto; padding: 0 24px;
  display: flex; flex-direction: column; justify-content: center; gap: 18px;
}
.kicker { margin: 0; font-size: 11px; font-weight: 700; letter-spacing: .28em; text-transform: uppercase; opacity: .62; }
.display { margin: 0; font-size: clamp(56px, 13vw, 168px); font-weight: 800; letter-spacing: -.045em; line-height: .9; }
.lede { margin: 0; max-width: 46ch; font-size: clamp(15px, 1.8vw, 20px); line-height: 1.55; }

.pages { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 8px; }
.page-link {
  font-size: 12px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase;
  text-decoration: none; color: #2f2417; white-space: nowrap;
  padding: 10px 14px; border: 1.5px solid rgba(47, 36, 23, .35); border-radius: 5px;
}
.page-link:hover { background: rgba(47, 36, 23, .08); }

.hud { position: fixed; top: 16px; right: 16px; z-index: 3; display: flex; gap: 8px; }

.panel {
  position: fixed; top: 56px; right: 16px; z-index: 3; width: 246px;
  display: flex; flex-direction: column; gap: 10px;
  padding: 14px; border-radius: 6px; background: rgba(38, 28, 16, .9);
}
.control { display: grid; grid-template-columns: 44px 1fr 44px; align-items: center; gap: 8px; }

</style>
