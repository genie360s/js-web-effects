<script setup>
// One page per thing the tiles are supposed to sit over, so each can be looked
// at on its own: live DOM text, a working login card, a photograph, a video.
import { ref } from 'vue'
import TileSurface from '../components/TileSurface.vue'
import TileLayer from '../components/TileLayer.vue'
import photoUrl from '../../../../test_assets/portrait.png'
import reelUrl from '../../../../test_assets/elephant_video.mp4'

const props = defineProps({
  kind: { type: String, required: true }, // text | login | image | video | all
  title: { type: String, required: true },
  hint: { type: String, default: 'move across it' },
})

const surface = ref(null)
const signedIn = ref(false)
const email = ref('')
const reveal = ref(1)
const sweep = ref(0.7)
const options = { grade: 0.6, vignette: 0.2 }
</script>

<template>
  <TileSurface ref="surface" :options="options">
    <main class="stage">
      <template v-if="kind === 'text'">
        <TileLayer :reveal="reveal" :sweep="sweep">
          <h1 class="display">Type under tiles</h1>
        </TileLayer>
        <TileLayer>
          <p class="body">
            Live DOM: a real paragraph, in the page, with a real
            <a href="#">link</a> and real <strong>bold</strong> in it. A tile
            that shifts carries the letters under it a few cells sideways; a
            tile that goes black takes them with it.
          </p>
        </TileLayer>
        <TileLayer :reveal="reveal" :sweep="0">
          <div class="card">
            <span class="card-tag">component</span>
            <p class="card-text">A card, with a background and a shadow, revealed by lottery rather than by wipe.</p>
          </div>
        </TileLayer>
      </template>

      <!-- The card keeps working: the real inputs are still there, focusable
           and typeable, and every keystroke is re-rasterised under the tiles. -->
      <TileLayer v-else-if="kind === 'login'">
        <form class="login" @submit.prevent="signedIn = true">
          <h1 class="login-title">Welcome back</h1>
          <p class="login-sub">Sign in, through the grid.</p>

          <label class="field">
            <span class="field-label">Email</span>
            <input v-model="email" type="email" name="email" placeholder="you@example.com" autocomplete="off" />
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
      </TileLayer>

      <template v-else-if="kind === 'image'">
        <TileLayer>
          <img class="frame" :src="photoUrl" alt="A portrait, under the tiles" />
        </TileLayer>
        <TileLayer :tiles="false">
          <p class="caption">One photograph, handed straight to the GPU. Move across it.</p>
        </TileLayer>
      </template>

      <template v-else-if="kind === 'video'">
        <TileLayer>
          <video class="frame" :src="reelUrl" autoplay muted loop playsinline></video>
        </TileLayer>
        <TileLayer :tiles="false">
          <p class="caption">Still playing under the tiles.</p>
        </TileLayer>
      </template>

      <!-- Everything at once: text, a component, a photograph and a playing
           video are all just things on a page under one grid. -->
      <template v-else>
        <TileLayer><h1 class="display small">All of it at once</h1></TileLayer>
        <div class="row">
          <TileLayer>
            <div class="card narrow">
              <span class="card-tag">component</span>
              <p class="card-text">A card and its shadow.</p>
            </div>
          </TileLayer>
          <TileLayer>
            <img class="tile" :src="photoUrl" alt="A portrait, under the tiles" />
          </TileLayer>
          <TileLayer>
            <video class="tile" :src="reelUrl" autoplay muted loop playsinline></video>
          </TileLayer>
        </div>
        <TileLayer :tiles="false">
          <p class="caption">The caption is <code>:tiles="false"</code>. The grid leaves it alone.</p>
        </TileLayer>
      </template>
    </main>
  </TileSurface>

  <nav class="hud">
    <span class="badge">{{ title }}</span>
    <a class="badge btn" href="#/">home</a>
    <a class="badge btn" href="#/titles">titles</a>
    <a v-if="kind !== 'text'" class="badge btn" href="#/text">text</a>
    <a v-if="kind !== 'login'" class="badge btn" href="#/login">login</a>
    <a v-if="kind !== 'image'" class="badge btn" href="#/image">image</a>
    <a v-if="kind !== 'video'" class="badge btn" href="#/video">video</a>
    <a v-if="kind !== 'all'" class="badge btn" href="#/all">all</a>
    <button class="badge btn" @click="surface.beat(1.5)">beat</button>
    <button class="badge btn" @click="surface.reset()">settle</button>
  </nav>

  <aside v-if="kind === 'text'" class="panel">
    <label class="control">
      <span class="control-label">reveal</span>
      <input v-model.number="reveal" type="range" min="0" max="1" step="0.01" />
      <span class="control-value">{{ reveal }}</span>
    </label>
    <label class="control">
      <span class="control-label">sweep</span>
      <input v-model.number="sweep" type="range" min="0" max="1" step="0.05" />
      <span class="control-value">{{ sweep }}</span>
    </label>
  </aside>

  <p class="hint">{{ hint }}</p>
