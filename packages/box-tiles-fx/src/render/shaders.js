// WebGL2 side of the tiles: the GLSL, and the plumbing that turns it into
// programs, textures and meshes.
//
// Two programs share one description of the field:
//   layer  - a piece of content, seen through the tiles over it
//   lines  - the grid itself, drawn over everything
//
// Copyright (c) 2026 Alex Mkwizu <alexgmkwizu@gmail.com> — MIT.

/** A lift at or below this is read as "the tile is black". Mirrors lib.rs. */
export const BLACK_THRESHOLD = -8

/**
 * The reveal curve, as the shader computes it. Kept here in JavaScript as
 * well so `tiles.check.js` can assert its ends: that nothing shows at 0,
 * everything at 1, whatever the lottery dealt a cell.
 *
 * The lottery is squeezed into [soft, 1] first, so the edge of the softest
 * cell still starts at 0 and the edge of the hardest still ends at 1.
 */
export function revealAlpha(lot, reveal, soft) {
  const t = soft + lot * (1 - soft)
  return smoothstep(t - soft, t, reveal)
}

/** The lift, as the shader applies it: a gain, or black. */
export function liftGain(lift) {
  if (lift <= BLACK_THRESHOLD) return { black: true, gain: 0 }
  return { black: false, gain: 2 ** Math.min(Math.max(lift, -8), 8) }
}

function smoothstep(e0, e1, x) {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1)
  return t * t * (3 - 2 * t)
}

/**
 * UV origin is top-left everywhere, matching both DOM coordinates and the
 * solver's grid. The canvas puts clip-space +1 at the top, so y is flipped.
 */
export const VERT_FULLSCREEN = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

export const VERT_LAYER = `#version 300 es
in vec2 aPos;
uniform vec4 uRect;         // x, y, w, h in top-left surface UV
out vec2 vUv;               // content UV
out vec2 vScreen;           // surface UV
void main() {
  vUv = aPos * 0.5 + 0.5;
  vScreen = uRect.xy + vUv * uRect.zw;
  gl_Position = vec4(vScreen.x * 2.0 - 1.0, 1.0 - vScreen.y * 2.0, 0.0, 1.0);
}`

/**
 * A piece of content as the tiles leave it. Each fragment finds its cell,
 * reads what that cell is doing, and draws the content from wherever the
 * cell points — a few cells away for a shifted tile — brightened or
 * blacked, graded, and revealed against the cell's lottery number.
 *
 * Content textures are premultiplied; the grade works on the colour under
 * the alpha and puts it back.
 */
export const FRAG_LAYER = `#version 300 es
precision highp float;
uniform sampler2D uContent;
uniform sampler2D uField;      // RGBA16F per cell: dx, dy, lift, lot
uniform vec4 uRect;
uniform vec2 uGrid;            // cells across and down; fractional at the edge
uniform vec2 uFieldSize;       // texels in the field
uniform vec2 uAspect;          // (w/h, 1), so the vignette is round
uniform float uTiles;          // 1 seen through the tiles, 0 drawn flat
uniform float uReveal;         // 0..1
uniform float uSoft;           // width of the reveal edge
uniform float uSweep;          // 0 tile lottery, 1 left-to-right wipe
uniform vec3 uShadows;
uniform vec3 uHighlights;
uniform float uGrade;
uniform float uExposure;
uniform float uVignette;
in vec2 vUv;
in vec2 vScreen;
out vec4 o;

void main() {
  vec2 cell = clamp(floor(vScreen * uGrid), vec2(0.0), uFieldSize - 1.0);
  vec4 raw = texelFetch(uField, ivec2(cell), 0);
  vec4 fd = raw * uTiles;

  // The tile shows the picture from a few cells away. Off the edge of the
  // content there is nothing to show, and nothing is drawn.
  vec2 s = vScreen + fd.xy / uGrid;
  vec2 c = (s - uRect.xy) / uRect.zw;
  vec2 in2 = step(vec2(0.0), c) * step(c, vec2(1.0));
  vec4 px = texture(uContent, clamp(c, 0.0, 1.0)) * (in2.x * in2.y);

  float a = max(px.a, 1e-4);
  vec3 rgb = px.rgb / a;
  float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  // A duotone off a gentle S-curve: the grade crushes the blacks a little
  // rather than lifting them, which is what a film grade does.
  vec3 toned = mix(uShadows, uHighlights, smoothstep(0.0, 1.0, luma));
  rgb = mix(rgb, toned, uGrade);

  float black = step(fd.z, -8.0);
  rgb *= exp2(clamp(fd.z, -8.0, 8.0)) * uExposure;

  vec2 v = (vScreen - 0.5) * uAspect * 2.0;
  rgb *= 1.0 - uVignette * smoothstep(0.5, 1.6, length(v));

  px = vec4(rgb * px.a, px.a);
  px = mix(px, vec4(0.0, 0.0, 0.0, 1.0), black);

  float lot = mix(raw.w, vUv.x, uSweep);
  float t = uSoft + lot * (1.0 - uSoft);
  px *= smoothstep(t - uSoft, t, uReveal);
  o = px;
}`

