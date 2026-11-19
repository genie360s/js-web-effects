// WebGL2 side of the sand: the GLSL, and the small amount of plumbing that
// turns it into programs, textures and meshes.
//
// Four programs share one description of the surface:
//   bake    - once per resize, turns analytic beach relief into a texture
//   sand    - the beach itself, every frame
//   layer   - DOM, image or video content painted onto that beach
//   pigment - colour lifted off that content and stirred through the grains
//
// Copyright (c) 2026 Alex Mkwizu <alexgmkwizu@gmail.com> — MIT.

/** Hash without sin: stays exact at large coordinates, unlike sin-based hashes. */
const HASH_GLSL = `
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}`

/**
 * UV origin is top-left everywhere, matching DOM coordinates.
 *
 * Which arithmetic gets you there depends on what is being drawn into. The
 * canvas puts clip-space +1 at the top; a framebuffer puts texel row 0 at
 * clip-space -1. Using the canvas version for an offscreen pass stores the
 * result upside-down relative to every later read of it.
 */
export const VERT_FULLSCREEN = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

/** The same, for passes that render into a texture rather than the canvas. */
export const VERT_FULLSCREEN_TARGET = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

/** The analytic beach. Evaluated once per resize by the bake program. */
const BEACH_GLSL = `
${HASH_GLSL}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 2.0 - 1.0;
}
const mat2 ROT = mat2(0.8, 0.6, -0.6, 0.8);
float fbm(vec2 p, int octaves) {
  float sum = 0.0, amp = 0.5;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    sum += amp * vnoise(p);
    p = ROT * p * 2.03;
    amp *= 0.5;
  }
  return sum;
}

/**
 * Height of undisturbed beach at p, measured in ripple wavelengths on both
 * axes — so the result is a dimensionless slope that composes directly with
 * the simulation's.
 *
 * Wind ripples are asymmetric: narrow rounded crests over broad flat troughs,
 * with crest lines that meander rather than running dead straight, and they
 * come in patches with smoother sand between.
 */
float beachHeight(vec2 p, float rippleAmp, float dunes) {
  float meander = fbm(p * 0.21, 3) * 1.1;
  float wave = sin((dot(p, vec2(0.94, 0.34)) + meander) * 6.2831853);
  float crest = pow(0.5 + 0.5 * wave, 1.7) * 2.0 - 1.0;
  float patchy = clamp(0.55 + 0.9 * fbm(p * 0.13, 2), 0.0, 1.4);
  float h = crest * rippleAmp * patchy;

  // A second set crossing the first at a shallow angle, half as long again.
  h += sin((dot(p, vec2(-0.42, 0.91)) + fbm(p * 0.5, 2)) * 2.7) * rippleAmp * 0.3;
  // Slow undulation of the beach face.
  h += fbm(p * 0.035, 3) * dunes;
  // Grain-scale roughness.
  h += fbm(p * 7.0, 2) * rippleAmp * 0.16;
  return h;
}

/** Shell fragments and coarse grit: at most one dome per cell, sparse. */
float shells(vec2 p, out float mask) {
  vec2 cell = floor(p);
  mask = 0.0;
  if (hash21(cell + 7.1) <= 0.955) return 0.0;
  vec2 r = hash22(cell);
  float rad = 0.16 + 0.2 * r.x;
  float d = length(fract(p) - vec2(0.3 + 0.4 * r.x, 0.25 + 0.5 * r.y));
  if (d >= rad) return 0.0;
  mask = 1.0 - d / rad;
  return mask * mask * 0.55;
}`

/**
 * Bake: analytic relief -> texture.
 * rg = surface gradient (scaled by uEncode), b = relief height, a = grit mask.
 */
export const FRAG_BAKE = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform vec2 uResolution;
uniform float uScale;       // ripple wavelengths across the short screen axis
uniform float uRippleAmp;
uniform float uDunes;
uniform float uEncode;
${BEACH_GLSL}

float reliefAt(vec2 p, out float mask) {
  return beachHeight(p, uRippleAmp, uDunes) + shells(p * 3.0, mask);
}

