// WebGL2 side of the fire: the GLSL, and the plumbing that turns it into
// programs, textures and meshes.
//
// Three programs share one description of the field:
//   layer   - the page: refracted by the heat over it, scorched, burnt through
//   flame   - the fire itself, drawn over everything
//   ember   - the sparks, as point sprites
//
// Copyright (c) 2026 Alex Mkwizu <alexgmkwizu@gmail.com> — MIT.

/** Hash without sin: stays exact at large coordinates, unlike sin-based ones. */
const HASH_GLSL = `
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}`

/**
 * UV origin is top-left everywhere, matching both DOM coordinates and the
 * solver's grid. Which arithmetic gets you there depends on what is being
 * drawn into: the canvas puts clip-space +1 at the top, a framebuffer puts
 * texel row 0 at clip-space -1.
 */
export const VERT_FULLSCREEN = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

/**
 * Everything both surface programs need: how to read the field, what colour a
 * given temperature is, and how to get from radiance to a pixel.
 */
const FIELD_GLSL = `
${HASH_GLSL}
uniform sampler2D uField;      // RGBA16F: gas heat (kK), soot, char, surface heat (kK)
uniform sampler2D uBlackbody;  // 1-D: colour of a black body, by temperature
uniform vec2 uFieldSize;
uniform vec2 uResolution;
uniform float uAmbient;        // K
uniform vec2 uBlackbodyRange;  // K at the two ends of the table
uniform float uExposure;

/**
 * Bilinear taps on a grid this coarse show diamond artefacts along the flame
 * edge. Smoothstepping the interpolation fraction gives a C1 surface for one
 * handful of ALU and a single tap.
 */
vec4 fieldAt(vec2 uv) {
  vec2 p = uv * uFieldSize - 0.5;
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return texture(uField, (i + 0.5 + f) / uFieldSize);
}

float gasK(vec4 fd) { return uAmbient + fd.r * 1000.0; }
float surfaceK(vec4 fd) { return uAmbient + fd.a * 1000.0; }

/** Hue of an incandescent body, in linear light. Brightness is the caller's. */
vec3 blackbody(float kelvin) {
  float t = (kelvin - uBlackbodyRange.x) / (uBlackbodyRange.y - uBlackbodyRange.x);
  return texture(uBlackbody, vec2(clamp(t, 0.0, 1.0), 0.5)).rgb;
}

/**
 * How much a grey body at this temperature radiates, relative to a flame.
 * Stefan-Boltzmann, normalised at 2000 K so the exposure control means the
 * same thing whatever the fire is doing.
 */
float radiance(float kelvin) {
  float t = max(kelvin, 0.0) * 0.0005; // /2000
  float t2 = t * t;
  return t2 * t2;
}

vec3 tonemap(vec3 c) { return c / (c + 0.86) * 1.62; }
vec3 encode(vec3 c) { return pow(max(c, vec3(0.0)), vec3(1.0 / 2.2)); }

/**
 * Dither: kills 8-bit banding across the huge smooth gradients a plume is
 * made of. Fixed to the pixel, never to the clock — reseeding it per frame
 * makes the whole screen crawl.
 */
vec3 dither(vec3 c, vec2 fragCoord) {
  return c + (hash21(fragCoord) - 0.5) / 255.0;
}

/**
 * Where light entering here is bent to. Air's refractive index tracks its
 * density, which goes as 1/T, so a hot plume is a lens with a moving surface —
 * the shimmer over a bonfire. The gradient of the heat field is the deflection.
 */
vec2 heatGradient(vec2 uv) {
  vec2 texel = 1.0 / uFieldSize;
  float l = fieldAt(uv - vec2(texel.x, 0.0)).r;
  float r = fieldAt(uv + vec2(texel.x, 0.0)).r;
  float d = fieldAt(uv - vec2(0.0, texel.y)).r;
  float u = fieldAt(uv + vec2(0.0, texel.y)).r;
  return vec2(r - l, u - d) * 0.5;
}`

export const VERT_LAYER = `#version 300 es
in vec2 aPos;
uniform vec4 uRect;         // x, y, w, h in top-left screen UV
uniform float uFlip;        // 1 drawing to the canvas, -1 into a texture
out vec2 vUv;               // content UV
out vec2 vScreen;           // screen UV
void main() {
  vUv = aPos * 0.5 + 0.5;
  vScreen = uRect.xy + vUv * uRect.zw;
  gl_Position = vec4(vScreen.x * 2.0 - 1.0, (1.0 - vScreen.y * 2.0) * uFlip, 0.0, 1.0);
}`

/**
 * The page, as the fire leaves it: bent by the heat rising off it, scorched
 * where it has charred, gone where it has burnt through, and glowing along
 * the edge in between.
 */
