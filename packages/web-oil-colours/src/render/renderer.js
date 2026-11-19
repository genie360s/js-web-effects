// WebGL2 renderer for the paint surface.
//
// The simulation hands over two things per cell: a linear reflectance, already
// mixed, and how much paint is piled there. Everything that makes it read as
// oil rather than as a blurry photograph happens here, and all of it comes off
// the thickness field — because that is what oil paint actually has that other
// media do not. Thickness gives a surface normal, so the ridge a stroke pushes
// up catches the light down one side and shades the other, and the furrows the
// bristles left catch it the same way. Where it thins out, the weave of the
// canvas underneath comes through.
//
// There is no separate layer for the interface. A component's surface is
// deposited into the pigment field itself, so by the time it reaches here it is
// paint like any other and this file does not know a control exists.

const VERT = `#version 300 es
// One oversized triangle: cheaper than a quad and has no diagonal seam.
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

const FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uPaint;  // rgb = linear reflectance, a = thickness
uniform vec2  uTexel;      // 1 / grid
uniform vec2  uWeave;      // canvas threads across the view
uniform float uRelief;     // thickness gradient -> surface slope
uniform float uGloss;      // specular tightness
uniform float uWet;        // 0 tacky, 1 straight out of the tube
uniform vec3  uKey;        // key light direction

const float PI = 3.14159265;
// A studio: one window, a bounce card opposite, and a lot of ceiling.
const vec3 KEY_COLOR  = vec3(1.0, 0.97, 0.92);
const vec3 FILL_COLOR = vec3(0.42, 0.47, 0.58);
const vec3 SKY        = vec3(0.50, 0.55, 0.64);
const vec3 GROUND     = vec3(0.30, 0.27, 0.24);
// Bare linen, linear. Warm, and much duller than any paint on top of it.
const vec3 CANVAS     = vec3(0.30, 0.25, 0.19);
// Paint thins to nothing over this range before the weave shows through.
const float BARE      = 0.16;
const float COVERED   = 0.52;

float hash(vec2 p) {
  p = fract(p * vec2(127.31, 311.7));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

/**
 * Linen: warp threads crossing weft, whichever stands proud at this point.
 * Returns the thread height, and its exact gradient in g — a finite difference
 * would cost four more evaluations for a function whose derivative is one
 * cosine, and the weave has to stay cheap enough to keep on the low tier.
 * Losing it there is what makes paint look like plastic.
 */
float linen(vec2 p, out vec2 g) {
  float ax = sin(p.x * PI);
  float ay = sin(p.y * PI);
  // Which thread lies on top alternates square by square, as on a loom. Taking
  // whichever is higher instead gives a grid of crossing lines, which reads as
  // a printed screen rather than as cloth.
  if (mod(floor(p.x) + floor(p.y), 2.0) < 1.0) {
    g = vec2(PI * cos(p.x * PI) * sign(ax), 0.0);
    return abs(ax) - 0.5;
  }
  g = vec2(0.0, PI * cos(p.y * PI) * sign(ay));
  return abs(ay) - 0.5;
}

void main() {
  vec2 uv = vUv;
  vec4 c = texture(uPaint, uv);
  float h = c.a;

  // Thickness gradient. A Sobel, not a four-tap cross: thickness crosses from
  // the worker as a half-float, and relief times a tight specular amplifies
  // that quantisation enough that the coarser estimate lays visible contour
  // rings across every smooth pile of paint. The diagonals average them out.
  vec2 e = uTexel;
  float hl = texture(uPaint, uv - vec2(e.x, 0.0)).a;
  float hr = texture(uPaint, uv + vec2(e.x, 0.0)).a;
  float hd = texture(uPaint, uv - vec2(0.0, e.y)).a;
  float hu = texture(uPaint, uv + vec2(0.0, e.y)).a;
  float h00 = texture(uPaint, uv - e).a;
  float h10 = texture(uPaint, uv + vec2(e.x, -e.y)).a;
  float h01 = texture(uPaint, uv + vec2(-e.x, e.y)).a;
  float h11 = texture(uPaint, uv + e).a;
  vec2 grad = vec2((h10 + 2.0 * hr + h11) - (h00 + 2.0 * hl + h01),
                   (h01 + 2.0 * hu + h11) - (h00 + 2.0 * hd + h10)) * 0.125;

  // How completely the canvas is covered here.
  float cover = smoothstep(BARE, COVERED, h);

  vec2 wp = uv * uWeave;
  vec2 wg;
  float wv = linen(wp, wg);
  // No real canvas has perfectly even threads.
  float irregular = 0.7 + 0.6 * vnoise(wp * 0.11);
  // The weave telegraphs through thin paint and vanishes under thick.
  grad += wg * (0.0034 * irregular * mix(1.0, 0.12, cover));
  wv *= irregular;

  vec3 n = normalize(vec3(-grad.x * uRelief, -grad.y * uRelief, 1.0));
  vec3 view = vec3(0.0, 0.0, 1.0);
  vec3 key = normalize(uKey);
  vec3 fill = normalize(vec3(-key.x, -key.y, 0.75));

  // Wet paint sits under a film of oil: less light escapes back out, so it
  // reads darker and more saturated than the same pigment dry. Below the
  // gamma, that is close to a small exponent.
  vec3 albedo = pow(max(c.rgb, 0.0), vec3(1.0 + 0.22 * uWet));
  albedo = mix(CANVAS * (0.92 + wv * 0.26), albedo, cover);
  // Laid over, not blended in: a control is a fresh stroke, not a stain.

  // Cavity shading. A concave cell is a valley between two ridges of paint and
  // sees less of the room; a convex one is a crest and sees more.
  float curv = (hl + hr + hd + hu) * 0.25 - h;
  float cavity = clamp(1.0 - curv * 2.6, 0.55, 1.25);

  float ndl = max(dot(n, key), 0.0);
  float ndf = max(dot(n, fill), 0.0);
  // Hemisphere ambient, so ridge tops pick up the ceiling and the sides facing
  // away pick up the floor.
  vec3 ambient = mix(GROUND, SKY, n.z * 0.5 + 0.5) * 0.34;

  vec3 lit = albedo * (ambient * cavity + KEY_COLOR * ndl * 0.82 + FILL_COLOR * ndf * 0.22);

  // Specular. Oil is a dielectric with a low F0, and a studio window is an area
  // source, not a point: the giveaway that paint is wet is a broad soft sheen
  // sliding over the ridges, not a mirror pinpoint. So this is two lobes, a
  // tight one kept deliberately weak and a wide one doing most of the work,
  // both gated by ndl so no ridge facing away from the window can glint.
  vec3 hv = normalize(key + view);
  float ndh = max(dot(n, hv), 0.0);
  float fres = 0.03 + 0.97 * pow(1.0 - max(dot(hv, view), 0.0), 5.0);
  float gloss = mix(10.0, uGloss, uWet) * mix(0.3, 1.0, cover);
  float tight = pow(ndh, gloss) * 0.55;
  float broad = pow(ndh, max(gloss * 0.1, 2.0)) * 0.32;
  lit += KEY_COLOR * fres * (tight + broad) * ndl * cavity * mix(0.3, 1.0, uWet);

  // Grazing sheen off the whole surface, the thing that says "still wet".
  float rim = pow(1.0 - max(n.z, 0.0), 3.0);
  lit += SKY * rim * 0.05 * uWet * cover;

  fragColor = vec4(pow(max(lit, 0.0), vec3(1.0 / 2.2)), 1.0);
}`