/**
 * The grid. A thin line along every cell boundary, with a faint wider glow
 * so it reads on a bright picture as well as a dark one. Distances are in
 * device pixels so the line is the same weight at every cell size.
 */
export const FRAG_LINES = `#version 300 es
precision highp float;
uniform vec2 uGrid;
uniform vec2 uResolution;
uniform vec3 uLineColor;
uniform float uLineAlpha;
uniform float uLineWidth;      // device px
uniform float uLineGlow;
in vec2 vUv;
out vec4 o;

void main() {
  vec2 p = vUv * uGrid;
  vec2 cellPx = uResolution / uGrid;
  vec2 f = fract(p);
  vec2 d = min(f, 1.0 - f) * cellPx;
  float dist = min(d.x, d.y);
  float hw = uLineWidth * 0.5;
  float core = 1.0 - smoothstep(hw, hw + 1.0, dist);
  float glow = (1.0 - smoothstep(0.0, uLineWidth * 4.0 + 2.0, dist)) * uLineGlow;
  float a = clamp(core + glow, 0.0, 1.0) * uLineAlpha;
  o = vec4(uLineColor * a, a);
}`

export function compileShader(gl, type, source) {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`tiles: shader failed to compile\n${log}`)
  }
  return shader
}

export function createProgram(gl, vertexSource, fragmentSource, attributes = ['aPos']) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource)
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource)
  const program = gl.createProgram()
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  attributes.forEach((name, i) => gl.bindAttribLocation(program, i, name))
  gl.linkProgram(program)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program)
    gl.deleteProgram(program)
    throw new Error(`tiles: program failed to link\n${log}`)
  }

  const table = new Map()
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS)
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i)
    table.set(info.name, { location: gl.getUniformLocation(program, info.name), type: info.type })
  }

  return {
    program,
    use: () => gl.useProgram(program),
    set(values) {
      for (const name in values) {
        const uniform = table.get(name)
        if (!uniform) continue
        const value = values[name]
        switch (uniform.type) {
          case gl.FLOAT: gl.uniform1f(uniform.location, value); break
          case gl.FLOAT_VEC2: gl.uniform2fv(uniform.location, value); break
          case gl.FLOAT_VEC3: gl.uniform3fv(uniform.location, value); break
          case gl.FLOAT_VEC4: gl.uniform4fv(uniform.location, value); break
          case gl.INT:
          case gl.SAMPLER_2D: gl.uniform1i(uniform.location, value); break
          default: throw new Error(`tiles: uniform "${name}" has an unhandled type`)
        }
      }
    },
    dispose: () => gl.deleteProgram(program),
  }
}

export function createTexture(gl, filter) {
  const texture = gl.createTexture()
  const mode = filter ?? gl.LINEAR
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mode)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mode)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return texture
}

export function createMesh(gl, vertices) {
  const vao = gl.createVertexArray()
  const buffer = gl.createBuffer()
  gl.bindVertexArray(vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
  gl.bindVertexArray(null)
  return {
    draw: (mode, count) => {
      gl.bindVertexArray(vao)
      gl.drawArrays(mode, 0, count)
    },
    dispose: () => {
      gl.deleteVertexArray(vao)
      gl.deleteBuffer(buffer)
    },
  }
}

/**
 * Colours are authored as sRGB hex and used as sRGB: the whole pipeline here
 * is 8-bit content in, 8-bit canvas out, and a grade chosen by eye in sRGB
 * should land on screen as chosen.
 */
export function srgb(color) {
  if (Array.isArray(color)) return color
  const match = /^#?([0-9a-f]{6})$/i.exec(String(color))
  if (!match) throw new TypeError(`tiles: expected a #rrggbb colour, got "${color}"`)
  const packed = parseInt(match[1], 16)
  return [16, 8, 0].map((shift) => ((packed >> shift) & 0xff) / 255)
}
