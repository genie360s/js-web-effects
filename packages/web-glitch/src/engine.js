// The glitch engine: one element, one canvas laid exactly over it, one small
// WebAssembly solver deciding what every cell of that canvas shows.
//
// The element stays where it is and stays what it is — a link is still a
// link, a form still takes typing — and goes transparent once the GPU is
// drawing it. It costs nothing when nothing is happening: the loop stops once
// the picture has settled, and does not start at all while the element is off
// the screen, which is also what makes a reveal wait until it is scrolled to.
//
// Copyright (c) 2026 Alex Mkwizu <alexgmkwizu@gmail.com> — MIT.

import { createRenderer } from './render/renderer.js'
import { srgb } from './render/shaders.js'
import { PARAM_DEFAULTS, PARAM_INDEX, writeParams } from './sim/params.js'
import { captureElement, directSource, fittedSource, isMedia } from './ui/capture.js'

/** The solver steps at this rate; the flicker is timed in tenths of a second. */
const STEP = 1 / 30
/** Idle frames before the loop lets go. */
const SLEEP_AFTER = 4
/** A playing video's subject is looked for again this often, in ms. */
const RESAMPLE_MS = 250
const MAX_GRID = 512

export const DEFAULTS = {
  // --- the grid ----------------------------------------------------------
  /** The smallest block, in CSS pixels. Blocks are 1, 2, 4 or 8 of these. */
  cell: 14,
  /** The same seed cuts the same blocks and replays the same sequence. */
  seed: 1,

  // --- the picture -------------------------------------------------------
  /** Whether it should be there. It arrives, and leaves, at `speed`. */
  visible: true,
  /**
   * What counts as the subject, which is what the blocks follow:
   * 'auto' uses transparency if there is any and otherwise keys out the
   * colour most of the border is; 'alpha' is transparency only; 'none' treats the
   * whole box as subject; a hex colour keys that colour out.
   */
  key: 'auto',
  /** How far from the key colour still counts as background, 0..1. */
  tolerance: 0.14,
  /** Cut the subject out of a keyed colour altogether, so it never arrives. */
  cutout: false,
  /** Your own rasteriser for DOM content, in place of the built-in one. */
  capture: null,

  // --- the pointer -------------------------------------------------------
  interactive: true,
  /** Radius of what a stroke unsettles, in CSS pixels. */
  pointer: 60,
  /** Excitement per radius-length of movement. */
  pointerGain: 1.2,
  /** Strength of the burst a click sets off; 0 for none. */
  clickBurst: 1,

  // --- the look ----------------------------------------------------------
  /** Dots, masks, hairlines, characters and numbers. */
  ink: '#ffffff',
  glowColor: '#bfe6ff',
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a || 1e-6), 0, 1)
  return t * t * (3 - 2 * t)
}

// Compiled once per URL; every engine gets its own instance, because the
// solver keeps its grid in a static.
const modules = new Map()
function compile(url) {
  const key = String(url)
  if (!modules.has(key)) {
    modules.set(key, fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`glitch: could not fetch the wasm (${response.status})`)
        return response.arrayBuffer()
      })
      .then((bytes) => WebAssembly.compile(bytes))
      .catch((err) => { modules.delete(key); throw err }))
  }
  return modules.get(key)
}

/**
 * @param {HTMLElement} el what to glitch: an image, a video, a canvas, or any
 *   element. It needs a positioned ancestor for the canvas to sit against.
 * @param {object} options anything in DEFAULTS, plus any solver parameter from
 *   `src/sim/params.js`, plus `wasm` (a URL)
 */