const UNIFORMS = ['uPaint', 'uTexel', 'uWeave', 'uRelief', 'uGloss', 'uWet', 'uKey']

// Canvas threads across the short side, thickness-gradient-to-slope gain,
// specular tightness at full wetness, and where the studio window is.
const THREADS = 150
const RELIEF = 30.0
const GLOSS = 54.0
const KEY = [-0.42, 0.58, 0.7]

function compile(gl, type, src) {
  const sh = gl.createShader(type)
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh)
    gl.deleteShader(sh)
    throw new Error(`shader compile failed:\n${log}`)
  }
  return sh
}

export function createRenderer(canvas) {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false, // nothing here has geometric edges to alias
    depth: false,
    stencil: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
  })
  if (!gl) throw new Error('WebGL2 is required for the paint surface')

  const program = gl.createProgram()
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT))
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`program link failed:\n${gl.getProgramInfoLog(program)}`)
  }
  const uniforms = {}
  for (const n of UNIFORMS) uniforms[n] = gl.getUniformLocation(program, n)
  gl.useProgram(program)
  gl.uniform1i(uniforms.uPaint, 0)

  const vao = gl.createVertexArray() // WebGL2 requires a bound VAO even with no attributes

  // RGBA16F is texture-filterable in core WebGL2, so the coarse simulation grid
  // upsamples smoothly without an extension or a resample pass.
  const paintTex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, paintTex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  let grid = { w: 0, h: 0 }
  let viewport = { w: 1, h: 1 }

  /** Upload one simulation frame. `data` is interleaved RGBA half-floats. */
  function uploadFrame(data, w, h) {
    gl.activeTexture(gl.TEXTURE0)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.bindTexture(gl.TEXTURE_2D, paintTex)
    if (w !== grid.w || h !== grid.h) {
      grid = { w, h }
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, data)
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.HALF_FLOAT, data)
    }
  }

  function resize(pixelWidth, pixelHeight) {
    canvas.width = pixelWidth
    canvas.height = pixelHeight
    viewport = { w: pixelWidth, h: pixelHeight }
    gl.viewport(0, 0, pixelWidth, pixelHeight)
  }

  function render(opts = {}) {
    if (!grid.w) return
    gl.useProgram(program)
    gl.bindVertexArray(vao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, paintTex)

    gl.uniform2f(uniforms.uTexel, 1 / grid.w, 1 / grid.h)
    // Threads are a physical size on the canvas, not a fraction of it, so the
    // weave keeps its scale when the window changes shape.
    const aspect = viewport.w / viewport.h
    gl.uniform2f(uniforms.uWeave, THREADS * Math.max(aspect, 1), THREADS * Math.max(1 / aspect, 1))
    // The gradient is per-texel, so a coarser grid must push harder to raise
    // the same ridge. Keyed to the long side, which is where the tier puts its
    // resolution — keying it to the width would flatten the impasto every time
    // a phone is turned on its side.
    gl.uniform1f(uniforms.uRelief, RELIEF * Math.max(grid.w, grid.h) * 0.0026)
    gl.uniform1f(uniforms.uGloss, GLOSS)
    gl.uniform1f(uniforms.uWet, opts.wet ?? 1.0)
    gl.uniform3f(uniforms.uKey, KEY[0], KEY[1], KEY[2])

    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  function dispose() {
    gl.deleteProgram(program)
    gl.deleteTexture(paintTex)
    gl.deleteVertexArray(vao)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }

  return { uploadFrame, resize, render, dispose }
}
