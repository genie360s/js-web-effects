// WebGL2 renderer for the water surface.
//
// The simulation gives us a height field; everything that makes it look like
// water happens here. The shading follows the real path light takes: it either
// reflects off the surface (Fresnel, showing the canopy overhead) or refracts
// into it (Snell), crosses a depth of water that absorbs the red out of it,
// bounces off the bed, and comes back. Caustics fall out of the same geometry —
// a crest is a converging lens, so the bed brightens under it.

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

uniform sampler2D uHeight;  // r = surface height, g = stirred silt
uniform sampler2D uBed;     // procedural pond floor, sRGB
uniform sampler2D uUi;      // submerged interface layer, sRGB + alpha
uniform float uUiDepth;     // how deep the interface sits; 0 disables it
uniform vec2  uTexel;       // 1 / grid size
uniform vec2  uBedScale;    // cover-fit mapping for the bed texture
uniform vec2  uBedOffset;
uniform float uAspect;
uniform float uTime;
uniform float uSlope;       // height -> surface normal gain
uniform float uDepth;       // water depth, in half-screen-height units
uniform float uCaustic;
uniform vec3  uSunDir;

const vec3 SUN_COLOR   = vec3(1.0, 0.94, 0.82);
// Pond water: red goes first, then blue. What survives is the green everyone
// recognises as "pond".
const vec3 ABSORB      = vec3(2.4, 0.82, 1.45);
const vec3 SCATTER     = vec3(0.55, 0.85, 0.62);
const vec3 WATER_TINT  = vec3(0.055, 0.115, 0.085);
const float EYE_DIST   = 1.15;
const float EYE_HEIGHT = 0.95;
const float IOR        = 1.333;
// How much of the Fresnel-reflected sky actually survives. Physically this is
// 1.0; a real pond sits under trees and reads far darker than that.
const float REFLECT    = 0.20;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < OCTAVES; i++) {
    v += a * vnoise(p);
    p = p * 2.03 + 11.7;
    a *= 0.5;
  }
  return v;
}

// What the sky looks like in the direction r: open sky high up, a ring of
// foliage crowding the horizon, sun glinting through the gaps.
vec3 env(vec3 r) {
  float up = clamp(r.z, 0.02, 1.0);
  vec3 sky = mix(vec3(0.26, 0.31, 0.35), vec3(0.08, 0.14, 0.22), pow(up, 0.55));

  vec2 c = r.xy / up * 0.5;
  float n = fbm(c * 1.15 + uTime * 0.012);
  float leafy = smoothstep(0.40, 0.70, n);
  float canopy = smoothstep(0.92, 0.10, up);

  vec3 foliage = mix(vec3(0.016, 0.032, 0.014), vec3(0.055, 0.115, 0.038), n);
  foliage += vec3(0.30, 0.28, 0.14) * smoothstep(0.86, 0.99, n) * 0.07;

  vec3 col = mix(sky, foliage, canopy * leafy);
  // The far bank, where the water meets the ground.
  return mix(col, vec3(0.045, 0.062, 0.038), smoothstep(0.14, 0.0, r.z));
}

void main() {
  vec2 uv = vUv;

  float hC = texture(uHeight, uv).r;
  float hL = texture(uHeight, uv - vec2(uTexel.x, 0.0)).r;
  float hR = texture(uHeight, uv + vec2(uTexel.x, 0.0)).r;
  float hD = texture(uHeight, uv - vec2(0.0, uTexel.y)).r;
  float hU = texture(uHeight, uv + vec2(0.0, uTexel.y)).r;
  float silt = texture(uHeight, uv).g;

  float lap = (hL + hR + hU + hD) - 4.0 * hC;
  vec3 N = normalize(vec3((hL - hR) * uSlope, (hD - hU) * uSlope, 1.0));

  // Eye is above and in front, so the far water is seen at a glancing angle and
  // reflects more — the gradient every photograph of a pond has.
  vec2 p = (uv - 0.5) * vec2(uAspect, 1.0);
  vec3 V = normalize(vec3(0.0, -EYE_DIST, EYE_HEIGHT) - vec3(p, 0.0));
  vec3 I = -V;

  float cosT = max(dot(N, V), 0.0);
  float F = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);

  // --- refracted path: down through the water, off the bed, back up ---------
  vec3 T = refract(I, N, 1.0 / IOR);
  float tz = max(-T.z, 0.05);
  float path = (uDepth / tz) * 1.6;

  vec3 bedCol;
