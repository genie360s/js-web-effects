// The fire engine: one worker running the solver, one WebGL2 context drawing
// it, and any number of content layers that can catch light.
//
// It costs nothing when nothing is burning. The draw loop stops once the fire
// has gone out and the last smoke has cleared, and restarts the moment
// anything is lit, so an idle page holds no rAF callback at all — and the
// worker drops to a third of its rate rather than spinning.
//
// Copyright (c) 2026 Alex Mkwizu <alexgmkwizu@gmail.com> — MIT.

import { createRenderer } from './render/renderer.js'
import { TIERS, createGovernor, gridFor, pixelsFor } from './render/quality.js'
import { PARAM_DEFAULTS, PARAM_INDEX } from './sim/params.js'
import { captureElement, directSource, isLiveSource, isMedia } from './ui/capture.js'
import { linearRgb } from './render/shaders.js'

/** Mirrors MAX_EMBERS in wasm/src/lib.rs. */
const MAX_EMBERS = 768
/** Frames with nothing happening before the draw loop lets go. */
const SLEEP_AFTER = 4
/** A gap longer than this starts a new drag rather than joining the last point. */
const STROKE_RESTART_MS = 140

export const DEFAULTS = {
  // --- the scene ---------------------------------------------------------
  /**
   * How tall the viewport is, in metres. Everything in the solver is SI, so
   * this is the dial that decides what size of fire you are looking at: at
   * 0.3 it is a sheet of paper and the flames are small, quick and detailed;
   * at 4 it is a building and they are slow, broad and lazy. It also sets how
   * much work a frame is, because a smaller scene means faster flow through
   * the same grid, and faster flow means more sub-steps.
   */
  scene: 1.2,
  /** Fixed tier, or null to let the governor decide. */
  quality: null,
  interactive: true,

  // --- the torch ---------------------------------------------------------
  /** Radius of what the pointer lights, in CSS pixels. */
  torch: 26,
  /** How hot the pointer is, in K above ambient. */
  torchHeat: 1500,
  /** Pointer speed, in css px/s, at which dragging blows the air about. */
  fanSpeed: 900,
  /** How hard a fast drag pushes the air, in m/s. */
  fan: 3.5,

  // --- the look ----------------------------------------------------------
  exposure: 1.15,
  /** Pixels of refraction through hot air. This is the shimmer. */
  haze: 26,
  /** How dark char goes, 0..1 at full damage. */
  scorch: 1,
  /** Damage at which the material is gone. Below 1 it burns through sooner. */
  burn: 0.82,
  /** Brightness of the glowing edge around a hole. */
  glow: 2.2,
  /** How much soot it takes for the flame to look solid. */
  sootEmit: 2.4,
  /** The blue of the reaction zone. Real, and easy to overdo. */
  blue: 0.35,
  /** Optical depth of the smoke per unit of soot. */
  smoke: 0.55,
  smokeCool: '#6a6a72',
  smokeWarm: '#8c6a52',
  /** Spark size in CSS pixels at full heat. 0 turns them off. */
  emberSize: 3.2,

  // --- per layer, overridable on each ------------------------------------
  /** How combustible the layer is. 0 means it cannot catch at all. */
  fuel: 1,
}

const LAYER_KEYS = ['fuel', 'haze', 'scorch', 'burn', 'glow', 'invisible', 'capture', 'live']
const LOOK_KEYS = [
  'exposure', 'haze', 'scorch', 'burn', 'glow', 'sootEmit', 'blue', 'smoke',
  'smokeCool', 'smokeWarm', 'emberSize',
]

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)

/**
 * @param {HTMLElement} container must be positioned; the canvas is prepended
 * @param {object} options anything in DEFAULTS, plus any solver parameter from
 *   `src/sim/params.js`, plus `wasm` (a URL) and `worker` (a URL or factory)
 */