</template>

<style scoped>
.stage {
  position: relative; z-index: 1; min-height: 100svh;
  display: flex; flex-direction: column; justify-content: center; align-items: center;
  gap: 26px; padding: 96px 24px 104px;
}
.display { margin: 0; max-width: 18ch; text-align: center; font-size: clamp(42px, 9vw, 104px); font-weight: 800; letter-spacing: -.04em; line-height: .95; }
.display.small { font-size: clamp(32px, 6vw, 68px); }
.body { margin: 0; max-width: 44ch; font-size: clamp(16px, 2vw, 20px); line-height: 1.6; text-align: center; }
.body a { color: inherit; }
.card {
  width: min(420px, 82vw); padding: 20px; border-radius: 6px;
  background: #e9eef8; color: #0b1428; box-shadow: 0 10px 30px rgba(0, 0, 0, .45);
  display: flex; flex-direction: column; gap: 10px;
}
.card.narrow { width: min(280px, 78vw); }
.card-tag { font-size: 10px; font-weight: 700; letter-spacing: .22em; text-transform: uppercase; opacity: .55; }
.card-text { margin: 0; font-size: 15px; line-height: 1.55; }
.frame { display: block; border-radius: 2px; width: auto; height: auto; max-width: min(720px, 88vw); max-height: 60svh; }
.row { display: flex; flex-wrap: wrap; gap: 18px; justify-content: center; align-items: center; }
.tile { display: block; border-radius: 2px; width: auto; height: auto; max-width: 30vw; max-height: 32svh; }
.caption { margin: 0; max-width: 46ch; text-align: center; font-size: 14px; letter-spacing: .02em; opacity: .7; }
.caption code { font-size: 13px; opacity: .85; }

.login {
  width: min(380px, 86vw); padding: 30px 28px 24px; border-radius: 8px;
  background: #eef2fa; box-shadow: 0 18px 48px rgba(0, 0, 0, .5);
  display: flex; flex-direction: column; gap: 14px; color: #0b1428;
}
.login-title { margin: 0; font-size: 26px; font-weight: 800; letter-spacing: -.02em; }
.login-sub { margin: 0 0 4px; font-size: 14px; line-height: 1.5; opacity: .7; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: 11px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; opacity: .6; }
.field input {
  font: inherit; font-size: 15px; padding: 11px 12px; color: #0b1428;
  background: #fff; border: 1px solid #c3cde0; border-radius: 4px; outline: none;
}
.field input:focus { border-color: #3b6fd8; box-shadow: 0 0 0 3px rgba(59, 111, 216, .25); }
.remember { display: flex; align-items: center; gap: 9px; font-size: 14px; white-space: nowrap; }
.remember input { width: 15px; height: 15px; accent-color: #3b6fd8; }
.submit {
  margin-top: 4px; font: inherit; font-weight: 700; font-size: 15px;
  padding: 12px 14px; border: none; border-radius: 4px; cursor: pointer;
  color: #eef2fa; background: #0b1428;
}
.submit:hover { background: #1c2b4d; }
.login-foot { margin: 2px 0 0; font-size: 13px; text-align: center; }
.login-foot a { color: inherit; opacity: .7; }
</style>
