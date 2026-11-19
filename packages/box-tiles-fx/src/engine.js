// The tiles engine: one worker running the tile grid, one WebGL2 context
// drawing it, and any number of content layers seen through it.
//
// It costs nothing when nothing is happening. The draw loop stops once the
// grid has settled and no layer is live, and restarts the moment anything
// excites it, so an idle page holds no rAF callback at all — and the worker
// drops to a tenth of its rate rather than spinning.
//
// Copyright (c) 2026 Alex Mkwizu <alexgmkwizu@gmail.com> — MIT.

import { createRenderer } from './render/renderer.js'
import { createGovernor, gridFor, pixelsFor } from './render/quality.js'
import { PARAM_DEFAULTS, PARAM_INDEX } from './sim/params.js'
import { captureElement, directSource, isLiveSource, isMedia } from './ui/capture.js'
import { srgb } from './render/shaders.js'

/** Frames with nothing happening before the draw loop lets go. */
const SLEEP_AFTER = 4
/** A gap longer than this starts a new stroke rather than joining the last point. */
const STROKE_RESTART_MS = 140

export const DEFAULTS = {
  // --- the grid ----------------------------------------------------------
  /** How big a tile is, in CSS pixels. The look's one real dial. */
  cell: 40,
  /** The lottery and the sequence. The same seed replays the same tiles. */
  seed: 1,
  /** Fixed tier, or null to let the governor decide. */
  quality: null,
  interactive: true,

  // --- the pointer -------------------------------------------------------
  /** Radius of what a stroke excites, in CSS pixels. */
  pointer: 70,
  /** Excitement per radius-length of movement. */
  pointerGain: 1.2,
  /** Excitement a click lands. */
  clickGain: 2.5,

  // --- the look ----------------------------------------------------------
  lineColor: '#9fc4ff',
  /** 0 hides the grid. */
  lineAlpha: 0.14,
  /** CSS pixels. */
  lineWidth: 0.8,
  /** A wider faint halo on the lines, 0..1. */
  lineGlow: 0.12,
  /** 'content' draws the grid only over layers; 'surface' over the whole box. */
  gridMask: 'content',
  /** Duotone grade: the colour of the shadows, the colour of the highlights. */
  shadows: '#06142e',
  highlights: '#c2d8f7',
  /** How much of the grade to apply, 0..1. 0 leaves the content alone. */
  grade: 0,
  exposure: 1,
  /** Darkening at the corners, 0..1. */
  vignette: 0,

  // --- per layer, overridable on each ------------------------------------
  /** How much of the layer has been revealed, 0..1. Tile by tile. */
  reveal: 1,
  /** How soft the edge of the reveal is, as a fraction of the lottery. */
  revealSoft: 0.08,
  /** 0 reveals by lottery, 1 wipes left to right; in between, both. */
  sweep: 0,
  /** False draws the layer flat, untouched by the tiles. */
  tiles: true,
}

const LAYER_KEYS = ['reveal', 'revealSoft', 'sweep', 'tiles', 'capture', 'live']
const LOOK_KEYS = ['lineAlpha', 'lineWidth', 'lineGlow', 'gridMask', 'grade', 'exposure', 'vignette']

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)

/**
 * @param {HTMLElement} container must be positioned; the canvas is prepended
 * @param {object} options anything in DEFAULTS, plus any solver parameter from
 *   `src/sim/params.js`, plus `wasm` (a URL) and `worker` (a URL or factory)
 */
