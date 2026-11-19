<script setup>
// Things that are on fire and stay on fire.
//
// Two ideas, and both are geometry rather than a special case.
//
// The first is `fuelSupply`: fuel replaced as fast as the flame takes it,
// which is what a gas ring is, and why you can run one under a kettle all day
// without losing the kettle. At zero a layer is a sheet of paper and the fire
// eats it; turned up, what is burning was never the surface.
//
// The second is what actually makes this readable. Each item is wrapped in a
// layer with `:fuel="0"` — it cannot catch, so it cannot char and cannot be
// burnt through — and the thing that *is* alight is a thin strip tucked under
// its bottom edge. That matters more than it sounds. Given endless fuel and
// no damage, a fire spreads over every cell of fuel it can reach and then
// stays there, so an item that is itself combustible ends up uniformly
// ablaze, and a flame as wide as the card is a sheet of light with the card
// somewhere behind it. Burning a burner instead gives tongues of flame coming
// off the bottom edge, and the item stays legible: on fire, and still there.
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import FireSurface from '../components/FireSurface.vue'
import FireLayer from '../components/FireLayer.vue'
import photoUrl from '../../../../test_assets/portrait.png'
import reelUrl from '../../../../test_assets/elephant_video.mp4'

const surface = ref(null)
const stage = ref(null)
const email = ref('')
const signedIn = ref(false)

const options = reactive({
  // The gas. Everything else on this page is an ordinary fire.
  fuelSupply: 14,
  charRate: 0,
  // The burners are small, so the scene is small: at this scale a card is
  // about a hand's width and the flames are the size flames are.
  scene: 0.5,
  windX: 0,
  gust: 0.5,
  turbulence: 16,
  sootYield: 6,
  // Soot that thins out quickly keeps the luminous part of the flame short,
  // so it licks over the item instead of reaching the top of the window.
  sootDecay: 2.2,
  flameFeedback: 900,
  haze: 22,
  exposure: 1.3,
  emberSize: 2.6,
  smoke: 0.3,
})

/** Every strip that is a burner. */
function burners() {
  return stage.value ? [...stage.value.querySelectorAll('[data-burner]')] : []
}

/**
 * A pilot light along each burner: a small flame that is always there, which
 * is what a pilot light is.
 *
 * It does not check whether anything is alight first. An earlier version only
 * struck the match when the whole grid had gone quiet, and the result was that
 * the first burner to catch kept the grid busy forever and none of the others
 * were ever lit. Being always on also covers the cases that wipe the fire
 * deliberately — a window resize, a change of quality tier — without having
 * to know anything about them.
 *
 * The heat is low: enough to hold the strip above its pyrolysis threshold,
 * far too little to be the flame you can see.
 */
function pilotLight() {
  const fire = surface.value
  if (!fire) return
  for (const el of burners()) {
    const r = el.getBoundingClientRect()
    if (!r.width || r.bottom < 0 || r.top > window.innerHeight) continue
    const steps = Math.min(3, Math.max(1, Math.round(r.width / 80)))
    for (let i = 0; i <= steps; i++) {
      fire.ignite({
        clientX: r.left + (i / steps) * r.width,
        clientY: r.top + r.height / 2,
        radius: 11,
        heat: 900,
      })
    }
  }
}

let pilot = 0
onMounted(() => { pilot = setInterval(pilotLight, 700) })
onBeforeUnmount(() => clearInterval(pilot))
</script>

<template>
  <FireSurface ref="surface" :options="options">
    <!-- Everything sits low on purpose. Flames go up, so the room above them
         has to be empty or each item is behind the one below it. -->
    <main ref="stage" class="stage">
      <!-- text -->
      <div class="piece">
        <FireLayer :fuel="0"><h1 class="display">Type on fire</h1></FireLayer>
        <FireLayer invisible class="burner-slot"><div data-burner class="burner wide" /></FireLayer>
      </div>

      <div class="row">
        <!-- an ordinary html component, still working -->
        <div class="piece">
          <FireLayer :fuel="0">
            <form class="card" @submit.prevent="signedIn = true">
              <span class="card-tag">component</span>
              <label class="field">
                <span class="field-label">Email</span>
                <input v-model="email" type="email" name="email" placeholder="you@example.com" autocomplete="off" />
              </label>
              <button class="submit" type="submit">
                {{ signedIn ? `Signed in as ${email || 'you'}` : 'Sign in while it burns' }}
              </button>
            </form>
          </FireLayer>
          <FireLayer invisible class="burner-slot"><div data-burner class="burner" /></FireLayer>
        </div>

        <!-- image -->
        <div class="piece">
          <FireLayer :fuel="0">
            <img class="tile" :src="photoUrl" alt="A portrait, alight but unharmed" />
          </FireLayer>
          <FireLayer invisible class="burner-slot"><div data-burner class="burner" /></FireLayer>
        </div>

        <!-- video, still playing -->
        <div class="piece">
          <FireLayer :fuel="0">
            <video class="tile" :src="reelUrl" autoplay muted loop playsinline></video>
          </FireLayer>
          <FireLayer invisible class="burner-slot"><div data-burner class="burner" /></FireLayer>
        </div>

        <!-- any element at all -->
        <div class="piece">
          <FireLayer :fuel="0">
            <div class="chips">
              <span class="chip">button</span>
              <span class="chip">badge</span>
              <span class="chip">chip</span>
            </div>
          </FireLayer>
          <FireLayer invisible class="burner-slot"><div data-burner class="burner" /></FireLayer>
        </div>
      </div>

      <FireLayer :fuel="0">
        <p class="lede">
          Alight, and staying that way: the fuel is replaced as fast as the
          flame takes it, and nothing is recording damage. What is burning is a
          strip tucked under each one. Everything above it is fuel zero, and
          cannot catch at all.
        </p>
      </FireLayer>
    </main>
  </FireSurface>

  <nav class="hud">
    <span class="badge">eternal</span>
    <a class="badge btn" href="#/">home</a>
    <a class="badge btn" href="#/text">text</a>
    <a class="badge btn" href="#/login">login</a>
    <a class="badge btn" href="#/image">image</a>
    <a class="badge btn" href="#/video">video</a>
    <a class="badge btn" href="#/all">all</a>
  </nav>

  <aside class="panel">
    <label class="control">
      <span class="control-label" title="1/s that spent fuel is replaced">gas</span>
      <input v-model.number="options.fuelSupply" type="range" min="0" max="20" step="0.5" />
      <span class="control-value">{{ options.fuelSupply }}</span>
    </label>
    <label class="control">
      <span class="control-label" title="soot per unit burned, which is the yellow">soot</span>
      <input v-model.number="options.sootYield" type="range" min="0" max="16" step="0.5" />
      <span class="control-value">{{ options.sootYield }}</span>
    </label>
    <label class="control">
      <span class="control-label" title="m/s across the screen">wind</span>
      <input v-model.number="options.windX" type="range" min="-6" max="6" step="0.1" />
      <span class="control-value">{{ options.windX }}</span>
    </label>
  </aside>

  <p class="hint">turn the gas to 0 and the burners go out — the items were never fuel</p>
