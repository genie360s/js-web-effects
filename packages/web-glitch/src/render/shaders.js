// The one shader, and the glyphs it types with.
//
// The solver says what each cell is; this draws it. Every kind is a few lines:
// the picture, the picture in coarse pixels, the picture from a few cells
// sideways, a grey block, a white block, a dot, a character, a hairline, a
// four-digit number.
//
// Copyright (c) 2026 Alex Mkwizu <alexgmkwizu@gmail.com> — MIT.

/** Ten steps of density, then the ten digits. The shader indexes by column. */
export const GLYPHS = ' .:-=+*#%@0123456789'
const GLYPH_PX = 48

export const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  // top-left origin, like the page
  vUv = vec2(aPos.x, -aPos.y) * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

export const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 frag;

uniform sampler2D uContent;  // the picture, premultiplied
uniform sampler2D uState;    // kind, shape, 0, lot — one texel a cell
uniform sampler2D uGlow;     // one channel, blurred by the solver
uniform sampler2D uGlyphs;
uniform vec2 uCells;         // cells the surface spans; fractional at the edge
uniform vec2 uGrid;          // texels in uState
uniform float uCellPx;       // device pixels to a cell
uniform float uTime;
uniform vec3 uInk;
uniform vec3 uGlowColor;
uniform vec3 uKey;           // the background colour, when it is being cut out
uniform float uKeyTol;       // 0 leaves the picture as it is

const float GLYPHS = ${GLYPHS.length}.0;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec4 picture(vec2 cells) {
  vec4 t = texture(uContent, cells / uCells);
  if (uKeyTol > 0.0) {
    vec3 d = abs(t.rgb / max(t.a, 1e-4) - uKey);
    t *= smoothstep(uKeyTol * 0.5, uKeyTol, max(d.r, max(d.g, d.b)));
  }
  return t;
}
float glyph(float index, vec2 at) {
  return texture(uGlyphs, vec2((index + clamp(at.x, 0.0, 1.0)) / GLYPHS, at.y)).r;
}

void main() {
  vec2 pos = vUv * uCells;
  vec4 state = texelFetch(uState, ivec2(min(floor(pos), uGrid - 1.0)), 0);
  int kind = int(state.r * 255.0 + 0.5);
  int shape = int(state.g * 255.0 + 0.5);
  float lot = state.a;
  float size = float(1 << (shape & 3));
  vec2 origin = floor(pos / size) * size;
  vec2 local = (pos - origin) / size;   // 0..1 across the block
  float px = 1.0 / uCellPx;             // a device pixel, in cells
  vec4 ink = vec4(uInk, 1.0);
  vec4 c = vec4(0.0);

  if (kind == 1) {
    c = picture(pos);
  } else if (kind == 2) {
    float q = max(size * 0.25, 0.5);
    c = picture((floor(pos / q) + 0.5) * q);
  } else if (kind == 3) {
    c = picture(pos + vec2(floor((lot - 0.5) * 9.0), 0.0));
  } else if (kind == 4) {
    vec4 t = picture(origin + size * 0.5);
    c = vec4(vec3(mix(0.1, 0.42, lot) + luma(t.rgb) * 0.35), 1.0) * 0.9;
  } else if (kind == 5) {
    c = ink;
  } else if (kind == 6) {
    vec2 d = abs(local - 0.5);
    c = ink * step(max(d.x, d.y), max(px, 0.07)) * (0.55 + 0.45 * lot);
  } else if (kind == 7) {
    vec4 t = picture(origin + 0.5);
    // dark but opaque still earns a character
    float l = max(luma(t.rgb), t.a * 0.3);
    c = ink * glyph(clamp(floor(l * 10.0), 1.0, 9.0), local) * (0.45 + 0.55 * l);
  } else if (kind >= 8 && kind <= 10) {
    vec2 d = abs(local - 0.5);
    float across = kind != 9 ? step(d.y, px * 0.6) : 0.0;
    float down = kind != 8 ? step(d.x, px * 0.6) : 0.0;
    c = ink * max(across, down) * 0.85;
  } else if (kind == 11) {
    // four digits in a band across the middle of a 2x2 block, re-rolled
    // a few times a second
    float i = floor(local.x * 4.0);
    float n = floor(hash(vec2(lot * 255.0 + i * 7.0, floor(uTime * 6.0))) * 10.0);
    vec2 at = vec2(fract(local.x * 4.0), (local.y - 0.375) * 4.0);
    c = ink * glyph(10.0 + n, at) * step(abs(local.y - 0.5), 0.125) * 0.8;
  }

  if ((shape & 4) != 0) {
    vec2 e = min(local, 1.0 - local) * size;
    c = mix(c, ink, step(min(e.x, e.y), px) * 0.45);
  }

  // The solver's glow, sampled between cells: a bloom over what has just
  // arrived, and a lift of the block itself.
  float g = texture(uGlow, pos / uGrid).r;
  c.rgb += c.rgb * g * 0.35 + uGlowColor * g * g * 0.3;
  c.a = min(1.0, c.a + g * g * 0.3);
  frag = c;
}`

// The picture at two probes a cell, for finding the subject. Sixteen taps a
// probe, spread over its footprint, so a thin stroke between two taps of a
// plain downscale is still seen.
export const FRAG_PROBE = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 frag;
uniform sampler2D uContent;
uniform vec2 uScale;  // grid texels over cells spanned: where the picture ends
uniform vec2 uTap;
void main() {
  // No vertical flip: readPixels counts rows up from the bottom, and this
  // puts the top of the picture in the first row it returns.
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y) * uScale;
  vec4 sum = vec4(0.0);
  for (int j = 0; j < 4; j++) {
    for (int i = 0; i < 4; i++) {
      vec2 t = uv + (vec2(i, j) - 1.5) * uTap;
      if (all(greaterThanEqual(t, vec2(0.0))) && all(lessThanEqual(t, vec2(1.0)))) sum += texture(uContent, t);
    }
  }
  frag = sum / 16.0;
}`

/** The glyph strip: one square per character, white on black. */
export function drawGlyphs() {
  const canvas = document.createElement('canvas')
  canvas.width = GLYPH_PX * GLYPHS.length
  canvas.height = GLYPH_PX
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#fff'
  // Smaller than its square, so a mip level does not bleed one glyph into the next.
  ctx.font = `700 ${GLYPH_PX * 0.86}px ui-monospace, 'SF Mono', Menlo, Consolas, monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let i = 0; i < GLYPHS.length; i++) {
    ctx.fillText(GLYPHS[i], (i + 0.5) * GLYPH_PX, GLYPH_PX * 0.54)
  }
  return canvas
}

/** '#rgb' or '#rrggbb' to three floats, 0..1. */
export function srgb(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim())
  if (!m) throw new TypeError(`glitch: "${hex}" is not a hex colour`)
  const h = m[1].length === 3 ? [...m[1]].map((ch) => ch + ch).join('') : m[1]
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
}