export async function createFire(container, options = {}) {
  if (!(container instanceof HTMLElement)) {
    throw new TypeError('fire: container must be an element')
  }
  if (!options.wasm) throw new TypeError('fire: pass wasm (a URL)')
  if (!options.worker) throw new TypeError('fire: pass worker (a URL or a factory)')

  const params = { ...DEFAULTS }
  const physics = { ...PARAM_DEFAULTS }
  // Parsed on change rather than per frame: they are two constants, and the
  // shader wants them in linear light.
  let smokeCool = []
  let smokeWarm = []
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

  let grid = { w: 0, h: 0 }
  let size = null
  let canvasRect = null
  // Sparks are copied out of the frame rather than viewed into it: the frame
  // buffer goes straight back to the worker by transfer, which detaches every
  // view onto it.
  const embers = new Float32Array(MAX_EMBERS * 4)
  let emberCount = 0
  let hasField = false

  let rafId = 0
  let running = false
  let destroyed = false
  let contextLost = false
  let offscreen = false
  let ready = false
  let solverIdle = true
  let rectsDirty = true
  let fuelDirty = true
  let needsDraw = true
  let idleFrames = 0
  let lastFrameAt = 0
  let lastPoint = null
  let fuelScratch = null

  // The tier the grid was last built for. A tier change rebuilds it, which
  // throws the fire away — the right trade when the alternative is a
  // slideshow, but not something to do for a change that is not a change.
  let builtTier = null

  const governor = createGovernor((tier, reason) => {
    if (builtTier !== null && tier !== builtTier) resize(true)
    container.dispatchEvent(new CustomEvent('fire:quality', {
      detail: { tier, reason, auto: governor.auto },
    }))
  })
  // Before the first build there is nothing to rebuild, and resizing here
  // would post a second `init` to a worker that has not answered the first.
  if (params.quality) governor.setManual(params.quality)

  function applyOptions(patch) {
    for (const key in patch) {
      if (key === 'wasm' || key === 'worker') continue
      if (key in PARAM_INDEX) physics[key] = patch[key]
      else if (key in DEFAULTS) params[key] = patch[key]
      else throw new TypeError(`fire: unknown option "${key}"`)
    }
    smokeCool = linearRgb(params.smokeCool)
    smokeWarm = linearRgb(params.smokeWarm)
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
    o.smokeCool = smokeCool
    o.smokeWarm = smokeWarm
    o.ambient = physics.ambient
    o.emberLife = physics.emberLife
    // Motion-sensitive visitors get the fire, not the shimmer: the haze is the
    // one part of this that moves everything on the page at once.
    if (reducedMotion.matches) o.haze = 0
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
    const tier = governor.tier
    const pixels = pixelsFor(tier, cssW, cssH)
    const next = gridFor(tier, cssW, cssH)
    const regrid = force || next.w !== grid.w || next.h !== grid.h
    size = { ...pixels, cssW, cssH }
    grid = next
    builtTier = tier
    rectsDirty = true
    needsDraw = true
    renderer.resize(pixels.w, pixels.h, pixels.dpr, grid.w, grid.h)
    if (!regrid) return

    hasField = false
    fuelScratch = null
    fuelDirty = true
    const settings = TIERS[tier]
    worker.postMessage({
      type: ready ? 'resize' : 'init',
      wasmUrl: options.wasm,
      w: grid.w,
      h: grid.h,
      cellMetres: params.scene / grid.h,
      params: physicsPatch({
        ...physics,
        maxSubsteps: settings.substeps,
        pressureIterations: settings.pressure,
        flameReach: settings.reach,
      }),
    })
  }

  // --- layers ---------------------------------------------------------------

  function layerOption(layer, key) {
    return layer.options[key] ?? params[key]
  }

  /** Copy the resolved options onto the layer, where the renderer reads them. */
  function syncLayer(layer) {
    layer.fuel = clamp(layerOption(layer, 'fuel'), 0, 8)
    // Fuel that is never drawn. A gas jet is not something you can see; what
    // you see is the flame standing on it.
    layer.invisible = layer.options.invisible === true
    layer.haze = layerOption(layer, 'haze')
    layer.scorch = layerOption(layer, 'scorch')
    layer.burn = Math.max(layerOption(layer, 'burn'), 1e-3)
    layer.glow = layerOption(layer, 'glow')
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
      fuelDirty = true
      if (!layer.ready) {
        layer.ready = true
        hideElement(layer)
      }
    } catch (err) {
      // A cross-origin image or video without CORS headers taints the upload.
      // Nothing can be drawn for this layer, so the page shows its own.
      layer.ready = false
      showElement(layer)
      console.warn('fire: cannot read this element as a texture', err)
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
      console.warn('fire: could not capture element', err)
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
    // form has to be watched separately or it burns as it first loaded.
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
    if (!(el instanceof HTMLElement)) throw new TypeError('fire: a layer must be an element')
    for (const key in layerOptions) {
      if (!LAYER_KEYS.includes(key)) throw new TypeError(`fire: "${key}" is not a per-layer option`)
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
        fuelDirty = true
        needsDraw = true
        wake()
      },
      destroy() {
        if (layer.removed) return
        releaseLayer(layer)
        renderer.deleteTexture(layer.texture)
        const index = layers.indexOf(layer)
        if (index >= 0) layers.splice(index, 1)
        fuelDirty = true
        needsDraw = true
        wake()
      },
    }
  }

  function updateRects() {
    canvasRect = canvas.getBoundingClientRect()
    for (const layer of layers) {
      const r = layer.el.getBoundingClientRect()
      const rect = [
        (r.left - canvasRect.left) / canvasRect.width,
        (r.top - canvasRect.top) / canvasRect.height,
        r.width / canvasRect.width,
        r.height / canvasRect.height,
      ]
      const onScreen = r.width > 0 && r.height > 0
        && r.right > canvasRect.left && r.left < canvasRect.right
        && r.bottom > canvasRect.top && r.top < canvasRect.bottom
      // Re-baking the fuel map means a synchronous readback, so it happens
      // only when something has actually moved. Scrolling re-measures every
      // frame and almost never changes anything.
      if (onScreen !== layer.onScreen || rect.some((v, i) => v !== layer.rect[i])) {
        fuelDirty = true
      }
      layer.rect = rect
      layer.onScreen = onScreen
    }
    rectsDirty = false
    needsDraw = true
  }

  /**
   * Tell the solver what there is to burn. The renderer composites the page
   * flat at grid resolution and reads its alpha back; the solver treats that
   * as fuel, keeping whatever has already charred.
   */
  function sendFuel() {
    fuelDirty = false
    if (!ready) return
    if (!layers.length) {
      // Nothing to burn but the air. A hero page with no content still wants
      // a fire, so the whole grid gets fuel.
      worker.postMessage({ type: 'fillFuel', amount: 1 })
      return
    }
    fuelScratch = renderer.readFuel(layers, look(), fuelScratch)
    if (!fuelScratch) {
      // An incomplete framebuffer, usually mid-resize. Ask again next frame:
      // giving up here leaves the page permanently non-combustible.
      fuelDirty = true
      return
    }
    const cells = grid.w * grid.h
    const bytes = new Uint8Array(cells)
    // No vertical flip. readPixels counts rows up from the bottom of the
    // framebuffer, and the bake draws into it with the projection already
    // inverted, so its first row is the top of the screen — which is the
    // grid's first row too. Flipping here as well put the page's fuel on
    // upside down, and the tell was subtle: the fire burned, just not where
    // anything was.
    for (let i = 0; i < cells; i++) bytes[i] = fuelScratch[i * 4 + 3]
    worker.postMessage({ type: 'fuel', buffer: bytes.buffer }, [bytes.buffer])
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
    if (fuelDirty) sendFuel()
    const busy = uploadLiveLayers() || !solverIdle

    if (needsDraw && hasField) {
      renderer.draw(layers, embers, emberCount, look())
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
        fuelDirty = true
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
        emberCount = Math.min(msg.embers, MAX_EMBERS)
        if (emberCount > 0) {
          embers.set(new Float32Array(msg.buffer, msg.w * msg.h * 4 * 2, emberCount * 4))
        }
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
      x: ((clientX - canvasRect.left) / canvasRect.width) * grid.w,
      y: ((clientY - canvasRect.top) / canvasRect.height) * grid.h,
    }
  }

  function cellsPerCssPixel() {
    return canvasRect?.width ? grid.w / canvasRect.width : 1
  }

  /** Hold a match to the page, and fan it if the hand is moving. */
  function ignite(spot) {
    if (!ready) return
    const at = spot.cells ?? toCells(spot.clientX, spot.clientY)
    if (!at) return
    const scale = cellsPerCssPixel()
    worker.postMessage({
      type: 'ignite',
      x: at.x,
      y: at.y,
      radius: Math.max((spot.radius ?? params.torch) * scale, 1),
      heat: spot.heat ?? params.torchHeat,
    })
    wake()
  }

  function onPointerMove(event) {
    if (!params.interactive || destroyed || !ready) return
    // Coalesced events keep a fast drag from turning into a polygon.
    const coalesced = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : null
    const batch = coalesced && coalesced.length ? coalesced : [event]
    for (const point of batch) {
      const when = point.timeStamp > 0 ? point.timeStamp : performance.now()
      const at = toCells(point.clientX, point.clientY)
      if (!at) continue
      const held = point.buttons > 0 || point.pressure > 0.1
      if (held) ignite({ cells: at })

      // Moving over the fire fans it. Speed in CSS pixels per second, because
      // that is the speed the hand is actually moving at.
      const joined = lastPoint && when - lastPoint.t < STROKE_RESTART_MS
      if (joined) {
        const dt = Math.max((when - lastPoint.t) / 1000, 1e-3)
        const dx = point.clientX - lastPoint.clientX
        const dy = point.clientY - lastPoint.clientY
        const speed = Math.hypot(dx, dy) / dt
        const push = clamp(speed / params.fanSpeed, 0, 1) * params.fan
        if (push > 0.05) {
          const inv = 1 / Math.max(Math.hypot(dx, dy), 1e-3)
          worker.postMessage({
            type: 'blow',
            x: at.x,
            y: at.y,
            radius: Math.max(params.torch * cellsPerCssPixel() * 1.8, 2),
            vx: dx * inv * push,
            vy: dy * inv * push,
          })
          wake()
        }
      }
      lastPoint = { clientX: point.clientX, clientY: point.clientY, t: when }
    }
  }

  function onPointerDown(event) {
    lastPoint = null
    if (!params.interactive) return
    ignite({ clientX: event.clientX, clientY: event.clientY })
  }

  const endStroke = () => { lastPoint = null }
  const onScroll = () => { rectsDirty = true; wake() }
  const onResize = () => { resize(false); wake() }

  /**
   * There are two reasons to stop, and they have to agree. Told separately,
   * the tab coming back would restart a worker solving a fire that is still
   * scrolled off the screen — and nothing would ever stop it again, because
   * the draw loop that notices idleness refuses to run while off screen.
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
    renderer.resize(size.w, size.h, size.dpr, grid.w, grid.h)
    for (const layer of layers) {
      layer.texture = renderer.newLayerTexture()
      layer.ready = false
      // The GPU has nothing to draw until it is captured again, so the real
      // element goes back on screen in the meantime.
      showElement(layer)
      refreshLayer(layer)
    }
    fuelDirty = true
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

  // A layer captured before its web font arrived was rasterised with fallback
  // metrics, and a font finishing loading is not a mutation, so nothing else
  // would ever put it right.
  document.fonts?.ready.then(() => {
    if (destroyed) return
    for (const layer of layers) if (!isMedia(layer.el)) refreshLayer(layer)
  }).catch(() => {})

  const containerObserver = new ResizeObserver(() => { resize(false); wake() })
  containerObserver.observe(container)

  // A fire scrolled out of view is not worth a frame.
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
    ignite,

    get quality() {
      return { tier: governor.tier, auto: governor.auto, fps: governor.fps }
    },

    /** Pin a tier, or pass null to hand control back to the governor. */
    setQuality(tier) {
      params.quality = tier
      governor.setManual(tier)
    },

    /** Anything in DEFAULTS, or any solver parameter. Takes effect at once. */
    setParams(patch) {
      const before = { ...physics }
      const scene = params.scene
      const fuel = params.fuel
      applyOptions(patch)
      const changed = {}
      for (const name in physics) {
        if (physics[name] !== before[name]) changed[PARAM_INDEX[name]] = physics[name]
      }
      if (Object.keys(changed).length) worker.postMessage({ type: 'params', patch: changed })
      // Compared by value, not by presence. A deep watcher hands the whole
      // options object over on every change, so testing for the key would
      // rebuild the grid — and put the fire out — on every drag of every
      // unrelated slider.
      if (params.scene !== scene) resize(true)
      if (params.fuel !== fuel) {
        for (const layer of layers) syncLayer(layer)
        fuelDirty = true
      }
      needsDraw = true
      wake()
    },

    /** Put it out and put the page back. */
    reset() {
      worker.postMessage({ type: 'reset' })
      fuelDirty = true
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