void main() {
  // One wavelength spans uScale-th of the short screen axis, so the beach keeps
  // its physical scale on any viewport.
  float unit = uScale / min(uResolution.x, uResolution.y);
  vec2 p = vUv * uResolution * unit;
  vec2 d = vec2(unit, 0.0);

  float mask, ignored;
  float h = reliefAt(p, mask);
  float hx0 = reliefAt(p - d.xy, ignored);
  float hx1 = reliefAt(p + d.xy, ignored);
  float hy0 = reliefAt(p - d.yx, ignored);
  float hy1 = reliefAt(p + d.yx, ignored);

  vec2 grad = vec2(hx1 - hx0, hy1 - hy0) * 0.5 / unit;
  fragColor = vec4(clamp(grad / uEncode + 0.5, 0.0, 1.0), h * 0.5 + 0.5, mask);
}`

/**
 * Everything both runtime programs need to know about the surface: how to read
 * the simulation field, how to build a normal, and how sand answers light.
 */
const SURFACE_GLSL = `
${HASH_GLSL}
uniform sampler2D uField;    // RGBA16F: height (cells), disturbance, drift x, drift y
uniform sampler2D uRelief;   // baked analytic relief
uniform sampler2D uPigment;  // colour stirred out of the content into the sand
uniform vec2 uFieldSize;
uniform vec2 uResolution;
uniform vec3 uLightDir;
uniform vec3 uSandLight;
uniform vec3 uSandDark;
uniform vec3 uSandDamp;
uniform float uEncode;
uniform float uHeightScale;
uniform float uReliefAmp;
uniform float uSparkle;
uniform float uExposure;
uniform float uPigmentMix;

/**
 * Bilinear taps on a 256-cell grid show diamond artefacts along groove edges.
 * Smoothstepping the interpolation fraction gives a C1 surface for one handful
 * of ALU and a single tap.
 */
vec4 fieldAt(vec2 uv) {
  vec2 p = uv * uFieldSize - 0.5;
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return texture(uField, (i + 0.5 + f) / uFieldSize);
}

struct Surface {
  vec3 normal;       // full surface, relief included: what the light sees
  vec2 flow;         // slope of the disturbed sand alone: what moves content
  vec2 warp;         // slope of the standing beach alone: a resting distortion
  vec2 drift;        // where the stick last pushed the sand, cells per second
  float height;      // simulated height, in cells
  float disturb;     // 0..1 freshly turned sand
  float cavity;      // ambient occlusion from sitting below the surroundings
  float grit;
};

/** Shading runs in linear light; the display wants sRGB. */
vec3 tonemap(vec3 c) { return c / (c + 0.72) * 1.38; }
vec3 encode(vec3 c) { return pow(max(c, vec3(0.0)), vec3(1.0 / 2.2)); }
vec3 decode(vec3 c) { return pow(max(c, vec3(0.0)), vec3(2.2)); }

float cavityAt(float h) {
  return clamp(0.76 + 0.24 * smoothstep(-0.9, 0.3, h), 0.0, 1.0);
}

/** Sand is rough and forward-scattering; pure Lambert reads too contrasty. */
float lightResponse(vec3 N) {
  float ndl = max(dot(N, normalize(uLightDir)), 0.0);
  return 0.34 * (0.5 + 0.5 * N.z) + 0.78 * mix(ndl, sqrt(ndl), 0.55);
}

Surface surfaceAt(vec2 uv) {
  vec2 texel = 1.0 / uFieldSize;
  vec4 fd = fieldAt(uv);
  float hl = fieldAt(uv - vec2(texel.x, 0.0)).r;
  float hr = fieldAt(uv + vec2(texel.x, 0.0)).r;
  float hd = fieldAt(uv - vec2(0.0, texel.y)).r;
  float hu = fieldAt(uv + vec2(0.0, texel.y)).r;

  vec4 relief = texture(uRelief, uv);
  // Both terms are dimensionless slopes, so they simply add.
  vec2 dug = vec2(hr - hl, hu - hd) * 0.5 * uHeightScale;
  vec2 standing = (relief.rg - 0.5) * uEncode * uReliefAmp;
  vec2 grad = dug + standing;

  Surface s;
  s.normal = normalize(vec3(-grad, 1.0));
  // Content rides on the sand that actually moved. Letting the standing ripples
  // drag it too would smear the whole page evenly, which reads as a bad filter
  // rather than as a stick through sand.
  s.flow = -dug;
  s.warp = -standing;
  s.drift = fd.zw;
  s.height = fd.r;
  s.disturb = clamp(fd.g, 0.0, 1.0);
  s.cavity = cavityAt(fd.r + (relief.b - 0.5) * 0.8);
  s.grit = relief.a;
  return s;
}