export async function createGlitch(el, options = {}) {
  if (!(el instanceof HTMLElement)) throw new TypeError('glitch: pass an element')
  if (!options.wasm) throw new TypeError('glitch: pass wasm (a URL)')

  const params = { ...DEFAULTS }
  const physics = { ...PARAM_DEFAULTS }
  // `key` is the colour the subject was found against, once it has been looked for.
  let look = { key: null }
  applyOptions(options)

  const canvas = document.createElement('canvas')
  canvas.setAttribute('aria-hidden', 'true')
  canvas.style.cssText = 'position:absolute;display:block;pointer-events:none'
  const renderer = createRenderer(canvas)
  el.after(canvas)

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  const video = el instanceof HTMLVideoElement ? el : null
  const restoreOpacity = el.style.opacity

  let wasm = null
  let grid = { w: 0, h: 0, across: 0, down: 0 }
  let size = null
  let box = ''
  let presence = null
  let presenceDirty = true
  let sampledAt = 0
  let contentReady = false
  /** The element cannot be read as a texture, so it shows itself. */
  let failed = false
  /** The picture is whole and still, so the element shows itself and the canvas steps aside. */
  let resting = false
  let capturing = false
  let recaptureQueued = false
  let debounce = 0
  let rafId = 0
  let running = false
  let destroyed = false
  let contextLost = false
  let offscreen = true
  let lastAt = 0
  let acc = STEP
  let idleFrames = 0
  let dirty = true
  let lastPoint = null

  function applyOptions(patch) {
    for (const key in patch) {
      if (key === 'wasm') continue
      if (key in PARAM_INDEX) physics[key] = patch[key]
      else if (key in DEFAULTS) params[key] = patch[key]
      else throw new TypeError(`glitch: unknown option "${key}"`)
    }
    // Throws on a bad name or value before anything is written.
    writeParams(new Float32Array(Object.keys(PARAM_INDEX).length), physics)
    if (!['auto', 'alpha', 'none'].includes(params.key)) srgb(params.key)
    look = { ...look, ink: srgb(params.ink), glowColor: srgb(params.glowColor) }
  }

  // --- the element ----------------------------------------------------------

  // Motion-sensitive visitors get the picture, not the glitch: the canvas
  // stays out of it and `visible` just shows or hides the element.
  const calm = () => reducedMotion.matches

  /** Write the element's opacity without our own observer reading it back. */
  function setOpacity(value) {
    el.style.opacity = value
    mutations.takeRecords()
  }

  function syncElement() {
    const drawn = !calm() && !failed && !contextLost && !resting
    setOpacity(drawn || (calm() && !params.visible) ? '0' : restoreOpacity)
    canvas.style.visibility = drawn && contentReady ? 'visible' : 'hidden'
  }

  /** Keep the canvas exactly over the element, wherever layout has put it. */
  function place() {
    const next = `left:${el.offsetLeft}px;top:${el.offsetTop}px;width:${el.offsetWidth}px;height:${el.offsetHeight}px`
    if (next === box) return
    box = next
    canvas.style.left = `${el.offsetLeft}px`
    canvas.style.top = `${el.offsetTop}px`
    canvas.style.width = `${el.offsetWidth}px`
    canvas.style.height = `${el.offsetHeight}px`
    resize(false)
  }

  function resize(force) {
    if (!wasm || contextLost || destroyed) return
    const cssW = Math.max(1, el.offsetWidth)
    const cssH = Math.max(1, el.offsetHeight)
    // A cell never smaller than would overflow the solver's largest grid.
    const cell = Math.max(params.cell, 2, cssW / MAX_GRID, cssH / MAX_GRID)
    const next = {
      across: cssW / cell,
      down: cssH / cell,
      w: clamp(Math.ceil(cssW / cell), 2, MAX_GRID),
      h: clamp(Math.ceil(cssH / cell), 2, MAX_GRID),
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const regrid = force || next.w !== grid.w || next.h !== grid.h
    const rescale = !size || size.cssW !== cssW || size.cssH !== cssH || size.dpr !== dpr
    grid = next
    size = { cssW, cssH, dpr, cell }
    renderer.resize(Math.round(cssW * dpr), Math.round(cssH * dpr), dpr, grid, cell)
    dirty = true
    if (regrid) {
      // A new grid is a new solver state; carry over where the picture had got to.
      const first = presence === null
      const progress = first ? 0 : wasm.progress()
      if (!wasm.init(grid.w, grid.h)) throw new Error('glitch: the solver refused the grid')
      writeParams(view(Float32Array, wasm.params_ptr(), wasm.params_len()), physics)
      wasm.reseed(params.seed >>> 0)
      if (!first) wasm.set_progress(progress)
      presence = new Uint8Array(grid.w * grid.h)
      presenceDirty = true
      syncTarget()
    }
    // DOM content was rasterised at the old size; media with object-fit is
    // a new crop of the same frame.
    if (rescale && contentReady) recapture(isMedia(el) ? 0 : 60)
    wake()
  }

  /** A view onto the solver's memory. Made fresh: growing memory detaches old ones. */
  const view = (Type, ptr, length) => new Type(wasm.memory.buffer, ptr, length)

  function syncTarget() {
    wasm?.set_target(params.visible ? 1 : 0)
  }

  // --- the picture ----------------------------------------------------------

  function upload(source) {
    if (source instanceof HTMLVideoElement && source.readyState < 2) return
    try {
      renderer.uploadContent(fittedSource(source))
    } catch (err) {
      // A cross-origin image or video without CORS headers taints the upload.
      // Nothing can be drawn, so the page shows its own.
      contentReady = false
      failed = true
      syncElement()
      console.warn('glitch: cannot read this element as a texture', err)
      return
    }
    dirty = true
    if (!contentReady || failed) {
      contentReady = true
      failed = false
      presenceDirty = true
      syncElement()
    }
  }

  async function refresh() {
    if (destroyed || contextLost || !size) return
    const direct = directSource(el)
    if (direct) {
      upload(direct)
      presenceDirty = true
      wake()
      return
    }
    // An image with no pixels yet: its load event brings us back.
    if (isMedia(el)) return
    if (capturing) {
      recaptureQueued = true
      return
    }
    capturing = true
    try {
      const image = await (params.capture || captureElement)(el, size.dpr, el.getBoundingClientRect())
      if (destroyed || contextLost || !image) return
      upload(image)
      presenceDirty = true
      wake()
    } catch (err) {
      console.warn('glitch: could not capture element', err)
    } finally {
      capturing = false
      if (recaptureQueued && !destroyed) {
        recaptureQueued = false
        refresh()
      }
    }
  }

  function recapture(delay) {
    clearTimeout(debounce)
    debounce = setTimeout(refresh, delay)
  }

  /**
   * Where the subject is, a byte a cell. Read back from the GPU rather than
   * through a 2D canvas, which a rasterised DOM subtree would taint.
   */
  function samplePresence() {
    presenceDirty = false
    sampledAt = performance.now()
    const { w, h } = grid
    const next = new Uint8Array(w * h)
    if (params.key === 'none') {
      look.key = null
      next.fill(255)
    } else {
      const px = renderer.probe()
      const pw = w * 2
      // Probe pixels wholly inside the picture; the last column and row of
      // the grid can hang off its edge.
      const iw = Math.max(1, Math.min(pw, Math.floor(grid.across * 2)) - 1)
      const ih = Math.max(1, Math.min(h * 2, Math.floor(grid.down * 2)) - 1)
      let keyColor = null
      if (params.key !== 'alpha' && params.key !== 'auto') {
        keyColor = srgb(params.key).map((c) => c * 255)
      } else if (params.key === 'auto') {
        let clear = 0
        for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) clear += px[(y * pw + x) * 4 + 3] < 128
        // Opaque all over: the background is taken to be whatever most of
        // the border is. The median, channel by channel, so a subject that
        // runs off one edge does not drag the answer toward itself.
        if (clear < iw * ih * 0.005) {
          const border = [[], [], []]
          for (let y = 0; y < ih; y++) {
            for (let x = 0; x < iw; x += y === 0 || y === ih - 1 ? 1 : Math.max(iw - 1, 1)) {
              const i = (y * pw + x) * 4
              const a = Math.max(px[i + 3], 1) / 255
              for (let c = 0; c < 3; c++) border[c].push(px[i + c] / a)
            }
          }
          keyColor = border.map((channel) => channel.sort((p, q) => p - q)[channel.length >> 1])
        }
      }
      look.key = keyColor && keyColor.map((c) => c / 255)
      const tol = clamp(params.tolerance, 0.005, 1)
      for (let y = 0; y < h * 2; y++) {
        for (let x = 0; x < pw; x++) {
          const i = (y * pw + x) * 4
          const a = px[i + 3] / 255
          let p = a
          if (keyColor && a > 0) {
            // premultiplied on the way back; the key is not
            const far = Math.max(
              Math.abs(px[i] / a - keyColor[0]),
              Math.abs(px[i + 1] / a - keyColor[1]),
              Math.abs(px[i + 2] / a - keyColor[2]),
            ) / 255
            p *= smoothstep(tol * 0.5, tol, far)
          }
          // The strongest of a cell's four probes, so a thin stroke still counts.
          const cellIndex = (y >> 1) * w + (x >> 1)
          next[cellIndex] = Math.max(next[cellIndex], Math.round(p * 255))
        }
      }
    }
    // A new layout re-cuts every block, so only when the subject has moved.
    if (next.every((v, i) => v === presence[i])) return
    presence = next
    view(Uint8Array, wasm.presence_ptr(), w * h).set(next)
    wasm.layout()
  }

  // --- frame ----------------------------------------------------------------

  const playing = () => video && !video.paused && !video.ended && video.readyState >= 2

  function tick(now) {
    if (destroyed || contextLost) return sleep()
    rafId = requestAnimationFrame(tick)
    place()
    if (!contentReady || calm()) return sleep()
    const dt = lastAt ? Math.min((now - lastAt) / 1000, 0.1) : 0
    lastAt = now

    if (playing()) {
      // ponytail: every frame while it plays; requestVideoFrameCallback if
      // uploading a frame the video has not changed ever shows up in a profile
      upload(video)
      if (params.key !== 'none' && now - sampledAt > RESAMPLE_MS) presenceDirty = true
    }
    if (presenceDirty) samplePresence()

    acc += dt
    if (acc >= STEP) {
      wasm.step(acc)
      acc = 0
      const n = grid.w * grid.h
      renderer.uploadField(view(Uint8Array, wasm.out_ptr(), n * 4), view(Uint8Array, wasm.glow_ptr(), n))
      dirty = true
    }
    if (dirty) {
      renderer.draw(look, (now / 1000) % 1000, params.cutout ? clamp(params.tolerance, 0.005, 1) : 0)
      dirty = false
    }
    // Only once there is a current frame under it does the canvas take over again.
    if (resting) {
      resting = false
      syncElement()
    }
    // Whole, in its own colours and with nothing due to happen: the canvas
    // would only be redrawing the element, so the element does it instead —
    // and a video goes on playing without a frame of ours.
    const whole = wasm.idle() && wasm.progress() >= 1 && !(params.cutout && look.key)
      && (physics.style === 0 || physics.style === 'image')
    idleFrames = whole || (wasm.idle() && !playing()) ? idleFrames + 1 : 0
    if (idleFrames > SLEEP_AFTER) {
      resting = whole
      syncElement()
      sleep()
    }
  }

  function wake() {
    if (running || destroyed || contextLost || offscreen || document.hidden || !wasm) return
    running = true
    idleFrames = 0
    lastAt = 0
    acc = STEP
    rafId = requestAnimationFrame(tick)
  }

  function sleep() {
    running = false
    if (rafId) cancelAnimationFrame(rafId)
    rafId = 0
  }

  // --- input ----------------------------------------------------------------

  function pulse(spot) {
    if (!wasm || !size) return
    const rect = el.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const scale = grid.across / rect.width
    wasm.pulse(
      (spot.clientX - rect.left) * scale,
      (spot.clientY - rect.top) * (grid.down / rect.height),
      Math.max((spot.radius ?? params.pointer) * scale, 0.5),
      spot.strength ?? params.pointerGain,
    )
    wake()
  }

  function burst(strength = 1) {
    if (!wasm || calm()) return
    wasm.burst(strength)
    wake()
  }

  function onPointerMove(event) {
    if (!params.interactive) return
    // By distance, not by event: moving one radius lands one gain's worth,
    // however many events the hardware split it into.
    if (lastPoint && event.timeStamp - lastPoint.t < 140) {
      const dist = Math.hypot(event.clientX - lastPoint.x, event.clientY - lastPoint.y)
      const strength = clamp(dist / params.pointer, 0, 1) * params.pointerGain
      if (strength > 0.01) pulse({ clientX: event.clientX, clientY: event.clientY, strength })
    }
    lastPoint = { x: event.clientX, y: event.clientY, t: event.timeStamp }
  }

  function onPointerDown(event) {
    if (!params.interactive) return
    pulse({ clientX: event.clientX, clientY: event.clientY, strength: params.pointerGain * 2 })
    if (params.clickBurst > 0) burst(params.clickBurst)
  }

  function onContextLost(event) {
    event.preventDefault()
    contextLost = true
    sleep()
    syncElement()
  }

  function onContextRestored() {
    contextLost = false
    contentReady = false
    renderer.rebuild()
    refresh()
  }

  const onMotionPreference = () => { syncElement(); wake() }
  const onVisibility = () => (document.hidden ? sleep() : wake())
  const onEdited = () => recapture(40)
  const onLoaded = () => refresh()

  // A reveal waits here until the element is scrolled to.
  const visibility = new IntersectionObserver((entries) => {
    offscreen = !entries.some((entry) => entry.isIntersecting)
    if (offscreen) sleep()
    else wake()
  })
  const resized = new ResizeObserver(() => { place(); wake() })
  const mutations = new MutationObserver(() => recapture(60))

  // Nothing above has touched the page beyond adding the canvas. From here a
  // failure has to put the element back the way it was found.
  try {
    // Out of sight while the wasm arrives, so a reveal does not start with a
    // flash of the finished picture.
    if (params.visible && !calm()) setOpacity('0')
    const instance = await WebAssembly.instantiate(await compile(options.wasm), {})
    wasm = instance.exports
  } catch (err) {
    setOpacity(restoreOpacity)
    canvas.remove()
    throw err
  }
  place()
  resize(true)
  syncElement()

  if (isMedia(el)) {
    for (const kind of ['load', 'loadeddata', 'play', 'seeked']) el.addEventListener(kind, onLoaded)
  } else {
    mutations.observe(el, { subtree: true, childList: true, characterData: true, attributes: true })
    // Typing, ticking a box and focus rings are none of them mutations.
    for (const kind of ['input', 'change', 'focusin', 'focusout']) el.addEventListener(kind, onEdited, true)
    // Rasterised before its web font arrived, it has fallback metrics.
    document.fonts?.ready.then(() => { if (!destroyed) refresh() }).catch(() => {})
  }
  el.addEventListener('pointermove', onPointerMove, { passive: true })
  el.addEventListener('pointerdown', onPointerDown, { passive: true })
  document.addEventListener('visibilitychange', onVisibility)
  canvas.addEventListener('webglcontextlost', onContextLost)
  canvas.addEventListener('webglcontextrestored', onContextRestored)
  reducedMotion.addEventListener?.('change', onMotionPreference)
  resized.observe(el)
  visibility.observe(el)
  refresh()

  return {
    canvas,
    params,
    physics,
    pulse,
    burst,

    /** Bring the picture in, all of it or part of it: `reveal(0.85)` stops with the subject in and the background out. */
    reveal(amount = 1) {
      params.visible = amount > 0
      wasm.set_target(clamp(amount, 0, 1))
      syncElement()
      wake()
    },

    hide() {
      this.reveal(0)
    },

    /** How much of the picture is there right now, 0..1. */
    get progress() {
      return wasm.progress()
    },

    get grid() {
      return { ...grid }
    },

    /** Re-cut the blocks and restart the sequence. */
    reseed(seed) {
      params.seed = seed >>> 0
      wasm.reseed(params.seed)
      wake()
    },

    /** Read the element again: for a canvas you drew on, or DOM a mutation would not report. */
    update: refresh,

    /** Anything in DEFAULTS, or any solver parameter. Takes effect at once. */
    setParams(patch) {
      const before = { ...params, ...physics }
      applyOptions(patch)
      writeParams(view(Float32Array, wasm.params_ptr(), wasm.params_len()), physics)
      // Compared by value, not by presence: a deep watcher hands over the
      // whole options object on every change.
      if (params.cell !== before.cell) resize(true)
      else if (params.seed !== before.seed) wasm.reseed(params.seed >>> 0)
      else if (physics.threshold !== before.threshold || physics.split !== before.split) wasm.layout()
      if (params.key !== before.key || params.tolerance !== before.tolerance) presenceDirty = true
      if (params.visible !== before.visible) syncTarget()
      syncElement()
      dirty = true
      wake()
    },

    destroy() {
      if (destroyed) return
      destroyed = true
      sleep()
      clearTimeout(debounce)
      for (const kind of ['load', 'loadeddata', 'play', 'seeked']) el.removeEventListener(kind, onLoaded)
      for (const kind of ['input', 'change', 'focusin', 'focusout']) el.removeEventListener(kind, onEdited, true)
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('visibilitychange', onVisibility)
      canvas.removeEventListener('webglcontextlost', onContextLost)
      canvas.removeEventListener('webglcontextrestored', onContextRestored)
      reducedMotion.removeEventListener?.('change', onMotionPreference)
      resized.disconnect()
      visibility.disconnect()
      mutations.disconnect()
      el.style.opacity = restoreOpacity
      renderer.gl.getExtension('WEBGL_lose_context')?.loseContext()
      canvas.remove()
    },
  }
}