export async function createTiles(container, options = {}) {
  if (!(container instanceof HTMLElement)) {
    throw new TypeError('tiles: container must be an element')
  }
  if (!options.wasm) throw new TypeError('tiles: pass wasm (a URL)')
  if (!options.worker) throw new TypeError('tiles: pass worker (a URL or a factory)')

  const params = { ...DEFAULTS }
  const physics = { ...PARAM_DEFAULTS }
  // Parsed on change rather than per frame.
  let lineColor = []
  let shadows = []
  let highlights = []
  applyOptions(options)

  const canvas = document.createElement('canvas')
  canvas.setAttribute('aria-hidden', 'true')
  canvas.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none'
  container.prepend(canvas)

  let renderer
  try {
    renderer = createRenderer(canvas)
  } catch (err) {
    canvas.remove()
    throw err
  }

  // Either a URL, or a factory — which is what a bundler's `?worker` import
  // hands you, and the only form it can see well enough to bundle.
  const worker = typeof options.worker === 'function'
    ? options.worker()
    : new Worker(options.worker, { type: 'module' })
  const layers = []
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

  let grid = { w: 0, h: 0, across: 0, down: 0, px: params.cell }
  let size = null
  let canvasRect = null
  let hasField = false
  let activeTiles = 0

  let rafId = 0
  let running = false
  let destroyed = false
  let contextLost = false
  let offscreen = false
  let ready = false
  let solverIdle = true
  let rectsDirty = true
  let needsDraw = true
  let idleFrames = 0
  let lastFrameAt = 0
  let lastPoint = null

  const governor = createGovernor((tier, reason) => {
    if (size) resize(false)
    container.dispatchEvent(new CustomEvent('tiles:quality', {
      detail: { tier, reason, auto: governor.auto },
    }))
  })
  if (params.quality) governor.setManual(params.quality)

  function applyOptions(patch) {
    for (const key in patch) {
      if (key === 'wasm' || key === 'worker') continue
      if (key in PARAM_INDEX) physics[key] = patch[key]
      else if (key in DEFAULTS) params[key] = patch[key]
      else throw new TypeError(`tiles: unknown option "${key}"`)
    }
    if (params.gridMask !== 'content' && params.gridMask !== 'surface') {
      throw new TypeError(`tiles: gridMask must be "content" or "surface", got "${params.gridMask}"`)
    }
    lineColor = srgb(params.lineColor)
    shadows = srgb(params.shadows)
    highlights = srgb(params.highlights)
  }

  /** The solver's tunables as {index: value}, which is what the worker wants. */
  function physicsPatch(source = physics) {
    const patch = {}
    for (const name in source) patch[PARAM_INDEX[name]] = source[name]
    return patch
  }

  function look() {
    const o = {}
    for (const key of LOOK_KEYS) o[key] = params[key]
    o.lineColor = lineColor
    o.shadows = shadows
    o.highlights = highlights
    return o
  }

  // --- size ----------------------------------------------------------------

  function measure() {
    const rect = container.getBoundingClientRect()
    return { cssW: Math.max(1, rect.width), cssH: Math.max(1, rect.height) }
  }

  function resize(force) {
    if (contextLost || destroyed) return
    const { cssW, cssH } = measure()
    const pixels = pixelsFor(governor.tier, cssW, cssH)
    const next = gridFor(params.cell, cssW, cssH)
    const regrid = force || next.w !== grid.w || next.h !== grid.h
    size = { ...pixels, cssW, cssH }
    grid = next
    rectsDirty = true
    needsDraw = true
    renderer.resize(pixels.w, pixels.h, pixels.dpr, grid)
    if (!regrid) return

    hasField = false
    worker.postMessage({
      type: ready ? 'resize' : 'init',
      wasm: options.wasm,
      w: grid.w,
      h: grid.h,
      seed: params.seed,
      params: physicsPatch(),
    })
  }

  // --- layers ---------------------------------------------------------------

  function layerOption(layer, key) {
    return layer.options[key] ?? params[key]
  }

  /** Copy the resolved options onto the layer, where the renderer reads them. */
  function syncLayer(layer) {
    layer.reveal = clamp(layerOption(layer, 'reveal'), 0, 1)
    layer.revealSoft = clamp(layerOption(layer, 'revealSoft'), 0, 1)
    layer.sweep = clamp(layerOption(layer, 'sweep'), 0, 1)
    // Motion-sensitive visitors get the picture, not the tiles.
    layer.tiles = layerOption(layer, 'tiles') !== false && !reducedMotion.matches
  }

  function layerIsLive(layer) {
    if (!layer.source || !isLiveSource(layer.el)) return false
    if (layer.el instanceof HTMLVideoElement) {
      return !layer.el.paused && !layer.el.ended && layer.el.readyState >= 2
    }
    return layer.options.live !== false
  }

  function uploadLayerTexture(layer, source) {
    if (source instanceof HTMLVideoElement && source.readyState < 2) return
    try {
      renderer.uploadLayer(layer.texture, source)
      needsDraw = true
      if (!layer.ready) {
        layer.ready = true
        hideElement(layer)
      }
    } catch (err) {
      // A cross-origin image or video without CORS headers taints the upload.
      // Nothing can be drawn for this layer, so the page shows its own.
      layer.ready = false
      showElement(layer)
      console.warn('tiles: cannot read this element as a texture', err)
    }
  }

  async function refreshLayer(layer) {
    if (layer.removed || contextLost || destroyed || !size) return
    const direct = directSource(layer.el)
    if (direct) {
      layer.source = direct
      uploadLayerTexture(layer, direct)
      wake()
      return
    }
    // An image or video with no pixels yet: its load event brings us back.
    if (isMedia(layer.el)) return
    if (layer.capturing) {
      layer.recaptureQueued = true
      return
    }
    layer.capturing = true
    try {
      const capture = layer.options.capture || captureElement
      const image = await capture(layer.el, size.dpr, layer.el.getBoundingClientRect())
      if (layer.removed || destroyed || contextLost || !image) return
      uploadLayerTexture(layer, image)
      // Nothing needs the snapshot once it is on the GPU, and an SVG image
      // left alive keeps the browser re-rasterising it.
      layer.source = null
      wake()
    } catch (err) {
      console.warn('tiles: could not capture element', err)
    } finally {
      layer.capturing = false
      if (layer.recaptureQueued && !layer.removed) {
        layer.recaptureQueued = false
        refreshLayer(layer)
      }
    }
  }

  // Videos say when a frame is ready; anything else is polled.
  function watchVideo(layer) {
    const video = layer.el
    if (typeof video.requestVideoFrameCallback !== 'function') {
      layer.pollFrames = true
      return
    }
    const onFrame = () => {
      if (layer.removed || destroyed) return
      layer.needsUpload = true
      wake()
      video.requestVideoFrameCallback(onFrame)
    }
    video.requestVideoFrameCallback(onFrame)
  }

  /**
   * The live element goes transparent only once the GPU is drawing it, so a
   * browser without WebGL2 shows the ordinary page. The engine does it rather
   * than the caller: writing the style from outside would come straight back
   * through this layer's own MutationObserver as another rasterisation.
   */
  function reobserve(layer) {
    const el = layer.el
    for (const observer of layer.observers) observer.disconnect()
    layer.observers.length = 0

    // The first ResizeObserver callback only reports the size it already has.
    let measured = false
    const onResized = new ResizeObserver(() => {
      rectsDirty = true
      if (measured && !isMedia(el)) refreshLayer(layer)
      measured = true
      wake()
    })
    onResized.observe(el)
    layer.observers.push(onResized)

    if (isMedia(el)) return

    const onMutated = new MutationObserver(() => recapture(layer, 60))
    onMutated.observe(el, { subtree: true, childList: true, characterData: true, attributes: true })
    layer.observers.push(onMutated)

    // Typing, ticking a box and focus rings are none of them mutations, so a
    // form has to be watched separately or it shows as it first loaded.
    if (!layer.onEdited) {
      layer.onEdited = () => recapture(layer, 40)
      for (const kind of ['input', 'change', 'focusin', 'focusout']) {
        el.addEventListener(kind, layer.onEdited, true)
      }
    }
  }

  function recapture(layer, delay) {
    clearTimeout(layer.debounce)
    layer.debounce = setTimeout(() => refreshLayer(layer), delay)
  }

  function hideElement(layer) {
    if (layer.hidden) return
    layer.hidden = true
    layer.restoreOpacity = layer.el.style.opacity
    for (const observer of layer.observers) observer.disconnect()
    layer.el.style.opacity = '0'
    reobserve(layer)
  }

  function showElement(layer) {
    if (!layer.hidden) return
    layer.hidden = false
    for (const observer of layer.observers) observer.disconnect()
    layer.el.style.opacity = layer.restoreOpacity ?? ''
    if (!layer.removed) reobserve(layer)
  }

  function releaseLayer(layer) {
    showElement(layer)
    layer.removed = true
    clearTimeout(layer.debounce)
    for (const observer of layer.observers) observer.disconnect()
    if (layer.onEdited) {
      for (const kind of ['input', 'change', 'focusin', 'focusout']) {
        layer.el.removeEventListener(kind, layer.onEdited, true)
      }
    }
    if (layer.onLoaded) {
      for (const kind of ['load', 'loadeddata', 'play']) {
        layer.el.removeEventListener(kind, layer.onLoaded)
      }
    }
  }

  function addLayer(el, layerOptions = {}) {
    if (!(el instanceof HTMLElement)) throw new TypeError('tiles: a layer must be an element')
    for (const key in layerOptions) {
      if (!LAYER_KEYS.includes(key)) throw new TypeError(`tiles: "${key}" is not a per-layer option`)
    }
    const layer = {
      el,
      options: { ...layerOptions },
      texture: renderer.newLayerTexture(),
      rect: [0, 0, 0, 0],
      ready: false,
      onScreen: true,
      source: null,
      capturing: false,
      recaptureQueued: false,
      needsUpload: false,
      pollFrames: false,
      removed: false,
      hidden: false,
      debounce: 0,
      observers: [],
    }
    syncLayer(layer)
    reobserve(layer)

    // A <canvas> cannot say when it was drawn on, so it is only re-read every
    // frame when the caller asks for that with `live`.
    if (el instanceof HTMLCanvasElement && layer.options.live === true) layer.pollFrames = true

    if (isMedia(el)) {
      layer.onLoaded = () => refreshLayer(layer)
      for (const kind of ['load', 'loadeddata', 'play']) el.addEventListener(kind, layer.onLoaded)
      if (el instanceof HTMLVideoElement) watchVideo(layer)
    }

    layers.push(layer)
    rectsDirty = true
    refreshLayer(layer)

    return {
      update: () => refreshLayer(layer),
      setOptions(next) {
        Object.assign(layer.options, next)
        syncLayer(layer)
        needsDraw = true
        wake()
      },
      destroy() {
        if (layer.removed) return
        releaseLayer(layer)
        renderer.deleteTexture(layer.texture)
        const index = layers.indexOf(layer)
        if (index >= 0) layers.splice(index, 1)
        needsDraw = true
        wake()
      },
    }
  }

  function updateRects() {
    canvasRect = canvas.getBoundingClientRect()
    for (const layer of layers) {
      const r = layer.el.getBoundingClientRect()
      layer.rect = [
        (r.left - canvasRect.left) / canvasRect.width,
        (r.top - canvasRect.top) / canvasRect.height,
        r.width / canvasRect.width,
        r.height / canvasRect.height,
      ]
      layer.onScreen = r.width > 0 && r.height > 0
        && r.right > canvasRect.left && r.left < canvasRect.right
        && r.bottom > canvasRect.top && r.top < canvasRect.bottom
    }
    rectsDirty = false
    needsDraw = true
  }

  // --- frame ----------------------------------------------------------------

  function uploadLiveLayers() {
    let uploaded = false
    for (const layer of layers) {
      if (!layer.source) continue
      if (!layer.needsUpload && !(layer.pollFrames && layerIsLive(layer))) continue
      uploadLayerTexture(layer, layer.source)
      layer.needsUpload = false
      uploaded = true
    }
    return uploaded
  }

  function tick(now) {
    if (destroyed || contextLost) return sleep()
    rafId = requestAnimationFrame(tick)
    if (lastFrameAt) governor.sample(now - lastFrameAt)
    lastFrameAt = now

    if (rectsDirty) updateRects()
    const busy = uploadLiveLayers() || !solverIdle

    if (needsDraw && hasField) {
      renderer.draw(layers, look())
      needsDraw = false
    }
    idleFrames = busy ? 0 : idleFrames + 1
    if (idleFrames > SLEEP_AFTER) sleep()
  }

  function wake() {
    if (running || destroyed || contextLost || offscreen || document.hidden) return
    running = true
    idleFrames = 0
    lastFrameAt = 0
    rafId = requestAnimationFrame(tick)
  }

  function sleep() {
    running = false
    if (rafId) cancelAnimationFrame(rafId)
    rafId = 0
  }

  worker.onmessage = ({ data: msg }) => {
    if (destroyed) return
    switch (msg.type) {
      case 'ready':
        ready = true
        wake()
        break
      case 'frame': {
        if (msg.w !== grid.w || msg.h !== grid.h) {
          // A frame from before a resize. It is the wrong shape to upload.
          worker.postMessage({ type: 'recycle', buffer: msg.buffer }, [msg.buffer])
          break
        }
        if (!contextLost) {
          renderer.uploadField(new Uint16Array(msg.buffer, 0, msg.w * msg.h * 4))
          hasField = true
        }
        activeTiles = msg.active
        needsDraw = true
        worker.postMessage({ type: 'recycle', buffer: msg.buffer }, [msg.buffer])
        wake()
        break
      }
      case 'idle':
        solverIdle = msg.idle
        if (!msg.idle) wake()
        break
      case 'error':
        console.warn(msg.message)
        break
    }
  }

  // --- input ----------------------------------------------------------------

  /** A point in CSS pixels, as grid cells. Null if it is off the canvas. */
  function toCells(clientX, clientY) {
    if (!canvasRect || rectsDirty) updateRects()
    if (!canvasRect.width || !canvasRect.height) return null
    return {
      x: ((clientX - canvasRect.left) / canvasRect.width) * grid.across,
      y: ((clientY - canvasRect.top) / canvasRect.height) * grid.down,
    }
  }

  function cellsPerCssPixel() {
    return canvasRect?.width ? grid.across / canvasRect.width : 1 / params.cell
  }

  /** Excite the tiles around a point. */
  function pulse(spot) {
    if (!ready) return
    const at = spot.cells ?? toCells(spot.clientX, spot.clientY)
    if (!at) return
    const scale = cellsPerCssPixel()
    worker.postMessage({
      type: 'pulse',
      x: at.x,
      y: at.y,
      radius: Math.max((spot.radius ?? params.pointer) * scale, 0.5),
      strength: spot.strength ?? params.clickGain,
    })
    wake()
  }

  function onPointerMove(event) {
    if (!params.interactive || destroyed || !ready) return
    // Coalesced events keep a fast stroke from turning into a polygon.
    const coalesced = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : null
    const batch = coalesced && coalesced.length ? coalesced : [event]
    for (const point of batch) {
      const when = point.timeStamp > 0 ? point.timeStamp : performance.now()
      const at = toCells(point.clientX, point.clientY)
      if (!at) continue
      // Excitement is by distance, not by event: moving one radius lands one
      // gain's worth, however many events the hardware split it into.
      const joined = lastPoint && when - lastPoint.t < STROKE_RESTART_MS
      if (joined) {
        const dist = Math.hypot(point.clientX - lastPoint.clientX, point.clientY - lastPoint.clientY)
        const strength = clamp(dist / params.pointer, 0, 1) * params.pointerGain
        if (strength > 0.01) pulse({ cells: at, strength })
      }
      lastPoint = { clientX: point.clientX, clientY: point.clientY, t: when }
    }
  }

  function onPointerDown(event) {
    lastPoint = null
    if (!params.interactive) return
    pulse({ clientX: event.clientX, clientY: event.clientY, strength: params.clickGain })
  }

  const endStroke = () => { lastPoint = null }
  const onScroll = () => { rectsDirty = true; wake() }
  const onResize = () => { resize(false); wake() }

  /**
   * There are two reasons to stop, and they have to agree. Told separately,
   * the tab coming back would restart a worker stepping a grid that is still
   * scrolled off the screen — and nothing would ever stop it again.
   */
  function idleCheck() {
    const stop = document.hidden || offscreen
    worker.postMessage({ type: 'pause', paused: stop })
    if (stop) sleep()
    else wake()
  }

  function onContextLost(event) {
    event.preventDefault()
    contextLost = true
    sleep()
    for (const layer of layers) showElement(layer)
  }

  function onContextRestored() {
    contextLost = false
    renderer.rebuild()
    renderer.resize(size.w, size.h, size.dpr, grid)
    for (const layer of layers) {
      layer.texture = renderer.newLayerTexture()
      layer.ready = false
      // The GPU has nothing to draw until it is captured again, so the real
      // element goes back on screen in the meantime.
      showElement(layer)
      refreshLayer(layer)
    }
    needsDraw = true
    wake()
  }

  const onMotionPreference = () => {
    for (const layer of layers) syncLayer(layer)
    needsDraw = true
    wake()
  }

  // Build first. Nothing starts listening until there is something to draw
  // with, so a failure here cannot leave observers firing at a dead engine.
  resize(true)
  updateRects()

  window.addEventListener('pointermove', onPointerMove, { passive: true })
  window.addEventListener('pointerdown', onPointerDown, { passive: true })
  window.addEventListener('pointerup', endStroke, { passive: true })
  window.addEventListener('pointercancel', endStroke, { passive: true })
  window.addEventListener('blur', endStroke)
  window.addEventListener('scroll', onScroll, { passive: true, capture: true })
  window.addEventListener('resize', onResize, { passive: true })
  document.addEventListener('visibilitychange', idleCheck)
  canvas.addEventListener('webglcontextlost', onContextLost)
  canvas.addEventListener('webglcontextrestored', onContextRestored)
  reducedMotion.addEventListener?.('change', onMotionPreference)

  // A layer captured before its web font arrived was rasterised with fallback
  // metrics, and a font finishing loading is not a mutation, so nothing else
  // would ever put it right.
  document.fonts?.ready.then(() => {
    if (destroyed) return
    for (const layer of layers) if (!isMedia(layer.el)) refreshLayer(layer)
  }).catch(() => {})

  const containerObserver = new ResizeObserver(() => { resize(false); wake() })
  containerObserver.observe(container)

  // A grid scrolled out of view is not worth a frame.
  const visibility = new IntersectionObserver((entries) => {
    offscreen = !entries.some((entry) => entry.isIntersecting)
    idleCheck()
  }, { rootMargin: '10%' })
  visibility.observe(container)

  return {
    canvas,
    params,
    physics,
    addLayer,
    pulse,

    /** A beat: excite the whole grid at once. Strength is roughly 0..1. */
    beat(strength = 1) {
      if (!ready || !Number.isFinite(strength)) return
      worker.postMessage({ type: 'beat', strength })
      wake()
    },

    /** A steady level of excitement that does not fade; 0 lets go. */
    drive(level = 0) {
      if (!ready || !Number.isFinite(level)) return
      worker.postMessage({ type: 'drive', level })
      if (level > 0) wake()
    },

    /** Re-roll the lottery and restart the sequence. */
    reseed(seed) {
      params.seed = seed >>> 0
      if (ready) worker.postMessage({ type: 'reseed', seed: params.seed })
    },

    get quality() {
      return { tier: governor.tier, auto: governor.auto, fps: governor.fps }
    },

    /** Tiles active right now, as of the last frame. */
    get active() {
      return activeTiles
    },

    get grid() {
      return { ...grid }
    },

    /** Pin a tier, or pass null to hand control back to the governor. */
    setQuality(tier) {
      params.quality = tier
      governor.setManual(tier)
    },

    /** Anything in DEFAULTS, or any solver parameter. Takes effect at once. */
    setParams(patch) {
      const before = { ...physics }
      const cell = params.cell
      const seed = params.seed
      applyOptions(patch)
      const changed = {}
      for (const name in physics) {
        if (physics[name] !== before[name]) changed[PARAM_INDEX[name]] = physics[name]
      }
      if (Object.keys(changed).length && ready) worker.postMessage({ type: 'params', patch: changed })
      // Compared by value, not by presence. A deep watcher hands the whole
      // options object over on every change, so testing for the key would
      // rebuild the grid on every drag of every unrelated slider.
      if (params.cell !== cell) resize(true)
      else if (params.seed !== seed) this.reseed(params.seed)
      for (const layer of layers) syncLayer(layer)
      needsDraw = true
      wake()
    },

    /** Every tile back to rest. */
    reset() {
      if (ready) worker.postMessage({ type: 'reset' })
      needsDraw = true
      wake()
    },

    destroy() {
      if (destroyed) return
      destroyed = true
      sleep()
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', endStroke)
      window.removeEventListener('pointercancel', endStroke)
      window.removeEventListener('blur', endStroke)
      window.removeEventListener('scroll', onScroll, { capture: true })
      window.removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', idleCheck)
      canvas.removeEventListener('webglcontextlost', onContextLost)
      canvas.removeEventListener('webglcontextrestored', onContextRestored)
      reducedMotion.removeEventListener?.('change', onMotionPreference)
      containerObserver.disconnect()
      visibility.disconnect()
      for (const layer of layers) releaseLayer(layer)
      layers.length = 0
      worker.terminate()
      renderer.dispose()
      renderer.gl.getExtension('WEBGL_lose_context')?.loseContext()
      canvas.remove()
    },
  }
}