#ifdef DISPERSION
  // Water splits colour slightly; on a moving surface this reads as depth.
  vec3 Tr = refract(I, N, 1.0 / (IOR - 0.004));
  vec3 Tb = refract(I, N, 1.0 / (IOR + 0.006));
  vec2 uvR = ((p + Tr.xy * (uDepth / max(-Tr.z, 0.05))) / vec2(uAspect, 1.0) + 0.5) * uBedScale + uBedOffset;
  vec2 uvG = ((p + T.xy  * (uDepth / tz))              / vec2(uAspect, 1.0) + 0.5) * uBedScale + uBedOffset;
  vec2 uvB = ((p + Tb.xy * (uDepth / max(-Tb.z, 0.05))) / vec2(uAspect, 1.0) + 0.5) * uBedScale + uBedOffset;
  bedCol = vec3(texture(uBed, uvR).r, texture(uBed, uvG).g, texture(uBed, uvB).b);
#else
  vec2 uvG = ((p + T.xy * (uDepth / tz)) / vec2(uAspect, 1.0) + 0.5) * uBedScale + uBedOffset;
  bedCol = texture(uBed, uvG).rgb;
#endif

  // A crest is a converging lens: light piles up on the bed beneath it.
  float focus = -lap * uCaustic;
  float caustic = 1.0 + focus * 1.1 + max(focus, 0.0) * max(focus, 0.0) * 0.9;
  caustic = clamp(caustic, 0.40, 2.6);

  vec3 refracted = bedCol * caustic * exp(-path * ABSORB)
                 + WATER_TINT * (1.0 - exp(-path * SCATTER));

  // --- the interface layer, lying just under the surface -------------------
  // Its displacement is measured against a flat surface rather than against the
  // screen, so at rest it sits exactly where it was drawn and a click lands on
  // what you see. Only the ripples move it. Everything else about it is the
  // same water: it refracts, takes the caustics, and picks up the green.
  if (uUiDepth > 0.0) {
    vec3 T0 = refract(vec3(0.0, 0.0, -1.0), vec3(0.0, 0.0, 1.0), 1.0 / IOR);
    vec2 rest = T0.xy * (uUiDepth / max(-T0.z, 0.05));
    vec2 uiUv = (p + T.xy * (uUiDepth / tz) - rest) / vec2(uAspect, 1.0) + 0.5;
    vec4 ui = texture(uUi, uiUv);
    float uiPath = (uUiDepth / tz) * 1.6;
    vec3 uiCol = ui.rgb * caustic * exp(-uiPath * ABSORB)
               + WATER_TINT * (1.0 - exp(-uiPath * SCATTER));
    refracted = mix(refracted, uiCol, ui.a);
  }

  // --- reflected path ------------------------------------------------------
  vec3 refl = env(reflect(I, N));

  // --- sun glitter ---------------------------------------------------------
  vec3 H = normalize(normalize(uSunDir) + V);
  float ndh = max(dot(N, H), 0.0);
  // One tight lobe, and only where the surface is genuinely tilted. A
  // directional light on dead-flat water spreads a single soft lobe across a
  // huge part of the frame, because the normal never varies to break it up —
  // that is a rendering artefact, not a highlight. Gating on slope means the
  // sun shows up on ripples and nowhere else.
  float tilt = smoothstep(0.22, 0.60, length(N.xy));
  float spec = pow(ndh, 1100.0) * 0.06 * tilt;

  vec3 color = mix(refracted, refl, F * REFLECT) + spec * SUN_COLOR;

  // Disturbed pond water does not go white — it goes cloudy, because the wake
  // lifts silt off the bed. Muted olive, and only for a genuine flick.
  float fm = smoothstep(0.34, 0.85, silt)
           * (0.4 + 0.6 * vnoise(uv * vec2(uAspect, 1.0) * 70.0 + uTime * 0.25));
  color = mix(color, vec3(0.17, 0.17, 0.115), clamp(fm, 0.0, 1.0) * 0.5);

  // Filmic-ish shoulder, then sRGB, then a dither: without it the sky gradient
  // in the reflection bands badly at 8 bits.
  color *= 0.98;
  color = (color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14);
  color = pow(clamp(color, 0.0, 1.0), vec3(1.0 / 2.2));
  color += (hash(gl_FragCoord.xy + fract(uTime)) - 0.5) / 255.0;

  fragColor = vec4(color, 1.0);
}`

/** Per-tier shader features. Geometry cost is handled by the caller's grid/scale choice. */
const FEATURES = {
  low: { octaves: 2, dispersion: false },
  medium: { octaves: 3, dispersion: false },
  high: { octaves: 4, dispersion: true },
  ultra: { octaves: 5, dispersion: true },
}

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
  if (!gl) throw new Error('WebGL2 is required for the water surface')

  const programs = new Map()
  let tier = 'high'
  let uniforms = null
  let program = null

  function programFor(name) {
    if (programs.has(name)) return programs.get(name)
    const f = FEATURES[name]
    const defines = `#define OCTAVES ${f.octaves}\n${f.dispersion ? '#define DISPERSION 1\n' : ''}`
    // Defines must land after the #version line.
    const src = FRAG.replace('precision highp float;', `${defines}precision highp float;`)
    const prog = gl.createProgram()
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT))
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, src))
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`program link failed:\n${gl.getProgramInfoLog(prog)}`)
    }
    const u = {}
    for (const n of ['uHeight', 'uBed', 'uUi', 'uUiDepth', 'uTexel', 'uBedScale', 'uBedOffset', 'uAspect', 'uTime', 'uSlope', 'uDepth', 'uCaustic', 'uSunDir']) {
      u[n] = gl.getUniformLocation(prog, n)
    }
    const entry = { prog, u }
    programs.set(name, entry)
    return entry
  }

  const vao = gl.createVertexArray() // WebGL2 requires a bound VAO even with no attributes

  const heightTex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, heightTex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  const bedTex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, bedTex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

  const maxAniso = (() => {
    const ext = gl.getExtension('EXT_texture_filter_anisotropic')
    if (!ext) return null
    return { ext, max: gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) }
  })()

  // A 1x1 transparent texture, so a page with no interface layer still has
  // something bound to the sampler without branching the shader.
  const uiTex = gl.createTexture()
  gl.activeTexture(gl.TEXTURE2)
  gl.bindTexture(gl.TEXTURE_2D, uiTex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]))
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  let uiSize = { w: 0, h: 0 }
  let uiDepth = 0

  let grid = { w: 0, h: 0 }
  let bedSize = { w: 1, h: 1 }
  let viewport = { w: 1, h: 1 }

  setTier('high')

  function setTier(name) {
    tier = name in FEATURES ? name : 'high'
    const entry = programFor(tier)
    program = entry.prog
    uniforms = entry.u
    gl.useProgram(program)
    gl.uniform1i(uniforms.uHeight, 0)
    gl.uniform1i(uniforms.uBed, 1)
    gl.uniform1i(uniforms.uUi, 2)
  }

  /** Upload one simulation frame. `data` is interleaved RG half-floats. */
  function uploadFrame(data, w, h) {
    gl.activeTexture(gl.TEXTURE0)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.bindTexture(gl.TEXTURE_2D, heightTex)
    if (w !== grid.w || h !== grid.h) {
      grid = { w, h }
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, w, h, 0, gl.RG, gl.HALF_FLOAT, data)
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RG, gl.HALF_FLOAT, data)
    }
  }

  function setBed(source) {
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, bedTex)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, source)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.generateMipmap(gl.TEXTURE_2D)
    if (maxAniso) gl.texParameterf(gl.TEXTURE_2D, maxAniso.ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, maxAniso.max))
    bedSize = { w: source.width, h: source.height }
  }

  /** Publish the whole interface layer. */
  function setUiLayer(source) {
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, uiTex)
    if (!source) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]))
      uiSize = { w: 0, h: 0 }
      return
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, source)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    uiSize = { w: source.width, h: source.height }
  }

  /**
   * Replace one rectangle of the interface layer. Dragging a control repaints a
   * strip a few hundred pixels wide; re-uploading the whole screen for that
   * would cost more than everything else this frame put together.
   *
   * WebGL2 has no sub-rectangle upload from a canvas, so this takes ImageData.
   */
  function setUiRegion(image, x, y) {
    if (!uiSize.w) return
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, uiTex)
    // With flipY the block's rows are reversed in place, so it has to land at
    // the mirrored offset.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.texSubImage2D(
      gl.TEXTURE_2D, 0,
      x, uiSize.h - (y + image.height),
      image.width, image.height,
      gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.length),
    )
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  }

  /** How deep the interface sits. 0 turns the layer off entirely. */
  function setUiDepth(d) {
    uiDepth = d
  }

  function resize(pixelWidth, pixelHeight) {
    canvas.width = pixelWidth
    canvas.height = pixelHeight
    viewport = { w: pixelWidth, h: pixelHeight }
    gl.viewport(0, 0, pixelWidth, pixelHeight)
  }

  /**
   * Cover-fit, then zoom in by MARGIN. Refraction shifts the bed sample by a
   * large constant at a glancing view angle, so the frame has to sit inside the
   * texture with room to spare — otherwise the edge row smears up the screen.
   */
  const MARGIN = 1.28
  function bedFit() {
    const viewAspect = viewport.w / viewport.h
    const texAspect = bedSize.w / bedSize.h
    let sx = 1, sy = 1
    if (texAspect > viewAspect) sx = viewAspect / texAspect
    else sy = texAspect / viewAspect
    sx /= MARGIN
    sy /= MARGIN
    return { scale: [sx, sy], offset: [(1 - sx) / 2, (1 - sy) / 2] }
  }

  function render(timeSeconds, opts = {}) {
    if (!grid.w) return
    const { scale, offset } = bedFit()
    gl.useProgram(program)
    gl.bindVertexArray(vao)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, heightTex)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, bedTex)
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, uiTex)

    gl.uniform1f(uniforms.uUiDepth, uiDepth)
    gl.uniform2f(uniforms.uTexel, 1 / grid.w, 1 / grid.h)
    gl.uniform2f(uniforms.uBedScale, scale[0], scale[1])
    gl.uniform2f(uniforms.uBedOffset, offset[0], offset[1])
    gl.uniform1f(uniforms.uAspect, viewport.w / viewport.h)
    gl.uniform1f(uniforms.uTime, timeSeconds)
    // Slope is per-texel, so a coarser grid must push harder to look the same.
    gl.uniform1f(uniforms.uSlope, (opts.slope ?? 19.0) * grid.w * 0.0018)
    gl.uniform1f(uniforms.uDepth, opts.depth ?? 0.14)
    gl.uniform1f(uniforms.uCaustic, opts.caustic ?? 26.0)
    const sun = opts.sun ?? [-0.45, 0.62, 0.64]
    gl.uniform3f(uniforms.uSunDir, sun[0], sun[1], sun[2])

    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  function dispose() {
    for (const { prog } of programs.values()) gl.deleteProgram(prog)
    gl.deleteTexture(heightTex)
    gl.deleteTexture(bedTex)
    gl.deleteTexture(uiTex)
    gl.deleteVertexArray(vao)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }

  return {
    gl,
    setTier,
    uploadFrame,
    setBed,
    setUiLayer,
    setUiRegion,
    setUiDepth,
    resize,
    render,
    dispose,
    get tier() {
      return tier
    },
  }
}
