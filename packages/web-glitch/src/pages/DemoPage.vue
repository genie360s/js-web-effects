<script setup>
// One page per thing the glitch is supposed to sit over, so each can be
// looked at on its own: a photograph, a video, live text, a working form.
import { ref } from 'vue'
import GlitchSurface from '../components/GlitchSurface.vue'
import { STYLES } from '../sim/params.js'
import photoUrl from '../../../../test_assets/portrait.png'
import reelUrl from '../../../../test_assets/elephant_video.mp4'

const props = defineProps({
  kind: { type: String, required: true }, // image | video | text | styles | login
  title: { type: String, required: true },
  hint: { type: String, default: 'move across it' },
})

const surfaces = ref([])
const shown = ref(true)
const cutout = ref(false)
const signedIn = ref(false)
const email = ref('')

const each = (fn) => surfaces.value.forEach((s) => s && fn(s))
const keep = (i) => (el) => { surfaces.value[i] = el }

function replay() {
  shown.value = false
  setTimeout(() => { shown.value = true }, 1100)
}
</script>

<template>
  <main class="stage">
    <template v-if="kind === 'image'">
      <GlitchSurface :ref="keep(0)" class="fit" :options="{ cutout, labels: 0.3 }" :visible="shown">
        <img class="frame" :src="photoUrl" alt="A painted portrait, arriving in blocks" />
      </GlitchSurface>
      <p class="caption">
        The border says what the background is, so the blocks find the subject and bring it in first.
        <button class="badge btn" :class="{ on: cutout }" @click="cutout = !cutout">cutout</button>
        leaves the background out for good.
      </p>
    </template>

    <template v-else-if="kind === 'video'">
      <GlitchSurface :ref="keep(0)" class="fit" :options="{ key: 'none', cell: 18, glitch: 0.06, burstRate: 0.15 }" :visible="shown">
        <video class="frame wide" :src="reelUrl" autoplay muted loop playsinline></video>
      </GlitchSurface>
      <p class="caption">Still playing in the blocks. With <code>key: 'none'</code> the whole frame is the subject.</p>
    </template>

    <template v-else-if="kind === 'text'">
      <GlitchSurface :ref="keep(0)" :options="{ cell: 8, labels: 0 }" :visible="shown">
        <h1 class="display">Signal acquired</h1>
      </GlitchSurface>
      <GlitchSurface :ref="keep(1)" :options="{ cell: 6, speed: 0.45, labels: 0, burstRate: 0.05 }" :visible="shown">
        <p class="body">
          Live DOM: a real paragraph, in the page, with a real
          <a href="#/text">link</a> and real <strong>bold</strong> in it. The letters are
          the subject, so the blocks follow the words rather than the box they sit in.
        </p>
      </GlitchSurface>
      <GlitchSurface :ref="keep(2)" class="fit" :options="{ key: 'none', cell: 12, speed: 0.5 }" :visible="shown">
        <div class="card">
          <span class="card-tag">component</span>
          <p class="card-text">A card with a background. With <code>key: 'none'</code> the whole box arrives, not just its ink.</p>
        </div>
      </GlitchSurface>
    </template>

    <!-- The same picture resting in each rendering. A burst flicks through
         the others and comes back to its own. -->
    <template v-else-if="kind === 'styles'">
      <div class="row">
        <figure v-for="(style, i) in STYLES" :key="style" class="swatch">
          <GlitchSurface :ref="keep(i)" :options="{ style, cutout: true, cell: 9, burstRate: 0.04, glitch: 0.03 }" :visible="shown">
            <img class="tile" :src="photoUrl" alt="" />
          </GlitchSurface>
          <figcaption>{{ style }}</figcaption>
        </figure>
      </div>
    </template>

    <!-- The card keeps working: the real inputs are still there, focusable
         and typeable, and every keystroke is re-rasterised into the blocks. -->
    <GlitchSurface v-else :ref="keep(0)" class="fit" :options="{ key: 'none', cell: 11, glitch: 0.05 }" :visible="shown">
      <form class="login" @submit.prevent="signedIn = true">
        <h1 class="login-title">Welcome back</h1>
        <p class="login-sub">Sign in, through the noise.</p>

        <label class="field">
          <span class="field-label">Email</span>
          <input v-model="email" type="email" name="email" placeholder="you@example.com" autocomplete="off" />
        </label>

        <label class="field">
          <span class="field-label">Password</span>
          <input type="password" name="password" placeholder="••••••••" autocomplete="off" />
        </label>

        <button class="submit" type="submit">{{ signedIn ? `Signed in as ${email || 'you'}` : 'Sign in' }}</button>
      </form>
    </GlitchSurface>
  </main>

  <nav class="hud">
    <span class="badge">{{ title }}</span>
    <a class="badge btn" href="#/">home</a>
    <a v-if="kind !== 'image'" class="badge btn" href="#/image">image</a>
    <a v-if="kind !== 'video'" class="badge btn" href="#/video">video</a>
    <a v-if="kind !== 'text'" class="badge btn" href="#/text">text</a>
    <a v-if="kind !== 'styles'" class="badge btn" href="#/styles">styles</a>
    <a v-if="kind !== 'login'" class="badge btn" href="#/login">login</a>
    <button class="badge btn" @click="replay">replay</button>
    <button class="badge btn" :class="{ on: !shown }" @click="shown = !shown">{{ shown ? 'hide' : 'reveal' }}</button>
    <button class="badge btn" @click="each((s) => s.burst(1.5))">burst</button>
  </nav>

  <p class="hint">{{ hint }}</p>
