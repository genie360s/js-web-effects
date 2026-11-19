<script setup>
// One page per thing the sand is supposed to distort, so each can be looked at
// on its own: live DOM text, a working login card, a photograph, a video.
import { reactive, ref } from 'vue'
import SandSurface from './SandSurface.vue'
import SandDistort from './SandDistort.vue'
import photoUrl from '../../../test_assets/portrait.png'
import reelUrl from '../../../test_assets/elephant_video.mp4'

const props = defineProps({
  kind: { type: String, required: true }, // text | login | colour | image | video | distortion
  title: { type: String, required: true },
  hint: { type: String, default: 'run a stick through it' },
})

const tests = [
  { id: 'text', href: './text.html', label: 'text' },
  { id: 'distortion', href: './text-distortion.html', label: 'distortion' },
  { id: 'login', href: './login.html', label: 'login' },
  { id: 'colour', href: './colour.html', label: 'colour' },
  { id: 'image', href: './image.html', label: 'image' },
  { id: 'video', href: './video.html', label: 'video' },
]

const swatches = [
  { name: 'shell', hex: '#f4ece0', ink: '#2f2417' },
  { name: 'kelp', hex: '#3f5d4a', ink: '#eef3ea' },
  { name: 'tide', hex: '#2f6f86', ink: '#eaf4f7' },
  { name: 'coral', hex: '#c4593f', ink: '#fdeee9' },
]

const surface = ref(null)

// The distortion page drives these live; every other page leaves the surface on
// its own defaults. Built once, because the surface watches this object deeply
// and a fresh one on each render would re-apply the parameters every time.
const options = props.kind === 'distortion' ? reactive({ warp: 16, displace: 26 }) : {}
const signedIn = ref(false)
const email = ref('')
</script>

<template>
  <SandSurface ref="surface" :options="options">
  <main class="stage">
    <template v-if="kind === 'text'">
      <SandDistort><h1 class="display">Sharp type, soft sand</h1></SandDistort>
      <SandDistort>
        <p class="body">
          Live DOM: this is a real paragraph, in the page, with a real
          <a href="#">link</a> and real <strong>bold</strong> in it. It is
          rasterised once, then pushed around by the surface underneath.
        </p>
      </SandDistort>
      <SandDistort>
        <div class="card">
          <span class="card-tag">component</span>
          <p class="card-text">Background colour, radius, shadow — all of it goes with the grain.</p>
        </div>
      </SandDistort>
    </template>

    <!-- The card keeps working: the real inputs are still there, focusable and
         typeable, and every keystroke is re-rasterised onto the sand. -->
    <SandDistort v-else-if="kind === 'login'" :bury="1.4">
      <form class="login" @submit.prevent="signedIn = true">
        <h1 class="login-title">Welcome back</h1>
        <p class="login-sub">Sign in to keep your place on the beach.</p>

        <label class="field">
          <span class="field-label">Email</span>
          <input v-model="email" type="email" name="email" placeholder="alexgmkwizu@gmail.com" autocomplete="off" />
        </label>

        <label class="field">
          <span class="field-label">Password</span>
          <input type="password" name="password" placeholder="••••••••" autocomplete="off" />
        </label>

        <label class="remember">
          <input type="checkbox" name="remember" />
          <span>Keep me signed in</span>
        </label>

        <button class="submit" type="submit">{{ signedIn ? `Signed in as ${email || 'you'}` : 'Sign in' }}</button>
        <p class="login-foot"><a href="#">Forgot your password?</a></p>
      </form>
    </SandDistort>

    <!-- Everything here carries the same resting distortion: text, a component,
         a photograph and a playing video are all just content on the sand. -->
    <template v-else-if="kind === 'distortion'">
      <SandDistort><h1 class="display warped">Bent by the beach</h1></SandDistort>
      <div class="warp-row">
        <SandDistort>
          <div class="card small">
            <span class="card-tag">component</span>
            <p class="card-text">A card, warped by the ripples it is lying on.</p>
          </div>
        </SandDistort>
        <SandDistort :bury="1.6">
          <img class="tile" :src="photoUrl" alt="Portrait, bent by the sand beneath it" />
        </SandDistort>
        <SandDistort :bury="1.6">
          <video class="tile" :src="reelUrl" autoplay muted loop playsinline></video>
        </SandDistort>
      </div>
      <!-- Small text cannot take as much bending and stay readable. -->
      <SandDistort :warp="4">
        <p class="caption">The ripples bend whatever lies on them, before you touch
        anything. Drag the stick through it as well.</p>
      </SandDistort>
    </template>

    <template v-else-if="kind === 'colour'">
      <SandDistort><h1 class="display">It takes the colour with it</h1></SandDistort>
      <div class="swatches">
        <SandDistort v-for="swatch in swatches" :key="swatch.name">
          <article class="swatch" :style="{ background: swatch.hex, color: swatch.ink }">
            <span class="swatch-name">{{ swatch.name }}</span>
            <span class="swatch-hex">{{ swatch.hex }}</span>
          </article>
        </SandDistort>
      </div>
      <SandDistort>
        <p class="caption">Ordinary elements with ordinary backgrounds. Stir through one
        and its colour lifts off into the grains.</p>
      </SandDistort>
    </template>

    <template v-else-if="kind === 'image'">
      <SandDistort :bury="1.6">
        <img class="frame" :src="photoUrl" alt="Portrait, distorted by the sand beneath it" />
      </SandDistort>
      <SandDistort><p class="caption">One photograph, handed straight to the GPU. Drag across it.</p></SandDistort>
    </template>

    <template v-else>
      <SandDistort :bury="1.6">
        <video class="frame" :src="reelUrl" autoplay muted loop playsinline></video>
      </SandDistort>
      <SandDistort><p class="caption">Still playing while the sand drags it about.</p></SandDistort>
    </template>
  </main>
  </SandSurface>

  <div class="hud">
    <span class="badge">{{ title }}</span>
    <a
      v-for="test in tests.filter((t) => t.id !== kind)"
      :key="test.id"
      class="badge btn"
      :href="test.href"
    >{{ test.label }}</a>
    <a class="badge btn" href="./index.html">home</a>
    <button class="badge btn" @click="surface.reset()">smooth over</button>
  </div>

  <div v-if="kind === 'distortion'" class="panel">
    <label class="control">
      <span class="control-label">warp</span>
      <input v-model.number="options.warp" type="range" min="0" max="60" step="1" />
      <span class="control-value">{{ options.warp }}</span>
    </label>
    <label class="control">
      <span class="control-label">drag</span>
      <input v-model.number="options.displace" type="range" min="0" max="90" step="1" />
      <span class="control-value">{{ options.displace }}</span>
    </label>
  </div>

  <p class="hint">{{ hint }}</p>
