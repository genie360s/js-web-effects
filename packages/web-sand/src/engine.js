// The sand engine: one WebGL2 context, one wasm field, any number of content
// layers drawn on top of it.
//
// It costs nothing when nothing is happening. The loop stops itself once the
// sand has settled and restarts on the next pointer move, scroll, resize or
// video frame, so an idle page holds no rAF callback at all.
//
// Copyright (c) 2026 Alex Mkwizu <alexgmkwizu@gmail.com> — MIT.

import {
  VERT_FULLSCREEN, VERT_FULLSCREEN_TARGET, VERT_LAYER,
  FRAG_BAKE, FRAG_SAND, FRAG_LAYER, FRAG_PIGMENT,
  createProgram, createTexture, createMesh, linearRgb,
} from './gl.js'
import { loadSand } from './sim.js'
import { captureElement, directSource, isLiveSource, isMedia } from './capture.js'

// slope range packed into the baked relief texture
const GRAD_ENCODE = 4.0
// quiet frames before the loop puts itself to sleep
const SLEEP_AFTER = 3
// a gap longer than this starts a new stroke instead of joining the last point
const STROKE_RESTART_MS = 140
const MAX_RELIEF_EDGE = 4096
const MAX_GRID = 1024
/// The stirring textures are this much finer than the simulation grid.
const PIGMENT_SCALE = 2
/// Pointer speed, in cells per second, that counts as a full-strength drag.
const FULL_PUSH_SPEED = 260

export const DEFAULTS = {
  grid: 256,              // cells along the longest axis
  maxDpr: 2,
  auto: true,             // scale the grid and textures down on weak devices
  interactive: true,

  // the stick
  radius: 7,              // css pixels; a stick tip, not a brush
  depth: 0.85,            // grid cells
  dwell: 0.9,             // extra depth per second of holding it still, pressed
  dwellCap: 3,            // seconds of holding after which it digs no deeper

  // how the sand behaves
  repose: 0.62,           // steepest stable slope, cells per cell
  recovery: 0,            // wind: >0 heals the beach, and redraws while it does
  disturbDecay: 0.4,      // how fast turned sand dries, per second
  driftDecay: 5,          // how fast the stirring dies away, per second
  drag: 0.6,              // how much of the sand under the stick travels with it
  passes: 2,

  // the beach
  rippleScale: 16,        // ripple wavelengths across the short axis
  rippleAmp: 0.1,
  dunes: 0.4,
  heightScale: 1,
  reliefAmp: 1,
  reliefScale: null,      // relief texture size vs canvas; null picks for you
  sparkle: 1,
  exposure: 1.05,
  light: [-0.45, -0.6, 0.66],
  sandLight: '#e8d7b5',
  sandDark: '#a88c63',
  sandDamp: '#b09472',

  // content layers
  displace: 26,           // pixels of slide down the slope
  warp: 0,                // pixels of resting bend from the standing ripples
  shade: 0.85,            // how much sand lighting reaches content
  stain: 0.25,            // how much turned sand discolours content
  bury: 1.1,              // piled height that hides content; 0 disables

  // stirring content colour through the sand
  pickup: 0.35,           // how readily the stick lifts colour off content
  pigment: 1,             // how strongly lifted colour shows in the sand
  spread: 0.16,           // how much the stirring blends as it goes
  scrape: 0.18,           // how much lifting the colour fades the content
}

const RELIEF_KEYS = ['rippleScale', 'rippleAmp', 'dunes', 'reliefScale']
const SIM_KEYS = ['repose', 'recovery', 'disturbDecay', 'driftDecay', 'drag', 'passes']

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)

// smaller grid and lighter textures where the device cannot spare them
function autoTune(params) {
  if (!params.auto) return params
  const weak = (navigator.deviceMemory || 8) <= 4 || (navigator.hardwareConcurrency || 8) <= 4
  return {
    ...params,
    grid: Math.min(params.grid, weak ? 160 : 256),
    maxDpr: Math.min(params.maxDpr, weak ? 1.5 : 2),
    reliefScale: params.reliefScale ?? (weak ? 0.6 : 1),
  }
}