</template>

<style scoped>
.stage {
  min-height: 100svh;
  display: flex; flex-direction: column; justify-content: center; align-items: center;
  gap: 26px; padding: 96px 24px 104px;
}
.fit { width: fit-content; }
.frame { display: block; width: auto; height: min(62svh, 86vw); aspect-ratio: 1; }
.frame.wide { height: auto; width: min(960px, 88vw); aspect-ratio: 16 / 9; }
.caption { margin: 0; max-width: 64ch; text-align: center; font-size: 13px; line-height: 1.9; letter-spacing: .03em; opacity: .75; }
.caption code { font-size: 12px; }
.display {
  margin: 0; text-align: center; font-size: clamp(36px, 7.5vw, 96px); font-weight: 700;
  letter-spacing: .08em; line-height: 1; text-transform: uppercase;
}
.body { margin: 0; max-width: 56ch; font-size: clamp(14px, 1.5vw, 17px); line-height: 1.75; text-align: center; }
.card {
  width: min(420px, 82vw); padding: 20px; border-radius: 3px;
  background: #e6edf3; color: #0a0e14;
  display: flex; flex-direction: column; gap: 10px;
}
.card-tag { font-size: 10px; font-weight: 700; letter-spacing: .22em; text-transform: uppercase; opacity: .55; }
.card-text { margin: 0; font-size: 14px; line-height: 1.6; }
.card-text code { font-size: 13px; }
.row { display: flex; flex-wrap: wrap; gap: 22px; justify-content: center; }
.swatch { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 12px; }
.swatch figcaption { font-size: 11px; letter-spacing: .2em; text-transform: uppercase; opacity: .7; }
.tile { display: block; width: min(300px, 40vw); height: auto; aspect-ratio: 1; }

.login {
  width: min(380px, 86vw); padding: 30px 28px 26px; border-radius: 3px;
  background: #e6edf3; color: #0a0e14;
  display: flex; flex-direction: column; gap: 14px;
}
.login-title { margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -.01em; }
.login-sub { margin: 0 0 4px; font-size: 13px; line-height: 1.5; opacity: .7; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: 11px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; opacity: .6; }
.field input {
  font: inherit; font-size: 14px; padding: 11px 12px; color: #0a0e14;
  background: #fff; border: 1px solid #b9c4d0; border-radius: 2px; outline: none;
}
.field input:focus { border-color: #2f6f9f; box-shadow: 0 0 0 3px rgba(47, 111, 159, .25); }
.submit {
  margin-top: 4px; font: inherit; font-weight: 700; font-size: 14px;
  padding: 12px 14px; border: none; border-radius: 2px; cursor: pointer;
  color: #e6edf3; background: #0a0e14;
}
.submit:hover { background: #1c2733; }
</style>