/** Sand under one sun and a bright sky. */
vec3 shadeSand(Surface s, vec2 uv) {
  vec3 H = normalize(normalize(uLightDir) + vec3(0.0, 0.0, 1.0));

  float grain = hash21(floor(uv * uResolution * 1.4));
  vec3 albedo = mix(uSandDark, uSandLight, 0.45 + 0.55 * grain);
  albedo = mix(albedo, uSandLight * 1.06, s.grit);
  // Freshly turned sand is damper, darker and slightly cooler.
  albedo = mix(albedo, uSandDamp, s.disturb * 0.2);
  // Colour stirred out of the content is now part of the beach. It arrives
  // display-encoded, like the content it came from, and it lands on grains
  // rather than as a wash, so the same grain noise breaks it up.
  vec4 stirred = texture(uPigment, uv);
  float stain = clamp(stirred.a * uPigmentMix, 0.0, 1.0) * (0.45 + 0.9 * grain);
  albedo = mix(albedo, decode(stirred.rgb), clamp(stain, 0.0, 1.0));

  vec3 color = albedo * lightResponse(s.normal) * s.cavity;
  // Broad sheen off the packed surface.
  color += vec3(1.0, 0.97, 0.9) * pow(max(dot(s.normal, H), 0.0), 26.0) * 0.045 * s.cavity;

  // Individual quartz grains catching the sun. The micro-facet is hashed per
  // pixel cluster, so glints twinkle as the surface moves beneath them.
  vec2 cell = floor(uv * uResolution * 0.85);
  float rare = hash21(cell + 3.7);
  if (rare > 0.86) {
    vec3 micro = normalize(s.normal + (vec3(hash21(cell), hash21(cell + 11.0), hash21(cell + 23.0)) - 0.5) * 1.5);
    color += vec3(1.0, 0.98, 0.94)
           * pow(max(dot(micro, H), 0.0), 220.0) * uSparkle * (rare - 0.86) * 7.0 * s.cavity;
  }
  return color * uExposure;
}

/**
 * Dither: kills 8-bit banding across the large flat gradients. Fixed to the
 * pixel, never to the clock — reseeding it per frame makes the whole beach
 * crawl whenever anything is redrawn.
 */
vec3 dither(vec3 c, vec2 fragCoord) {
  return c + (hash21(fragCoord) - 0.5) / 255.0;
}`

export const FRAG_SAND = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
${SURFACE_GLSL}

void main() {
  vec3 color = encode(tonemap(shadeSand(surfaceAt(vUv), vUv)));
  fragColor = vec4(dither(color, gl_FragCoord.xy), 1.0);
}`

/**
 * Stirring. Colour is lifted off the content wherever the sand was turned, and
 * then carried along the drift the stick left behind, one step per frame:
 * look back along the drift, take what was there, mix in what is being picked
 * up now. Held in its own texture, ping-ponged, so it accumulates over a whole
 * session of stirring rather than being recomputed each frame.
 */
export const FRAG_PIGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uField;
uniform sampler2D uContent;   // the page, composited flat and undistorted
uniform sampler2D uPigment;   // what the sand already holds
uniform vec2 uFieldSize;
uniform vec2 uTexel;
uniform float uDt;
uniform float uPickup;
uniform float uSpread;
uniform float uFade;    // wind, per second: it buries the colour as it smooths