export const FRAG_LAYER = `#version 300 es
precision highp float;
in vec2 vUv;
in vec2 vScreen;
out vec4 fragColor;
uniform sampler2D uContent;
uniform vec4 uRect;
uniform float uHaze;      // pixels of refraction through the hot air
uniform float uScorch;    // how dark the char goes
uniform float uBurn;      // char at which the material is gone
uniform float uGlow;      // brightness of the burning edge
uniform float uFuel;      // only ever anything but 1 when baking the fuel map
uniform float uBurnable;  // 0 for a layer that cannot catch
${FIELD_GLSL}

void main() {
  vec4 fd = fieldAt(vScreen);

  // Content is painted where it is, then looked at through the heat.
  vec2 bend = -heatGradient(vScreen) * uHaze;
  vec2 uv = vUv + bend / max(uRect.zw * uResolution, vec2(1.0));
  vec4 content = texture(uContent, uv);   // premultiplied
  // Sampling past the edge would smear the outermost pixels; cutting instead
  // reads as the edge itself being pushed around.
  vec2 inside = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  content *= inside.x * inside.y;

  // Damage belongs to the cell, not to the layer, so a fireproof layer has
  // to opt out of it explicitly — otherwise a caption under a burning
  // photograph is eaten by a fire it could not have caught.
  float ch = clamp(fd.b, 0.0, 1.0) * uBurnable;
  // Scorching: the material darkens and loses its colour before it goes.
  float scorch = clamp(ch * uScorch, 0.0, 1.0);
  vec3 rgb = mix(content.rgb, content.rgb * 0.10, scorch);

  // Burnt through. The hole opens over the last sixth of the damage, so there
  // is always a band of charred-but-present material around it.
  float hole = smoothstep(uBurn * 0.84, uBurn, ch);
  float keep = 1.0 - hole;

  // The burning edge, which is the only part of a sheet of paper that is
  // actually alight: hot enough to glow, not yet gone.
  float edge = smoothstep(uBurn * 0.45, uBurn * 0.86, ch) * keep;
  float k = surfaceK(fd);
  vec3 emission = blackbody(k) * radiance(k) * edge * uGlow * uExposure;

  // Everything else here is display-encoded, the way the content texture
  // arrived, so the emission is encoded before it is added rather than after
  // — adding linear radiance to an sRGB pixel would double-count the gamma.
  vec3 glow = encode(tonemap(emission)) * content.a;
  rgb = rgb * keep + glow;
  // As in the flame pass: the glowing edge has to carry its own opacity, or
  // the premultiplied compositor clamps it away wherever the material it is
  // burning has already gone.
  float alpha = clamp(max(content.a * keep, max(glow.r, max(glow.g, glow.b))), 0.0, 1.0);
  // uFuel is 1 whenever this is drawing to the screen. The fuel bake reuses
  // this program with everything neutral and uFuel set per layer, so the
  // alpha it reads back is "how much of this is here to burn".
  fragColor = vec4(dither(rgb, gl_FragCoord.xy) * uFuel, alpha * uFuel);
}`

/**
 * The fire. Three things are happening at once and they are different
 * physics, which is why a flame is not one colour:
 *
 *   - soot in the flame is incandescent, and radiates a Planck spectrum. This
 *     is the yellow, and it needs soot: a flame with none is nearly invisible.
 *   - the reaction zone itself emits in bands from excited radicals rather
 *     than as a hot body. This is the blue at the base, and it shows exactly
 *     where the gas is hot and has not sooted up yet.
 *   - soot that has cooled is smoke. It absorbs rather than emits, and it is
 *     lit from below by the fire it came from.
 */
export const FRAG_FLAME = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform float uSootEmit;    // how much soot it takes to glow opaquely
uniform float uBlue;        // strength of the reaction-zone emission
uniform float uSmoke;       // optical depth per unit of soot
uniform vec3 uSmokeCool;
uniform vec3 uSmokeWarm;
${FIELD_GLSL}