// container must be positioned; the canvas is prepended into it
export async function createSand(container, options = {}) {
  if (!(container instanceof HTMLElement)) {
    throw new TypeError('sand: container must be an element')
  }
  if (!options.wasm) throw new TypeError('sand: pass wasm (a URL or bytes)')
  const params = autoTune({ ...DEFAULTS, ...options })
  const sand = await loadSand(options.wasm)

  const canvas = document.createElement('canvas')
  canvas.setAttribute('aria-hidden', 'true')
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none'
  container.prepend(canvas)

  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
    powerPreference: 'high-performance',
  })
  if (!gl) {
    canvas.remove()
    throw new Error('sand: WebGL2 is not available')
  }

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  const layers = []

  let field = null
  let gw = 0
  let gh = 0
  let cellPx = 1
  let size = null
  let canvasRect = null

  let programs = null
  let meshes = null
  let fieldTexture = null
  let reliefTexture = null
  let contentTexture = null
  let pigmentTextures = null
  let pigmentIndex = 0
  let pigmentSize = [2, 2]
  let framebuffer = null
  let reliefFormat = null
  let common = null
  let contentDirty = true

  let rafId = 0
  let running = false
  let destroyed = false
  let contextLost = false
  let offscreen = false
  let rectsDirty = true
  let needsDraw = true
  let idleFrames = 0
  let lastTime = 0
  let lastPoint = null
  let holding = null

  // --- gl resources ---------------------------------------------------------

  function initGL() {
    programs = {
      bake: createProgram(gl, VERT_FULLSCREEN_TARGET, FRAG_BAKE),
      sand: createProgram(gl, VERT_FULLSCREEN, FRAG_SAND),
      layer: createProgram(gl, VERT_LAYER, FRAG_LAYER),
      pigment: createProgram(gl, VERT_FULLSCREEN_TARGET, FRAG_PIGMENT),
    }
    meshes = {
      triangle: createMesh(gl, new Float32Array([-1, -1, 3, -1, -1, 3])),
      quad: createMesh(gl, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1])),
    }
    // rendering to half-float keeps the baked gradient smooth; RGBA8 is the
    // fallback and leans on the dither to hide its steps
    reliefFormat = gl.getExtension('EXT_color_buffer_float')
      ? { internal: gl.RGBA16F, type: gl.HALF_FLOAT }
      : { internal: gl.RGBA8, type: gl.UNSIGNED_BYTE }
    fieldTexture = createTexture(gl)
    reliefTexture = createTexture(gl)
    contentTexture = createTexture(gl)
    pigmentTextures = [createTexture(gl), createTexture(gl)]
    pigmentIndex = 0
    framebuffer = gl.createFramebuffer()
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.BLEND)
    syncParams()
  }

  function disposeGL() {
    if (!programs) return
    for (const program of Object.values(programs)) program.dispose()
    for (const mesh of Object.values(meshes)) mesh.dispose()
    gl.deleteTexture(fieldTexture)
    gl.deleteTexture(reliefTexture)
    gl.deleteTexture(contentTexture)
    for (const texture of pigmentTextures) gl.deleteTexture(texture)
    gl.deleteFramebuffer(framebuffer)
    for (const layer of layers) gl.deleteTexture(layer.texture)
    programs = meshes = fieldTexture = reliefTexture = framebuffer = null
    contentTexture = pigmentTextures = null
  }

  function syncParams() {
    common = {
      uField: 0,
      uRelief: 1,
      uFieldSize: [gw, gh],
      uResolution: [size ? size.w : 1, size ? size.h : 1],
      uLightDir: params.light,
      uSandLight: linearRgb(params.sandLight),
      uSandDark: linearRgb(params.sandDark),
      uSandDamp: linearRgb(params.sandDamp),
      uEncode: GRAD_ENCODE,
      uHeightScale: params.heightScale,
      uReliefAmp: params.reliefAmp,
      uSparkle: params.sparkle,
      uExposure: params.exposure,
      uPigment: 3,
      uPigmentMix: params.pigment,
    }
  }

  function allocFieldTexture() {
    gl.bindTexture(gl.TEXTURE_2D, fieldTexture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, gw, gh, 0, gl.RGBA, gl.HALF_FLOAT, null)
  }

  // The flattened page and the colour stirred out of it. Eight bits per channel
  // is plenty for pigment and is filterable everywhere.
  function allocStirTextures() {
    pigmentSize = [gw * PIGMENT_SCALE, gh * PIGMENT_SCALE]
    for (const texture of [contentTexture, ...pigmentTextures]) {
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, pigmentSize[0], pigmentSize[1], 0,
        gl.RGBA, gl.UNSIGNED_BYTE, null)
    }
    contentDirty = true
  }

  function clearPigment() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    for (const texture of pigmentTextures) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    needsDraw = true
  }

  function bakeRelief() {
    const scale = params.reliefScale ?? 1
    const rw = clamp(Math.round(size.w * scale), 2, MAX_RELIEF_EDGE)
    const rh = clamp(Math.round(size.h * scale), 2, MAX_RELIEF_EDGE)
    gl.bindTexture(gl.TEXTURE_2D, reliefTexture)
    gl.texImage2D(gl.TEXTURE_2D, 0, reliefFormat.internal, rw, rh, 0, gl.RGBA, reliefFormat.type, null)

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, reliefTexture, 0)
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      throw new Error(`sand: relief framebuffer is incomplete (0x${status.toString(16)})`)
    }
    gl.viewport(0, 0, rw, rh)
    programs.bake.use()
    programs.bake.set({
      uResolution: [rw, rh],
      uScale: params.rippleScale,
      uRippleAmp: params.rippleAmp,
      uDunes: params.dunes,
      uEncode: GRAD_ENCODE,
    })
    meshes.triangle.draw(gl.TRIANGLES, 3)
    gl.bindVertexArray(null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    needsDraw = true
  }

  function measure() {
    const rect = container.getBoundingClientRect()
    const cssW = Math.max(1, rect.width)
    const cssH = Math.max(1, rect.height)
    const dpr = Math.min(window.devicePixelRatio || 1, params.maxDpr)
    return { cssW, cssH, dpr, w: Math.max(2, Math.round(cssW * dpr)), h: Math.max(2, Math.round(cssH * dpr)) }
  }

  function resize(force) {
    // A lost context has no objects to resize into; the restore handler rebuilds
    // everything anyway.
    if (contextLost) return
    const next = measure()
    const same = size && next.w === size.w && next.h === size.h
    size = next
    rectsDirty = true
    if (same && !force) return
    canvas.width = size.w
    canvas.height = size.h
    // square cells: the longest axis gets `grid` of them
    const cell = Math.max(size.w, size.h) / params.grid
    const nextW = clamp(Math.round(size.w / cell), 4, MAX_GRID)
    const nextH = clamp(Math.round(size.h / cell), 4, MAX_GRID)
    const regrid = force || !field || nextW !== gw || nextH !== gh
    gw = nextW
    gh = nextH
    cellPx = size.w / gw

    // Reallocating the field throws away whatever was drawn on it, so it only
    // happens when the grid really changes shape. A phone hiding its URL bar
    // must not wipe the sand.
    if (regrid) {
      field?.destroy()
      field = sand.create(gw, gh)
      field.setParams(params)
      allocFieldTexture()
      allocStirTextures()
      clearPigment()
    }
    syncParams()
    bakeRelief()
    needsDraw = true
  }

  // only the rectangle the sim reports as changed goes up the bus
  function uploadField() {
    const [x0, y0, x1, y1] = field.dirty
    const w = x1 - x0
    const h = y1 - y0
    if (w <= 0 || h <= 0) return
    gl.bindTexture(gl.TEXTURE_2D, fieldTexture)
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, gw)
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x0)
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y0)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, w, h, gl.RGBA, gl.HALF_FLOAT, field.texels)
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0)
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0)
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0)
  }

  // --- layers ---------------------------------------------------------------

  function layerIsLive(layer) {
    if (!layer.source || !isLiveSource(layer.el)) return false
    if (layer.el instanceof HTMLVideoElement) {
      return !layer.el.paused && !layer.el.ended && layer.el.readyState >= 2
    }
    return layer.options.live !== false
  }

  function uploadLayerTexture(layer, source) {
    if (source instanceof HTMLVideoElement && source.readyState < 2) return
    gl.bindTexture(gl.TEXTURE_2D, layer.texture)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
      needsDraw = true
      contentDirty = true
      if (!layer.ready) {
        layer.ready = true
        hideLayerElement(layer)
      }
    } catch (err) {
      // A cross-origin image or video without CORS headers taints the upload.
      // Nothing will be drawn for this layer, so the page has to show its own.
      layer.ready = false
      showLayerElement(layer)
      console.warn('sand: cannot read this element as a texture', err)
    } finally {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    }
  }

  async function refreshLayer(layer) {
    if (layer.removed || contextLost || destroyed) return
    const direct = directSource(layer.el)
    if (direct) {
      layer.source = direct
      uploadLayerTexture(layer, direct)
      wake()
      return
    }
    // an image or video with no pixels yet: its load event brings us back
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
      // Nothing needs the snapshot once it is on the GPU, and an SVG image left
      // alive keeps the browser re-rasterising it. Only live sources are kept.
      layer.source = null
      wake()
    } catch (err) {
      console.warn('sand: could not capture element', err)
    } finally {
      layer.capturing = false
      if (layer.recaptureQueued && !layer.removed) {
        layer.recaptureQueued = false
        refreshLayer(layer)
      }
    }
  }

  // videos tell us when a frame is actually ready; anything else is polled
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

  // The live element goes transparent only once the GPU is drawing it, so a
  // browser without WebGL2 shows the ordinary page. The engine does it rather
  // than the caller: writing the style from outside would come straight back
  // through this layer's own MutationObserver as another rasterisation.
  function reobserve(layer) {
    const el = layer.el
    layer.observers.length = 0
    if (layer.onEdited) {
      for (const kind of ['input', 'change', 'focusin', 'focusout']) {
        el.removeEventListener(kind, layer.onEdited, true)
      }
    }

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

    // live DOM has to be re-rasterised when it changes; media does not
    if (!isMedia(el)) {
      const onMutated = new MutationObserver(() => recapture(layer, 60))
      onMutated.observe(el, { subtree: true, childList: true, characterData: true, attributes: true })
      layer.observers.push(onMutated)

      // Typing, ticking a box and focus rings are none of them mutations, so
      // forms need to be watched separately or they rasterise as they loaded.
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

  function hideLayerElement(layer) {
    if (layer.hidden) return
    layer.hidden = true
    layer.restoreOpacity = layer.el.style.opacity
    for (const observer of layer.observers) observer.disconnect()
    layer.el.style.opacity = '0'
    reobserve(layer)
  }

  function showLayerElement(layer) {
    if (!layer.hidden) return
    layer.hidden = false
    for (const observer of layer.observers) observer.disconnect()
    layer.el.style.opacity = layer.restoreOpacity ?? ''
    if (!layer.removed) reobserve(layer)
  }

  // Everything a layer holds on to outside the GL texture.
  function releaseLayer(layer) {
    showLayerElement(layer)
    layer.removed = true
    clearTimeout(layer.debounce)
    for (const observer of layer.observers) observer.disconnect()
    if (layer.onEdited) {
      for (const kind of ['input', 'change', 'focusin', 'focusout']) {
        layer.el.removeEventListener(kind, layer.onEdited, true)
      }
    }
    if (layer.onLoaded) {
      layer.el.removeEventListener('load', layer.onLoaded)
      layer.el.removeEventListener('loadeddata', layer.onLoaded)
      layer.el.removeEventListener('play', layer.onLoaded)
    }
  }

  function addLayer(el, layerOptions = {}) {
    if (!(el instanceof HTMLElement)) throw new TypeError('sand: layer target must be an element')
    const layer = {
      el,
      options: { ...layerOptions },
      texture: createTexture(gl),
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

    reobserve(layer)

    // A <canvas> cannot tell us when it was drawn on, so it is only re-read
    // every frame when the caller asks for that with `live`. Otherwise it is
    // taken once, like any other content, and the loop can still go to sleep.
    if (el instanceof HTMLCanvasElement && layer.options.live === true) {
      layer.pollFrames = true
    }

    if (isMedia(el)) {
      layer.onLoaded = () => refreshLayer(layer)
      el.addEventListener('load', layer.onLoaded)
      el.addEventListener('loadeddata', layer.onLoaded)
      el.addEventListener('play', layer.onLoaded)
      if (el instanceof HTMLVideoElement) watchVideo(layer)
    }

    layers.push(layer)
    rectsDirty = true
    refreshLayer(layer)

    return {
      update: () => refreshLayer(layer),
      setOptions(next) {
        Object.assign(layer.options, next)
        needsDraw = true
        wake()
      },
      destroy() {
        if (layer.removed) return
        releaseLayer(layer)
        if (programs) gl.deleteTexture(layer.texture)
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
    contentDirty = true
  }

  // --- frame ----------------------------------------------------------------

  function bindPass(texture, width, height) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
    gl.viewport(0, 0, width, height)
  }

  // The page, flattened and undistorted, small. It is what the stick lifts its
  // colour from, so it only has to be as fine as the stirring is.
  function renderContent() {
    bindPass(contentTexture, pigmentSize[0], pigmentSize[1])
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    programs.layer.use()
    programs.layer.set({
      ...common,
      uContent: 2,
      uResolution: pigmentSize,
      uFlip: -1,
      uDisplace: 0,
      uWarp: 0,
      uShade: 0,
      uStain: 0,
      uBury: 0,
      uScrape: 0,
    })
    gl.activeTexture(gl.TEXTURE2)
    for (const layer of layers) {
      if (!layer.ready || !layer.onScreen) continue
      gl.bindTexture(gl.TEXTURE_2D, layer.texture)
      programs.layer.set({ uRect: layer.rect })
      meshes.quad.draw(gl.TRIANGLE_STRIP, 4)
    }
    gl.disable(gl.BLEND)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    contentDirty = false
  }

  // One step of stirring: colour is lifted where the sand was turned and
  // carried along the drift the stick left.
  function stirPigment(dt) {
    const target = pigmentTextures[1 - pigmentIndex]
    bindPass(target, pigmentSize[0], pigmentSize[1])
    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(gl.TEXTURE_2D, pigmentTextures[pigmentIndex])
    gl.activeTexture(gl.TEXTURE4)
    gl.bindTexture(gl.TEXTURE_2D, contentTexture)
    programs.pigment.use()
    programs.pigment.set({
      uField: 0,
      uPigment: 3,
      uContent: 4,
      uFieldSize: [gw, gh],
      uTexel: [1 / pigmentSize[0], 1 / pigmentSize[1]],
      uDt: dt,
      uPickup: params.pickup,
      uSpread: params.spread,
      uFade: params.recovery,
    })
    meshes.triangle.draw(gl.TRIANGLES, 3)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    pigmentIndex = 1 - pigmentIndex
    needsDraw = true
  }

  function draw() {
    gl.viewport(0, 0, size.w, size.h)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, fieldTexture)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, reliefTexture)
    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(gl.TEXTURE_2D, pigmentTextures[pigmentIndex])

    programs.sand.use()
    programs.sand.set(common)
    meshes.triangle.draw(gl.TRIANGLES, 3)

    const visible = layers.filter((layer) => layer.ready && layer.onScreen)
    if (visible.length) {
      // motion-sensitive visitors get the sand, not the sliding text
      const displaceScale = reducedMotion.matches ? 0 : 1
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      programs.layer.use()
      programs.layer.set({ ...common, uContent: 2, uFlip: 1 })
      gl.activeTexture(gl.TEXTURE2)
      for (const layer of visible) {
        gl.bindTexture(gl.TEXTURE_2D, layer.texture)
        const o = layer.options
        programs.layer.set({
          uRect: layer.rect,
          uDisplace: (o.displace ?? params.displace) * size.dpr * displaceScale,
          uWarp: (o.warp ?? params.warp) * size.dpr,
          uShade: o.shade ?? params.shade,
          uStain: o.stain ?? params.stain,
          uBury: o.bury ?? params.bury,
          uScrape: o.scrape ?? params.scrape,
        })
        meshes.quad.draw(gl.TRIANGLE_STRIP, 4)
      }
      gl.disable(gl.BLEND)
    }
    gl.bindVertexArray(null)
    needsDraw = false
  }

  // Videos that have a new frame, and canvases the caller asked us to watch.
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
    if (!programs || !field) return sleep()
    rafId = requestAnimationFrame(tick)
    const dt = lastTime ? Math.min((now - lastTime) / 1000, 0.05) : 0
    lastTime = now

    let busy = false
    if (pressDwell(now)) busy = true
    if (field.step(dt)) {
      uploadField()
      needsDraw = true
      busy = true
    }
    if (field.active) busy = true
    if (rectsDirty) updateRects()

    if (uploadLiveLayers()) busy = true

    // Stirring only has to run while the sand is actually moving; once it
    // stops, the colour it carried stays where it was left.
    if (busy && dt > 0) {
      if (contentDirty) renderContent()
      stirPigment(dt)
    }

    if (needsDraw) draw()
    idleFrames = busy ? 0 : idleFrames + 1
    if (idleFrames > SLEEP_AFTER) sleep()
  }

  function wake() {
    if (running || destroyed || contextLost || offscreen || document.hidden) return
    running = true
    idleFrames = 0
    lastTime = 0
    rafId = requestAnimationFrame(tick)
  }

  function sleep() {
    running = false
    if (rafId) cancelAnimationFrame(rafId)
    rafId = 0
  }

  // --- input ----------------------------------------------------------------

  function stickRadius() {
    // Below a cell the field carves a fainter mark rather than nothing, so a
    // very fine stick is still worth asking for.
    return Math.max(0.05, (params.radius * size.dpr) / cellPx)
  }

  function strokeTo(clientX, clientY, pressure, when) {
    if (!canvasRect || rectsDirty) updateRects()
    if (!canvasRect.width || !canvasRect.height) return
    const x = ((clientX - canvasRect.left) / canvasRect.width) * gw
    const y = ((clientY - canvasRect.top) / canvasRect.height) * gh
    const now = when
    const joined = lastPoint && now - lastPoint.t < STROKE_RESTART_MS
    if (joined) {
      // How hard the stick is travelling: it does not move more sand, it throws
      // what it moves further ahead, and leaves more drift to stir colour along.
      const seconds = Math.max((now - lastPoint.t) / 1000, 1e-3)
      const speed = Math.hypot(x - lastPoint.x, y - lastPoint.y) / seconds
      const push = clamp(speed / FULL_PUSH_SPEED, 0, 1)
      field.stroke(lastPoint.x, lastPoint.y, x, y, stickRadius(),
        params.depth * (0.55 + 0.9 * pressure), push)
      if (holding) holding.since = now // a stick that is moving is not dwelling
    }
    lastPoint = { x, y, t: now }
    if (holding) {
      holding.x = x
      holding.y = y
    }
  }

  // Holding the stick down in one place keeps pressing it in, deeper the longer
  // it is held. Each frame asks for a slightly deeper cut than the last; the
  // field's own floor is what stops the pit growing without end.
  function pressDwell(now) {
    if (!holding || !params.dwell) return false
    const held = Math.min((now - holding.since) / 1000, params.dwellCap)
    const depth = params.depth * (0.3 + params.dwell * held)
    field.stroke(holding.x, holding.y, holding.x, holding.y, stickRadius(), depth, 0)
    return true
  }

  // A pen reports real pressure. A mouse reports none, so leaning on the button
  // stands in for pressing harder.
  function pressureOf(point) {
    if (point.pressure > 0) return point.pressure
    return point.buttons ? 1 : 0.45
  }

  function onPointerMove(event) {
    if (!params.interactive || destroyed || !field) return
    // coalesced events keep a fast drag from turning into a polygon
    const coalesced = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : null
    const batch = coalesced && coalesced.length ? coalesced : [event]
    for (const point of batch) {
      // Coalesced points are delivered in one go but happened at different
      // times; using the clock here would make every drag look equally fast.
      const when = point.timeStamp > 0 ? point.timeStamp : performance.now()
      strokeTo(point.clientX, point.clientY, pressureOf(point), when)
    }
    wake()
  }

  function onPointerDown(event) {
    lastPoint = null
    if (!params.interactive || destroyed || !field) return
    if (!canvasRect || rectsDirty) updateRects()
    if (!canvasRect.width || !canvasRect.height) return
    holding = {
      x: ((event.clientX - canvasRect.left) / canvasRect.width) * gw,
      y: ((event.clientY - canvasRect.top) / canvasRect.height) * gh,
      since: performance.now(),
    }
    wake()
  }

  const endStroke = () => { lastPoint = null; holding = null }
  const onScroll = () => { rectsDirty = true; wake() }
  const onResize = () => { resize(false); wake() }
  const onVisibility = () => { if (document.hidden) sleep(); else wake() }

  function onContextLost(event) {
    event.preventDefault()
    contextLost = true
    sleep()
    // Nothing can be drawn until the context comes back, so the page shows its
    // own elements again in the meantime.
    for (const layer of layers) showLayerElement(layer)
  }

  function onContextRestored() {
    contextLost = false
    // Everything on the GPU went with the context, but the field itself lives
    // in wasm memory: rebuild the textures and have it re-upload what it holds,
    // rather than resizing, which would throw the drawing away.
    initGL()
    allocFieldTexture()
    allocStirTextures()
    clearPigment()
    bakeRelief()
    field.repack()
    for (const layer of layers) {
      layer.texture = createTexture(gl)
      layer.ready = false
      // The GPU has nothing to draw until it is captured again, so the real
      // element goes back on screen in the meantime.
      showLayerElement(layer)
      refreshLayer(layer)
    }
    wake()
  }

  // Build first. Nothing starts listening until there is something to draw
  // with, so a failure here cannot leave observers firing at a dead engine.
  try {
    initGL()
    resize(true)
    updateRects()
  } catch (err) {
    disposeGL()
    field?.destroy()
    field = null
    canvas.remove()
    throw err
  }

  window.addEventListener('pointermove', onPointerMove, { passive: true })
  window.addEventListener('pointerdown', onPointerDown, { passive: true })
  window.addEventListener('pointerup', endStroke, { passive: true })
  window.addEventListener('pointercancel', endStroke, { passive: true })
  window.addEventListener('blur', endStroke)
  window.addEventListener('scroll', onScroll, { passive: true, capture: true })
  window.addEventListener('resize', onResize, { passive: true })
  document.addEventListener('visibilitychange', onVisibility)
  canvas.addEventListener('webglcontextlost', onContextLost)
  canvas.addEventListener('webglcontextrestored', onContextRestored)

  // A layer captured before its web font arrived was rasterised with fallback
  // metrics, and a font finishing loading is not a mutation, so nothing would
  // ever put it right.
  document.fonts?.ready.then(() => {
    if (destroyed) return
    for (const layer of layers) {
      if (!isMedia(layer.el)) refreshLayer(layer)
    }
  }).catch(() => {})

  const containerObserver = new ResizeObserver(() => { resize(false); wake() })
  containerObserver.observe(container)

  // a surface scrolled out of view is not worth a single frame
  const visibility = new IntersectionObserver((entries) => {
    offscreen = !entries.some((entry) => entry.isIntersecting)
    if (offscreen) sleep()
    else wake()
  }, { rootMargin: '10%' })
  visibility.observe(container)

  wake()

  return {
    canvas,
    params,
    addLayer,

    reset() {
      field.reset()
      wake()
    },

    // layer options override these for the layers that set them
    setParams(patch) {
      const changed = Object.keys(patch).filter((key) => patch[key] !== params[key])
      Object.assign(params, patch)
      if (changed.some((key) => SIM_KEYS.includes(key))) field.setParams(params)
      syncParams()
      if (changed.some((key) => RELIEF_KEYS.includes(key))) bakeRelief()
      if (changed.includes('grid') || changed.includes('maxDpr')) resize(true)
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
      document.removeEventListener('visibilitychange', onVisibility)
      canvas.removeEventListener('webglcontextlost', onContextLost)
      canvas.removeEventListener('webglcontextrestored', onContextRestored)
      containerObserver.disconnect()
      visibility.disconnect()
      for (const layer of layers) releaseLayer(layer)
      disposeGL()
      layers.length = 0
      field?.destroy()
      field = null
      gl.getExtension('WEBGL_lose_context')?.loseContext()
      canvas.remove()
    },
  }
}