void main() {
  vec4 field = texture(uField, vUv);
  // Semi-Lagrangian: where was this grain a moment ago? Drift is in cells per
  // second, so it converts to UV through the field size.
  vec2 back = vUv - field.zw * uDt / uFieldSize;
  vec4 held = texture(uPigment, back);

  vec4 content = texture(uContent, vUv);
  float turned = clamp(field.g, 0.0, 1.0);

  // A little lateral mixing, so stirring blends the colours instead of leaving
  // clean parallel smears — but only where the sand is actually being worked.
  // Mixing everywhere would keep every old smear bleeding outwards for as long
  // as anything kept the loop awake.
  float working = clamp(turned + length(field.zw) * 0.1, 0.0, 1.0);
  if (working > 0.0) {
    vec4 around = 0.25 * (
        texture(uPigment, back + vec2(uTexel.x, 0.0))
      + texture(uPigment, back - vec2(uTexel.x, 0.0))
      + texture(uPigment, back + vec2(0.0, uTexel.y))
      + texture(uPigment, back - vec2(0.0, uTexel.y)));
    held = mix(held, around, uSpread * working);
  }
  float taken = turned * content.a * uPickup * min(uDt * 60.0, 2.0);

  vec3 colour = held.rgb;
  // Wind that flattens the marks has to take the colour with it, or it leaves
  // a stain lying on smooth sand with nothing to explain it.
  float amount = held.a * clamp(1.0 - uFade * uDt, 0.0, 1.0);
  if (taken > 0.0) {
    // Content arrives premultiplied; the pigment stores plain colour and how
    // much of it there is, so the two mix by weight.
    vec3 paint = content.rgb / max(content.a, 1e-4);
    float total = amount + taken;
    colour = (colour * amount + paint * taken) / max(total, 1e-4);
    amount = min(total, 1.0);
  }
  fragColor = vec4(colour, amount);
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

export const FRAG_LAYER = `#version 300 es
precision highp float;
in vec2 vUv;
in vec2 vScreen;
out vec4 fragColor;
uniform sampler2D uContent;
uniform vec4 uRect;
uniform float uDisplace;    // how far content slides down the slope, in pixels
uniform float uWarp;        // how far the standing ripples bend it, in pixels
uniform float uShade;       // how much sand lighting reaches the content
uniform float uStain;       // how much turned sand discolours the content
uniform float uBury;        // height of piled sand that hides the content
uniform float uScrape;      // how much the lifted colour fades the content
${SURFACE_GLSL}

void main() {
  Surface s = surfaceAt(vScreen);

  // The content is painted on the sand, so it slides with the surface: a pixel
  // offset down the slope, expressed in this layer's own UV. uDisplace is the
  // sand you have moved, uWarp the ripples that were already there: a resting
  // distortion, present before you touch anything.
  vec2 slide = s.flow * uDisplace + s.warp * uWarp;
  vec2 uv = vUv + slide / max(uRect.zw * uResolution, vec2(1.0));

  // Content arrives premultiplied so linear filtering cannot fringe text.
  vec4 content = texture(uContent, uv);
  // Sampling past the edge would smear the outermost pixels; cutting instead
  // reads as the edge itself being pushed around.
  vec2 inside = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  content *= inside.x * inside.y;

  // 1.0 on flat undisturbed sand, so untouched content is bit-for-bit itself.
  float lighting = lightResponse(s.normal) * s.cavity
                 / (lightResponse(vec3(0.0, 0.0, 1.0)) * cavityAt(0.0));

  // Content is already display-encoded, so the linear lighting ratio is applied
  // in the same space: multiplying linear by k equals multiplying sRGB by k^1/2.2.
  vec3 rgb = mix(content.rgb, content.rgb * pow(lighting, 1.0 / 2.2), uShade);
  rgb = mix(rgb, encode(tonemap(shadeSand(s, vScreen))) * content.a, s.disturb * uStain);

  // Sand pushed up over the content hides it, and the beach behind shows
  // through; colour stirred into the sand is colour the content no longer has.
  float keep = 1.0 - (uBury > 0.0 ? smoothstep(uBury * 0.35, uBury, s.height) : 0.0);
  keep *= 1.0 - clamp(texture(uPigment, vScreen).a * uScrape, 0.0, 1.0);
  fragColor = vec4(dither(rgb, gl_FragCoord.xy) * keep, content.a * keep);
}`

// --- plumbing ---------------------------------------------------------------

export function compileShader(gl, type, source) {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader
  const log = gl.getShaderInfoLog(shader)
  gl.deleteShader(shader)
  throw new Error(`sand: shader failed to compile\n${log}`)
}

// Links a program and builds a typed uniform table, so callers set uniforms by
// name instead of keeping a getUniformLocation line for each one.
export function createProgram(gl, vertexSource, fragmentSource) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource)
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource)
  const program = gl.createProgram()
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.bindAttribLocation(program, 0, 'aPos')
  gl.linkProgram(program)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program)
    gl.deleteProgram(program)
    throw new Error(`sand: program failed to link\n${log}`)
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
          default: throw new Error(`sand: uniform "${name}" has an unhandled type`)
        }
      }
    },
    dispose: () => gl.deleteProgram(program),
  }
}

export function createTexture(gl) {
  const texture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
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
    vao,
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

// Colours are authored as sRGB hex and shaded in linear light.
export function linearRgb(color) {
  if (Array.isArray(color)) return color
  const match = /^#?([0-9a-f]{6})$/i.exec(String(color))
  if (!match) throw new TypeError(`sand: expected a #rrggbb colour, got "${color}"`)
  const packed = parseInt(match[1], 16)
  return [16, 8, 0].map((shift) => {
    const c = ((packed >> shift) & 0xff) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
}
