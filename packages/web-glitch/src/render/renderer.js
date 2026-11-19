// The WebGL2 renderer: one context, one quad, four textures.
//
// It knows nothing about the DOM or about the solver. It is handed the
// picture, the solver's bytes and a look, and it draws them.
//
// Copyright (c) 2026 Alex Mkwizu <alexgmkwizu@gmail.com> — MIT.

import { VERT, FRAG, FRAG_PROBE, drawGlyphs } from './shaders.js'

const UNIFORMS = ['uContent', 'uState', 'uGlow', 'uGlyphs', 'uCells', 'uGrid', 'uCellPx', 'uTime', 'uInk', 'uGlowColor', 'uKey', 'uKeyTol']

export function createRenderer(canvas) {
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
  })
  if (!gl) throw new Error('glitch: WebGL2 is not available')

  let program, uniforms, textures, probe
  let grid = { w: 1, h: 1, across: 1, down: 1 }
  let dpr = 1
  let cellPx = 1

  function compile(type, source) {
    const shader = gl.createShader(type)
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`glitch: shader failed to compile\n${gl.getShaderInfoLog(shader)}`)
    }
    return shader
  }

  function texture(filter) {
    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter === gl.NEAREST ? gl.NEAREST : gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return tex
  }

  function link(fragment) {
    const made = gl.createProgram()
    gl.attachShader(made, compile(gl.VERTEX_SHADER, VERT))
    gl.attachShader(made, compile(gl.FRAGMENT_SHADER, fragment))
    gl.bindAttribLocation(made, 0, 'aPos')
    gl.linkProgram(made)
    if (!gl.getProgramParameter(made, gl.LINK_STATUS)) {
      throw new Error(`glitch: program failed to link\n${gl.getProgramInfoLog(made)}`)
    }
    return made
  }

  function build() {
    program = link(FRAG)
    uniforms = Object.fromEntries(UNIFORMS.map((name) => [name, gl.getUniformLocation(program, name)]))
    probe = { program: link(FRAG_PROBE), target: texture(gl.NEAREST), frame: gl.createFramebuffer() }

    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

    textures = {
      content: texture(gl.LINEAR),
      // Nearest: a cell is a cell.
      state: texture(gl.NEAREST),
      glow: texture(gl.LINEAR),
      glyphs: texture(gl.LINEAR_MIPMAP_LINEAR),
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.bindTexture(gl.TEXTURE_2D, textures.glyphs)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, drawGlyphs())
    gl.generateMipmap(gl.TEXTURE_2D)
    // Empty until the first picture arrives, which draws as nothing.
    gl.bindTexture(gl.TEXTURE_2D, textures.content)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4))
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.BLEND)
  }

  build()

  return {
    gl,
    rebuild: build,

    /**
     * @param {{w:number,h:number,across:number,down:number}} nextGrid texels
     *   in the state, and the fractional count of cells the surface actually
     *   spans, so cells stay square at the edge.
     */
    resize(pixelWidth, pixelHeight, nextDpr, nextGrid, cellCss) {
      canvas.width = pixelWidth
      canvas.height = pixelHeight
      dpr = nextDpr
      cellPx = cellCss * dpr
      grid = { ...nextGrid }
    },

    /** An image, a video frame or a canvas. Throws if it is cross-origin without CORS. */
    uploadContent(source) {
      gl.bindTexture(gl.TEXTURE_2D, textures.content)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    },

    /** The solver's bytes: four a cell of state, one a cell of glow. */
    uploadField(state, glow) {
      gl.bindTexture(gl.TEXTURE_2D, textures.state)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, grid.w, grid.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, state)
      gl.bindTexture(gl.TEXTURE_2D, textures.glow)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, grid.w, grid.h, 0, gl.RED, gl.UNSIGNED_BYTE, glow)
    },

    /** `cutout` is the key tolerance, or 0 to draw the picture background and all. */
    draw(look, time, cutout) {
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.useProgram(program)
      ;['content', 'state', 'glow', 'glyphs'].forEach((name, unit) => {
        gl.activeTexture(gl.TEXTURE0 + unit)
        gl.bindTexture(gl.TEXTURE_2D, textures[name])
      })
      gl.activeTexture(gl.TEXTURE0)
      gl.uniform1i(uniforms.uContent, 0)
      gl.uniform1i(uniforms.uState, 1)
      gl.uniform1i(uniforms.uGlow, 2)
      gl.uniform1i(uniforms.uGlyphs, 3)
      gl.uniform2f(uniforms.uCells, grid.across, grid.down)
      gl.uniform2f(uniforms.uGrid, grid.w, grid.h)
      gl.uniform1f(uniforms.uCellPx, cellPx)
      gl.uniform1f(uniforms.uTime, time)
      gl.uniform3fv(uniforms.uInk, look.ink)
      gl.uniform3fv(uniforms.uGlowColor, look.glowColor)
      gl.uniform3fv(uniforms.uKey, look.key || [0, 0, 0])
      gl.uniform1f(uniforms.uKeyTol, look.key ? cutout : 0)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    },

    /**
     * The picture read back at two probes a cell: premultiplied RGBA, top row
     * first, `grid.w * 2` across.
     */
    probe() {
      const [w, h] = [grid.w * 2, grid.h * 2]
      gl.bindTexture(gl.TEXTURE_2D, probe.target)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.bindFramebuffer(gl.FRAMEBUFFER, probe.frame)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, probe.target, 0)
      gl.viewport(0, 0, w, h)
      gl.useProgram(probe.program)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, textures.content)
      const scale = [grid.w / grid.across, grid.h / grid.down]
      gl.uniform1i(gl.getUniformLocation(probe.program, 'uContent'), 0)
      gl.uniform2f(gl.getUniformLocation(probe.program, 'uScale'), ...scale)
      gl.uniform2f(gl.getUniformLocation(probe.program, 'uTap'), scale[0] / w / 4, scale[1] / h / 4)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      const pixels = new Uint8Array(w * h * 4)
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      return pixels
    },
  }
}