void main() {
  vec4 fd = fieldAt(vUv);
  float k = gasK(fd);
  float soot = max(fd.g, 0.0);

  // Incandescent soot. Opacity saturates: past a certain load you are looking
  // at the surface of the flame, not through it.
  float glowing = 1.0 - exp(-soot * uSootEmit);
  vec3 emission = blackbody(k) * radiance(k) * glowing;

  // The reaction zone: hot, and not yet sooty. The gate on soot is steep on
  // purpose. In a real diffusion flame the blue is a thin skin at the base,
  // where the gas is alight but soot has not formed yet; a gentle gate paints
  // it over the whole plume instead, and a plume that is both faintly orange
  // and faintly blue comes out pink.
  float lit = smoothstep(900.0, 1500.0, k) * exp(-soot * 22.0);
  emission += vec3(0.16, 0.38, 1.0) * lit * uBlue;

  // Smoke. Cold soot is grey; soot that is still warm picks up the fire.
  float opacity = clamp(1.0 - exp(-soot * uSmoke), 0.0, 1.0);
  vec3 smoke = mix(uSmokeCool, uSmokeWarm, smoothstep(400.0, 900.0, k));

  // Premultiplied and display-encoded: both terms are encoded on their own
  // and then weighted, which is what keeps the blend correct.
  vec3 rgb = encode(tonemap(emission * uExposure)) + encode(smoke) * opacity;

  // The alpha has to cover the light as well as the smoke. This canvas is
  // premultiplied and sits over an ordinary web page, and a premultiplied
  // pixel whose colour exceeds its alpha is not a valid one — the compositor
  // clamps it. Emission carried on the smoke's alpha alone therefore arrives
  // crushed to a dim smear of whichever channel was largest, which for a
  // flame is red. A bright flame is opaque, which is also true of real ones.
  float brightest = max(rgb.r, max(rgb.g, rgb.b));
  float alpha = clamp(max(opacity, brightest), 0.0, 1.0);
  fragColor = vec4(dither(rgb, gl_FragCoord.xy), alpha);
}`

/**
 * Sparks. Each is one point sprite whose colour is its own temperature, and
 * whose size shrinks as it cools — a dying ember is smaller as well as dimmer,
 * because what you are seeing is the glowing part of it.
 */
export const VERT_EMBER = `#version 300 es
in vec4 aEmber;             // x, y (cells), temperature (K), life (s)
uniform vec2 uFieldSize;
uniform float uAmbient;
uniform float uSize;        // device pixels at full heat
uniform float uLife;        // the lifetime they were given
out float vTemp;
out float vFade;
void main() {
  vec2 uv = (aEmber.xy + 0.5) / uFieldSize;
  gl_Position = vec4(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
  float heat = clamp((aEmber.z - uAmbient) / 900.0, 0.0, 1.0);
  vFade = clamp(aEmber.w / max(uLife, 0.001), 0.0, 1.0);
  vTemp = aEmber.z;
  gl_PointSize = max(uSize * (0.35 + 0.65 * heat) * (0.4 + 0.6 * vFade), 1.0);
}`

export const FRAG_EMBER = `#version 300 es
precision highp float;
in float vTemp;
in float vFade;
out vec4 fragColor;
uniform sampler2D uBlackbody;
uniform vec2 uBlackbodyRange;
uniform float uExposure;
uniform float uAmbient;

vec3 blackbody(float kelvin) {
  float t = (kelvin - uBlackbodyRange.x) / (uBlackbodyRange.y - uBlackbodyRange.x);
  return texture(uBlackbody, vec2(clamp(t, 0.0, 1.0), 0.5)).rgb;
}
vec3 tonemap(vec3 c) { return c / (c + 0.86) * 1.62; }
vec3 encode(vec3 c) { return pow(max(c, vec3(0.0)), vec3(1.0 / 2.2)); }

void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  // Soft round sprite; a square spark reads as a bug rather than as a spark.
  float a = (1.0 - r2 * 4.0);
  a *= a * vFade;
  float t = max(vTemp, uAmbient) * 0.0005;
  float power = t * t * t * t;
  vec3 rgb = encode(tonemap(blackbody(vTemp) * power * uExposure));
  fragColor = vec4(rgb * a, a);
}`

// --- plumbing ---------------------------------------------------------------

export function compileShader(gl, type, source) {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader
  const log = gl.getShaderInfoLog(shader)
  gl.deleteShader(shader)
  throw new Error(`fire: shader failed to compile\n${log}`)
}

/**
 * Links a program and builds a typed uniform table, so callers set uniforms by
 * name instead of keeping a getUniformLocation line for each one.
 */
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
    throw new Error(`fire: program failed to link\n${log}`)
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
          default: throw new Error(`fire: uniform "${name}" has an unhandled type`)
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

/** A stream of `vec4` points, re-uploaded every frame. */
export function createPointBuffer(gl, maxPoints) {
  const vao = gl.createVertexArray()
  const buffer = gl.createBuffer()
  gl.bindVertexArray(vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, maxPoints * 4 * 4, gl.STREAM_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0)
  gl.bindVertexArray(null)
  return {
    draw(points, count) {
      if (count <= 0) return
      gl.bindVertexArray(vao)
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, points, 0, count * 4)
      gl.drawArrays(gl.POINTS, 0, count)
    },
    dispose: () => {
      gl.deleteVertexArray(vao)
      gl.deleteBuffer(buffer)
    },
  }
}

/** Colours are authored as sRGB hex and used in linear light. */
export function linearRgb(color) {
  if (Array.isArray(color)) return color
  const match = /^#?([0-9a-f]{6})$/i.exec(String(color))
  if (!match) throw new TypeError(`fire: expected a #rrggbb colour, got "${color}"`)
  const packed = parseInt(match[1], 16)
  return [16, 8, 0].map((shift) => {
    const c = ((packed >> shift) & 0xff) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
}
