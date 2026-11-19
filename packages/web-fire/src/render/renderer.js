// The WebGL2 renderer: one context, one field texture, any number of content
// layers, and the fire drawn over the top of them.
//
// It knows nothing about the DOM or about the solver. It is handed a packed
// field, a list of layers with rectangles and textures, and a list of sparks,
// and it draws them.
//
// Copyright (c) 2026 Alex Mkwizu <alexgmkwizu@gmail.com> — MIT.

import {
  VERT_FULLSCREEN, VERT_LAYER, FRAG_LAYER, FRAG_FLAME, VERT_EMBER, FRAG_EMBER,
  createProgram, createTexture, createMesh, createPointBuffer,
} from './shaders.js'
import { blackbodyTable } from './blackbody.js'

export function createRenderer(canvas) {
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
    powerPreference: 'high-performance',
  })
  if (!gl) throw new Error('fire: WebGL2 is not available')

  // RGBA16F is what carries a 2000 K flame and a 0.001 wisp of smoke in the
  // same texture. WebGL2 guarantees it is filterable as a *sampled* texture,
  // which is all the field ever is — the one pass that renders into a texture
  // writes bytes — so no extension is needed for it.

  let programs = null
  let meshes = null
  let points = null
  let fieldTexture = null
  let blackbodyTexture = null
  let fuelTexture = null
  let framebuffer = null
  let size = { w: 1, h: 1, dpr: 1 }
  let grid = { w: 1, h: 1 }
  let table = null

  function build() {
    programs = {
      layer: createProgram(gl, VERT_LAYER, FRAG_LAYER),
      flame: createProgram(gl, VERT_FULLSCREEN, FRAG_FLAME),
      ember: createProgram(gl, VERT_EMBER, FRAG_EMBER, ['aEmber']),
    }
    meshes = {
      triangle: createMesh(gl, new Float32Array([-1, -1, 3, -1, -1, 3])),
      quad: createMesh(gl, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1])),
    }
    points = createPointBuffer(gl, 1024)
    fieldTexture = createTexture(gl)
    fuelTexture = createTexture(gl, gl.NEAREST)
    framebuffer = gl.createFramebuffer()

    table = blackbodyTable()
    blackbodyTexture = createTexture(gl)
    gl.bindTexture(gl.TEXTURE_2D, blackbodyTexture)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, table.size, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, table.bytes)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)

    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.BLEND)
  }

  function allocField() {
    gl.bindTexture(gl.TEXTURE_2D, fieldTexture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, grid.w, grid.h, 0, gl.RGBA, gl.HALF_FLOAT, null)
    gl.bindTexture(gl.TEXTURE_2D, fuelTexture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, grid.w, grid.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  }

  /** Uniforms every surface program shares. */
  function common(look) {
    return {
      uField: 0,
      uBlackbody: 1,
      uFieldSize: [grid.w, grid.h],
      uResolution: [size.w, size.h],
      uAmbient: look.ambient,
      uBlackbodyRange: [table.minK, table.maxK],
      uExposure: look.exposure,
    }
  }

  function bindField() {
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, fieldTexture)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, blackbodyTexture)
  }

  /** Neutral layer uniforms: the content exactly as it was captured. */
  const FLAT = { uHaze: 0, uScorch: 0, uBurn: 1e6, uGlow: 0, uFuel: 1, uBurnable: 0 }

  build()

  return {
    gl,

    resize(pixelWidth, pixelHeight, dpr, gridWidth, gridHeight) {
      size = { w: pixelWidth, h: pixelHeight, dpr }
      canvas.width = pixelWidth
      canvas.height = pixelHeight
      const regrid = gridWidth !== grid.w || gridHeight !== grid.h
      grid = { w: gridWidth, h: gridHeight }
      if (regrid) allocField()
    },

    newLayerTexture: () => createTexture(gl),
    deleteTexture: (texture) => gl.deleteTexture(texture),

    /**
     * Half floats straight from the worker: four channels per cell.
     *
     * Premultiplication is turned off explicitly, and it matters more here
     * than anywhere. It applies to typed-array uploads as well as to images,
     * and this is not an image: the fourth channel is the temperature of the
     * burning surface, not an opacity. Left on, it multiplies the heat and
     * the soot by it, which zeroes the entire flame everywhere the surface
     * underneath has already burnt away — that is to say, everywhere the
     * flame actually is.
     */
    uploadField(texels) {
      gl.bindTexture(gl.TEXTURE_2D, fieldTexture)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, grid.w, grid.h, gl.RGBA, gl.HALF_FLOAT, texels)
    },

    /**
     * Upload one layer's pixels. Premultiplied, because linear filtering of
     * straight alpha fringes text with the background colour.
     */
    uploadLayer(texture, source) {
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
      } finally {
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      }
    },

    /**
     * What there is to burn, at grid resolution: the page composited flat,
     * read back, and reduced to one byte a cell.
     *
     * This is a synchronous readback, which stalls the pipeline — so it runs
     * only when the content actually changes, never per frame. Doing it on
     * the GPU is what makes it cheap enough to do at all: the alternative is
     * rasterising every layer again on the CPU at a second resolution.
     */
    readFuel(layers, look, into) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fuelTexture, 0)
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        return null
      }
      gl.viewport(0, 0, grid.w, grid.h)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      bindField()
      programs.layer.use()
      programs.layer.set({ ...common(look), ...FLAT, uContent: 2, uFlip: -1, uResolution: [grid.w, grid.h] })
      gl.activeTexture(gl.TEXTURE2)
      // Invisible layers are included here and nowhere else: being fuel
      // without being drawn is the whole point of them.
      for (const layer of layers) {
        if (!layer.ready || !layer.onScreen || layer.fuel <= 0) continue
        gl.bindTexture(gl.TEXTURE_2D, layer.texture)
        programs.layer.set({ uRect: layer.rect, uFuel: layer.fuel })
        meshes.quad.draw(gl.TRIANGLE_STRIP, 4)
      }
      gl.disable(gl.BLEND)

      const rgba = into ?? new Uint8Array(grid.w * grid.h * 4)
      gl.readPixels(0, 0, grid.w, grid.h, gl.RGBA, gl.UNSIGNED_BYTE, rgba)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.bindVertexArray(null)
      return rgba
    },

    /**
     * One frame: the page first, then the fire over it, then the sparks.
     *
     * The order is the order light arrives in. Smoke is in front of the page
     * and behind nothing, so it composites over; flame and embers emit, so
     * they add. All of it is premultiplied, which is also what lets the
     * canvas sit transparently over an ordinary web page.
     */
    draw(layers, embers, emberCount, look) {
      gl.viewport(0, 0, size.w, size.h)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      bindField()

      const shared = common(look)
      const visible = layers.filter((layer) => layer.ready && layer.onScreen && !layer.invisible)
      if (visible.length) {
        gl.enable(gl.BLEND)
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
        programs.layer.use()
        programs.layer.set({ ...shared, uContent: 2, uFlip: 1, uFuel: 1 })
        gl.activeTexture(gl.TEXTURE2)
        for (const layer of visible) {
          gl.bindTexture(gl.TEXTURE_2D, layer.texture)
          programs.layer.set({
            uRect: layer.rect,
            uBurnable: layer.fuel > 0 ? 1 : 0,
            uHaze: layer.haze * size.dpr,
            uScorch: layer.scorch,
            uBurn: layer.burn,
            uGlow: layer.glow,
          })
          meshes.quad.draw(gl.TRIANGLE_STRIP, 4)
        }
      }

      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      programs.flame.use()
      programs.flame.set({
        ...shared,
        uSootEmit: look.sootEmit,
        uBlue: look.blue,
        uSmoke: look.smoke,
        uSmokeCool: look.smokeCool,
        uSmokeWarm: look.smokeWarm,
      })
      meshes.triangle.draw(gl.TRIANGLES, 3)

      if (emberCount > 0 && look.emberSize > 0) {
        // Sparks are light sources: they add, they never occlude.
        gl.blendFunc(gl.ONE, gl.ONE)
        programs.ember.use()
        programs.ember.set({
          uBlackbody: 1,
          uFieldSize: [grid.w, grid.h],
          uAmbient: look.ambient,
          uBlackbodyRange: [table.minK, table.maxK],
          uExposure: look.exposure,
          uSize: look.emberSize * size.dpr,
          uLife: look.emberLife,
        })
        points.draw(embers, Math.min(emberCount, 1024))
      }

      gl.disable(gl.BLEND)
      gl.bindVertexArray(null)
    },

    rebuild() {
      build()
      allocField()
    },

    dispose() {
      if (!programs) return
      for (const program of Object.values(programs)) program.dispose()
      for (const mesh of Object.values(meshes)) mesh.dispose()
      points.dispose()
      gl.deleteTexture(fieldTexture)
      gl.deleteTexture(fuelTexture)
      gl.deleteTexture(blackbodyTexture)
      gl.deleteFramebuffer(framebuffer)
      programs = null
      meshes = null
      points = null
    },
  }
}