</template>

<style scoped>
.stage {
  position: relative; z-index: 1; min-height: 100svh;
  display: flex; flex-direction: column; justify-content: center; align-items: center;
  gap: 22px; padding: 92px 24px 104px;
  overflow: hidden;
}
.display { margin: 0; max-width: 20ch; text-align: center; font-size: clamp(40px, 8vw, 96px); font-weight: 800; letter-spacing: -.04em; line-height: .95; }
.body { margin: 0; max-width: 44ch; font-size: clamp(16px, 2vw, 20px); line-height: 1.6; text-align: center; }
.body a { color: inherit; }
.card {
  width: min(420px, 82vw); padding: 20px; border-radius: 8px;
  background: #f4ece0; box-shadow: 0 10px 30px rgba(47, 36, 23, .18);
  display: flex; flex-direction: column; gap: 10px;
}
.card-tag { font-size: 10px; font-weight: 700; letter-spacing: .22em; text-transform: uppercase; opacity: .55; }
.card-text { margin: 0; font-size: 15px; line-height: 1.55; }
.frame {
  display: block; border-radius: 6px;
  width: auto; height: auto;
  max-width: min(620px, 86vw); max-height: 56svh;
}
.warp-row { display: flex; flex-wrap: wrap; gap: 16px; justify-content: center; align-items: center; }
.tile { display: block; border-radius: 6px; width: auto; height: auto; max-width: 30vw; max-height: 34svh; }
.card.small { width: min(300px, 78vw); }
.warped { font-size: clamp(36px, 6.5vw, 82px); }
.swatches { display: flex; flex-wrap: wrap; gap: 14px; justify-content: center; }
.swatch {
  width: 168px; height: 128px; padding: 14px; border-radius: 6px;
  display: flex; flex-direction: column; justify-content: space-between;
}
.swatch-name { font-weight: 700; letter-spacing: .04em; }
.swatch-hex { font-size: 12px; letter-spacing: .1em; opacity: .7; }
.caption { margin: 0; max-width: 44ch; text-align: center; font-size: 14px; letter-spacing: .02em; opacity: .75; }

.login {
  width: min(380px, 86vw); padding: 30px 28px 24px; border-radius: 12px;
  background: #fbf6ec; box-shadow: 0 18px 48px rgba(47, 36, 23, .22);
  display: flex; flex-direction: column; gap: 14px;
  color: #2f2417;
}
.login-title { margin: 0; font-size: 26px; font-weight: 800; letter-spacing: -.02em; }
.login-sub { margin: 0 0 4px; font-size: 14px; line-height: 1.5; opacity: .7; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: 11px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; opacity: .6; }
.field input {
  font: inherit; font-size: 15px; padding: 11px 12px; color: #2f2417;
  background: #fff; border: 1px solid #d9cbb2; border-radius: 6px; outline: none;
}
.field input:focus { border-color: #a88c63; box-shadow: 0 0 0 3px rgba(168, 140, 99, .25); }
.remember { display: flex; align-items: center; gap: 9px; font-size: 14px; white-space: nowrap; }
.remember input { width: 15px; height: 15px; accent-color: #a88c63; }
.submit {
  margin-top: 4px; font: inherit; font-weight: 700; font-size: 15px;
  padding: 12px 14px; border: none; border-radius: 6px; cursor: pointer;
  color: #fbf6ec; background: #2f2417;
}
.submit:hover { background: #4a3a26; }
.login-foot { margin: 2px 0 0; font-size: 13px; text-align: center; }
.login-foot a { color: inherit; opacity: .7; }

.hud { position: fixed; top: 16px; right: 16px; z-index: 3; display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
.panel {
  position: fixed; bottom: 54px; left: 50%; transform: translateX(-50%); z-index: 3;
  display: flex; gap: 18px; padding: 12px 16px; border-radius: 6px;
  background: rgba(38, 28, 16, .9);
}
.control { display: grid; grid-template-columns: 42px 130px 32px; align-items: center; gap: 8px; }

</style>
