<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import OilCanvas from '../components/OilCanvas.vue'
import portraitUrl from '../../../../test_assets/portrait.png?url'
import elephantUrl from '../../../../test_assets/elephant_video.mp4?url'

/**
 * A picture laid into the paint.
 *
 * A still is laid once, thickly, and then it is simply paint — drag it and it
 * smears and mixes like anything else on the canvas. A moving picture is laid a
 * little at a time, every frame, which is the interesting one: it reads as
 * someone re-painting the same picture over and over, so a smear survives for a
 * moment and is then gradually painted back in.
 */
const surface = ref(null)
const video = ref(null)
/** 'photograph' or 'video'. Two cases do not need a registry. */
const chosen = ref('photograph')
const wetness = ref(0.55)
/** How much paint the moving picture lays per second. A rate, not a per-frame
 *  amount: tied to frames it would repaint twice as fast on a 120Hz panel as on
 *  a 60Hz one, which is the same mistake the brush's flow avoids. Low enough
 *  that a smear lasts a moment and the solver has time to bleed and level
 *  between frames — laid too fast and the picture is simply redrawn and never
 *  behaves as paint at all. */
const repaint = ref(11)
/** How much the paint's thickness follows the picture's own lightness. */
const relief = ref(0.7)
const stats = ref(null)
const ready = ref(false)
const note = ref('')

const image = new Image()
image.src = portraitUrl
let raf = 0
let last = 0
/** Which `start()` owns the loop. An `await` in the middle of it means two can
 *  be in flight at once, and the later one has to win. */
let run = 0
let relayPending = 0

/** Lay the still, once it and the core are both there. */
function layImage() {
  // Not while the video is running: a 687kB portrait can finish decoding well
  // after the switch, and would then be stamped straight over the playback.
  if (!ready.value || !image.complete || chosen.value === 'video') return
  surface.value?.paintFrame(image, 3.2, relief.value)
}
image.addEventListener('load', layImage)

function loop(now) {
  raf = requestAnimationFrame(loop)
  const el = video.value
  // readyState 2 is the first frame; before that there is nothing to draw and
  // drawImage would throw.
  if (chosen.value !== 'video' || !el || el.readyState < 2) {
    last = now
    return
  }
  // Clamped: a tab that was in the background hands back one enormous step,
  // which would repaint the whole picture in a single frame.
  const dt = Math.min((now - last) / 1000, 1 / 20)
  last = now
  if (dt > 0) surface.value?.paintFrame(el, repaint.value * dt, relief.value)
}

async function start() {
  const mine = ++run
  cancelAnimationFrame(raf)
  raf = 0
  note.value = ''
  surface.value?.clear()
  if (chosen.value !== 'video') {
    layImage()
    return
  }
  // The element is only rendered in video mode, so wait for it to exist.
  await nextTick()
  // Another start(), or an unmount, happened while we were waiting.
  if (mine !== run) return
  try {
    await video.value?.play()
  } catch {
    // Autoplay can be refused even for muted video. Say so rather than leave a
    // blank canvas and a loop spinning on a frame that never arrives.
    note.value = 'The browser would not start the video on its own.'
    return
  }
  if (mine !== run) return
  last = performance.now()
  raf = requestAnimationFrame(loop)
}

watch(chosen, start)
// A still has to be laid again from a clean canvas for a new thickness to show;
// a moving one picks it up on the next frame by itself.
watch(relief, () => chosen.value !== 'video' && start())
watch(ready, (v) => v && start())

onBeforeUnmount(() => cancelAnimationFrame(raf))
</script>

