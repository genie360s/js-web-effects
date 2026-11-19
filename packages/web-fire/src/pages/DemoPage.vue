<script setup>
// One page per thing the fire is supposed to burn, so each can be looked at
// on its own: live DOM text, a working login card, a photograph, a video.
import { ref } from 'vue'
import FireSurface from '../components/FireSurface.vue'
import FireLayer from '../components/FireLayer.vue'
import photoUrl from '../../../../test_assets/portrait.png'
import reelUrl from '../../../../test_assets/elephant_video.mp4'

const props = defineProps({
  kind: { type: String, required: true }, // text | login | image | video | all
  title: { type: String, required: true },
  hint: { type: String, default: 'drag across it to set it alight' },
})

const surface = ref(null)
const signedIn = ref(false)
const email = ref('')
</script>

<template>
  <FireSurface ref="surface">
    <main class="stage">
      <template v-if="kind === 'text'">
        <FireLayer><h1 class="display">Type that burns</h1></FireLayer>
        <FireLayer>
          <p class="body">
            Live DOM: a real paragraph, in the page, with a real
            <a href="#">link</a> and real <strong>bold</strong> in it. Only the
            ink is fuel — the space between the letters is air, and air does
            not catch.
          </p>
        </FireLayer>
        <FireLayer>
          <div class="card">
            <span class="card-tag">component</span>
            <p class="card-text">A card, with a background and a shadow. It chars, then it goes.</p>
          </div>
        </FireLayer>
      </template>

      <!-- The card keeps working: the real inputs are still there, focusable
           and typeable, and every keystroke is re-rasterised onto the fire. -->
      <FireLayer v-else-if="kind === 'login'" :fuel="1.1">
        <form class="login" @submit.prevent="signedIn = true">
          <h1 class="login-title">Welcome back</h1>
          <p class="login-sub">Sign in before it burns down.</p>

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
      </FireLayer>

      <template v-else-if="kind === 'image'">
        <FireLayer>
          <img class="frame" :src="photoUrl" alt="A portrait, burning" />
        </FireLayer>
        <FireLayer :fuel="0">
          <p class="caption">One photograph, handed straight to the GPU. Drag across it.</p>
        </FireLayer>
      </template>

      <template v-else-if="kind === 'video'">
        <FireLayer>
          <video class="frame" :src="reelUrl" autoplay muted loop playsinline></video>
        </FireLayer>
        <FireLayer :fuel="0">
          <p class="caption">Still playing while it burns through.</p>
        </FireLayer>
      </template>

      <!-- Everything at once: text, a component, a photograph and a playing
           video are all just things on a page that can catch. -->
      <template v-else>
        <FireLayer><h1 class="display small">All of it at once</h1></FireLayer>
        <div class="row">
          <FireLayer>
            <div class="card narrow">
              <span class="card-tag">component</span>
              <p class="card-text">A card and its shadow.</p>
            </div>
          </FireLayer>
          <FireLayer>
            <img class="tile" :src="photoUrl" alt="A portrait, burning" />
          </FireLayer>
          <FireLayer>
            <video class="tile" :src="reelUrl" autoplay muted loop playsinline></video>
          </FireLayer>
        </div>
        <FireLayer :fuel="0">
          <p class="caption">The caption is fireproof. Its fuel is set to zero.</p>
        </FireLayer>
      </template>
    </main>
  </FireSurface>

  <nav class="hud">
    <span class="badge">{{ title }}</span>
    <a class="badge btn" href="#/">home</a>
    <a v-if="kind !== 'text'" class="badge btn" href="#/text">text</a>
    <a v-if="kind !== 'login'" class="badge btn" href="#/login">login</a>
    <a v-if="kind !== 'image'" class="badge btn" href="#/image">image</a>
    <a v-if="kind !== 'video'" class="badge btn" href="#/video">video</a>
    <a v-if="kind !== 'all'" class="badge btn" href="#/all">all</a>
    <a class="badge btn" href="#/eternal">eternal</a>
    <button class="badge btn" @click="surface.reset()">put it out</button>
  </nav>

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
  width: min(420px, 82vw); padding: 20px; border-radius: 8px;
  background: #f3ece2; color: #221a13; box-shadow: 0 10px 30px rgba(0, 0, 0, .45);
  display: flex; flex-direction: column; gap: 10px;
}
.card.narrow { width: min(280px, 78vw); }
.card-tag { font-size: 10px; font-weight: 700; letter-spacing: .22em; text-transform: uppercase; opacity: .55; }
.card-text { margin: 0; font-size: 15px; line-height: 1.55; }
.frame { display: block; border-radius: 4px; width: auto; height: auto; max-width: min(620px, 86vw); max-height: 56svh; }
.row { display: flex; flex-wrap: wrap; gap: 18px; justify-content: center; align-items: center; }
.tile { display: block; border-radius: 4px; width: auto; height: auto; max-width: 30vw; max-height: 32svh; }
.caption { margin: 0; max-width: 46ch; text-align: center; font-size: 14px; letter-spacing: .02em; opacity: .7; }
.caption code { font-size: 13px; opacity: .85; }

.login {
  width: min(380px, 86vw); padding: 30px 28px 24px; border-radius: 12px;
  background: #f7f1e6; box-shadow: 0 18px 48px rgba(0, 0, 0, .5);
  display: flex; flex-direction: column; gap: 14px; color: #221a13;
}
.login-title { margin: 0; font-size: 26px; font-weight: 800; letter-spacing: -.02em; }
.login-sub { margin: 0 0 4px; font-size: 14px; line-height: 1.5; opacity: .7; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: 11px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; opacity: .6; }
.field input {
  font: inherit; font-size: 15px; padding: 11px 12px; color: #221a13;
  background: #fff; border: 1px solid #d8cbb6; border-radius: 6px; outline: none;
}
.field input:focus { border-color: #c2703a; box-shadow: 0 0 0 3px rgba(194, 112, 58, .25); }
.remember { display: flex; align-items: center; gap: 9px; font-size: 14px; white-space: nowrap; }
.remember input { width: 15px; height: 15px; accent-color: #c2703a; }
.submit {
  margin-top: 4px; font: inherit; font-weight: 700; font-size: 15px;
  padding: 12px 14px; border: none; border-radius: 6px; cursor: pointer;
  color: #f7f1e6; background: #221a13;
}
.submit:hover { background: #3d2f22; }
.login-foot { margin: 2px 0 0; font-size: 13px; text-align: center; }
.login-foot a { color: inherit; opacity: .7; }
</style>