</template>

<style scoped>
.stage {
  position: relative; z-index: 1; min-height: 100svh;
  display: flex; flex-direction: column; justify-content: flex-end; align-items: center;
  gap: 22px; padding: 64px 24px 92px;
}
.row { display: flex; flex-wrap: wrap; gap: 24px; justify-content: center; align-items: flex-end; }

/* An item, and the burner under it. The strip overlaps the bottom edge, so
   the flames come off the item rather than out of a gap below it. */
.piece { display: flex; flex-direction: column; align-items: center; }
/* The layer wrapper spans the item; without it the column's shrink-to-fit
   leaves the strip's percentage width resolving against its own zero. */
.burner-slot { align-self: stretch; display: flex; justify-content: center; }
.burner {
  /* How tall this strip is, relative to the item over it, is what decides how
     big the flames look — a flame is about as tall as its burner is wide, and
     the solver is working in metres either way.
     The colour only has to be opaque: what the fuel map reads is the alpha,
     and the layer is `invisible`, so this is never drawn. Page-background
     black rather than anything brighter, so a browser with no WebGL2 shows an
     ordinary page instead of a row of orange bars. */
  width: 70%; height: 13px; margin-top: -8px;
  background: #0b0908;
}
.burner.wide { width: 84%; height: 16px; }

.display {
  margin: 0; font-size: clamp(32px, 6vw, 68px); font-weight: 800;
  letter-spacing: -.045em; line-height: 1; text-align: center;
}

.card {
  width: min(320px, 86vw); padding: 14px; border-radius: 10px;
  background: #f5efe4; color: #221a13; box-shadow: 0 14px 38px rgba(0, 0, 0, .5);
  display: flex; flex-direction: column; gap: 12px;
}
.card-tag { font-size: 10px; font-weight: 700; letter-spacing: .22em; text-transform: uppercase; opacity: .5; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: 11px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; opacity: .6; }
.field input {
  font: inherit; font-size: 15px; padding: 10px 12px; color: #221a13;
  background: #fff; border: 1px solid #d8cbb6; border-radius: 6px; outline: none;
}
.field input:focus { border-color: #c2703a; box-shadow: 0 0 0 3px rgba(194, 112, 58, .25); }
.submit {
  font: inherit; font-weight: 700; font-size: 14px; padding: 11px 14px;
  border: none; border-radius: 6px; cursor: pointer; color: #f5efe4; background: #221a13;
}
.submit:hover { background: #3d2f22; }

.tile { display: block; border-radius: 6px; width: auto; height: auto; max-width: 18vw; max-height: 15svh; }

.chips {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  padding: 12px; border-radius: 10px; border: 1px solid rgba(241, 236, 228, .18);
}
.chip {
  padding: 7px 12px; border-radius: 999px; font-size: 12px; font-weight: 600;
  letter-spacing: .06em; background: rgba(241, 236, 228, .12);
}

.lede {
  margin: 0; max-width: 58ch; text-align: center;
  font-size: clamp(13px, 1.4vw, 15px); line-height: 1.6; opacity: .75;
}

.panel {
  position: fixed; left: 16px; bottom: 16px; z-index: 4;
  display: flex; flex-direction: column; gap: 8px;
  padding: 14px 16px; border-radius: 8px;
  background: rgba(14, 10, 8, .86); backdrop-filter: blur(6px);
}
.control { display: grid; grid-template-columns: 50px 130px 34px; align-items: center; gap: 9px; }
.control-label { font-size: 11px; letter-spacing: .1em; text-transform: uppercase; opacity: .7; }
.control-value { font-size: 11px; text-align: right; opacity: .8; font-variant-numeric: tabular-nums; }
</style>