<template>
  <div class="media">
    <OilCanvas
      ref="surface"
      bare
      :wetness="wetness"
      @stats="stats = $event"
      @ready="ready = true"
      @reset="start"
    />

    <!--
      Off-screen, and never shown directly: it is only ever a source of frames
      to lay into the paint. Rendered only once it is wanted, because
      `preload="none"` did not stop the browser fetching all eight megabytes of
      it on a visit that only ever looks at the photograph — measured, not
      assumed. No element, no request.
    -->
    <video
      v-if="chosen === 'video'"
      ref="video"
      class="media__source"
      :src="elephantUrl"
      muted
      loop
      playsinline
    />

    <aside class="panel">
      <div class="panel__row" role="group" aria-label="subject">
        <button
          v-for="m in ['photograph', 'video']"
          :key="m"
          type="button"
          :class="{ on: chosen === m }"
          :aria-pressed="chosen === m"
          @click="chosen = m"
        >
          {{ m }}
        </button>
      </div>

      <label class="panel__field">
        <span>wetness</span>
        <input v-model.number="wetness" type="range" min="0" max="1" step="0.01" />
      </label>

      <label v-if="chosen === 'video'" class="panel__field">
        <span>re-paint</span>
        <input v-model.number="repaint" type="range" min="1" max="40" step="0.5" />
      </label>

      <label class="panel__field">
        <span>impasto</span>
        <input v-model.number="relief" type="range" min="0" max="1" step="0.01" />
      </label>

      <button class="panel__action" type="button" @click="start">lay it again</button>

      <p class="panel__hint">
        {{ note || 'Drag across the picture — the paint is wet.' }}
      </p>
    </aside>

    <p v-if="stats" class="readout">
      {{ stats.fps.toFixed(0) }} fps · {{ stats.tier }} · {{ stats.grid
      }}{{ stats.idle ? ' · resting' : '' }}
    </p>
  </div>
</template>

<style scoped>
.media {
  position: absolute;
  inset: 0;
  overflow: hidden;
}

/* Present for its frames, never for its pixels. */
.media__source {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}

.panel {
  position: absolute;
  top: max(1rem, env(safe-area-inset-top));
  left: max(1rem, env(safe-area-inset-left));
  z-index: 2;
  display: grid;
  gap: 0.7rem;
  padding: 0.9rem 1rem;
  width: min(16rem, calc(100vw - 2rem));
  border-radius: var(--radius);
  background: rgba(26, 21, 18, 0.62);
  border: 1px solid rgba(242, 232, 218, 0.14);
  backdrop-filter: blur(12px);
}

.panel__row {
  display: flex;
  gap: 0.35rem;
}

.panel__row button,
.panel__action {
  font: inherit;
  font-size: 0.75rem;
  letter-spacing: 0.1em;
  text-transform: lowercase;
  color: rgba(242, 232, 218, 0.7);
  background: none;
  border: 1px solid rgba(242, 232, 218, 0.2);
  border-radius: var(--radius);
  padding: 0.35rem 0.8rem;
  cursor: pointer;
}
.panel__row button.on {
  color: #1a1512;
  background: rgba(242, 232, 218, 0.9);
  border-color: transparent;
}
.panel__row button:hover,
.panel__action:hover {
  color: var(--ink);
}

.panel__field {
  display: grid;
  grid-template-columns: 4.5rem 1fr;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.75rem;
  letter-spacing: 0.06em;
  color: rgba(242, 232, 218, 0.7);
}
.panel__field input {
  width: 100%;
  accent-color: #d9a441;
}

.panel__action {
  justify-self: start;
}

.panel__hint {
  margin: 0;
  font-size: 0.6875rem;
  line-height: 1.45;
  color: rgba(242, 232, 218, 0.5);
}

.panel__row button:focus-visible,
.panel__action:focus-visible,
.panel__field input:focus-visible {
  outline: 2px solid rgba(242, 232, 218, 0.8);
  outline-offset: 2px;
}

.readout {
  position: absolute;
  right: max(1rem, env(safe-area-inset-right));
  bottom: max(1rem, env(safe-area-inset-bottom));
  margin: 0;
  font-size: 0.6875rem;
  letter-spacing: 0.08em;
  color: rgba(242, 232, 218, 0.55);
  font-variant-numeric: tabular-nums;
  pointer-events: none;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
}

@media (max-width: 640px) {
  .readout {
    bottom: calc(max(1rem, env(safe-area-inset-bottom)) + 3rem);
  }
}
</style>
