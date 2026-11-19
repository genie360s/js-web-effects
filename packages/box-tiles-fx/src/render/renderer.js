// The WebGL2 renderer: one context, one field texture, any number of content
// layers seen through it, and the grid drawn over the top.
//
// It knows nothing about the DOM or about the solver. It is handed a packed
// field, a list of layers with rectangles and textures, and a look, and it
// draws them.
//
// Copyright (c) 2026 Alex Mkwizu <alexgmkwizu@gmail.com> — MIT.

import {
  VERT_FULLSCREEN, VERT_LAYER, FRAG_LAYER, FRAG_LINES,
  createProgram, createTexture, createMesh,
} from './shaders.js'

export function createRenderer(canvas) {
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
    powerPreference: 'high-performance',
  })
  if (!gl) throw new Error('tiles: WebGL2 is not available')

  let programs = null
  let meshes = null
  let fieldTexture = null
  let size = { w: 1, h: 1, dpr: 1 }
  let grid = { w: 1, h: 1, across: 1, down: 1 }

  function build() {
    programs = {
      layer: createProgram(gl, VERT_LAYER, FRAG_LAYER),
      lines: createProgram(gl, VERT_FULLSCREEN, FRAG_LINES),
    }
    meshes = {
      triangle: createMesh(gl, new Float32Array([-1, -1, 3, -1, -1, 3])),
      quad: createMesh(gl, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1])),
    }
    // Nearest: a cell is a cell, and a texel filtered against its neighbour
    // would be a tile half shifted.
    fieldTexture = createTexture(gl, gl.NEAREST)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.BLEND)
  }

  function allocField() {
    gl.bindTexture(gl.TEXTURE_2D, fieldTexture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, grid.w, grid.h, 0, gl.RGBA, gl.HALF_FLOAT, null)
  }

  build()

  return {
    gl,

    /**
     * @param {number} pixelWidth  backing store
     * @param {number} pixelHeight
     * @param {number} dpr
     * @param {{w:number,h:number,across:number,down:number}} nextGrid
     *   texels in the field, and the fractional count of cells the surface
     *   actually spans, so cells stay square at the edge.
     */
    resize(pixelWidth, pixelHeight, dpr, nextGrid) {
      size = { w: pixelWidth, h: pixelHeight, dpr }
      canvas.width = pixelWidth
      canvas.height = pixelHeight
      const regrid = nextGrid.w !== grid.w || nextGrid.h !== grid.h
      grid = { ...nextGrid }
      if (regrid) allocField()
    },

    newLayerTexture: () => createTexture(gl),
    deleteTexture: (texture) => gl.deleteTexture(texture),

    /**
     * Half floats straight from the worker: four channels per cell.
     * Premultiplication is turned off explicitly: it applies to typed-array
     * uploads too, and this is not an image — the fourth channel is a
     * lottery number, not an opacity.
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
     * One frame: each layer through the tiles, in order, then the grid.
     * Everything is premultiplied, which is what lets the canvas sit
     * transparently over an ordinary web page.
     */
    draw(layers, look) {
      gl.viewport(0, 0, size.w, size.h)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, fieldTexture)

      const visible = layers.filter((layer) => layer.ready && layer.onScreen)
      if (visible.length) {
        programs.layer.use()
        programs.layer.set({
          uField: 0,
          uContent: 1,
          uGrid: [grid.across, grid.down],
          uFieldSize: [grid.w, grid.h],
          uAspect: [size.w / size.h, 1],
          uShadows: look.shadows,
          uHighlights: look.highlights,
          uGrade: look.grade,
          uExposure: look.exposure,
          uVignette: look.vignette,
        })
        gl.activeTexture(gl.TEXTURE1)
        for (const layer of visible) {
          gl.bindTexture(gl.TEXTURE_2D, layer.texture)
          programs.layer.set({
            uRect: layer.rect,
            uTiles: layer.tiles ? 1 : 0,
            uReveal: layer.reveal,
            // smoothstep with equal edges is undefined in GLSL
            uSoft: Math.max(layer.revealSoft, 1e-3),
            uSweep: layer.sweep,
          })
          meshes.quad.draw(gl.TRIANGLE_STRIP, 4)
        }
      }

      if (look.lineAlpha > 0) {
        // Either over the whole surface, or only where something has been
        // drawn: multiplying by the destination alpha masks the lines to the
        // content without a second pass.
        if (look.gridMask === 'content') gl.blendFuncSeparate(gl.DST_ALPHA, gl.ONE, gl.ZERO, gl.ONE)
        programs.lines.use()
        programs.lines.set({
          uGrid: [grid.across, grid.down],
          uResolution: [size.w, size.h],
          uLineColor: look.lineColor,
          uLineAlpha: look.lineAlpha,
          uLineWidth: Math.max(look.lineWidth * size.dpr, 0.5),
          uLineGlow: look.lineGlow,
        })
        meshes.triangle.draw(gl.TRIANGLES, 3)
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
      gl.deleteTexture(fieldTexture)
      programs = null
      meshes = null
    },
  }
}
