// Minimal WebGL2 renderer: one program, one draw call per sheet.
//
// Vertices arrive already packed by the sim (position, smooth normal, edge) so
// a frame is a single bufferSubData per sheet and nothing is computed here.

const VERT = `#version 300 es
in vec3 aPos;
in vec3 aNormal;
in float aEdge;
in vec2 aUV;
uniform mat4 uMVP;
uniform vec2 uSize;
uniform float uZOffset;
uniform float uScale; // keeps a layer covering the viewport from further back
uniform vec2 uShadowOffset; // shifts the shadow pass away from the light
out vec2 vUV;
out vec3 vNormal;
out float vEdge;
void main() {
  vec3 wp = vec3(
    (aPos.x - uSize.x * 0.5) * uScale + uShadowOffset.x,
    (uSize.y * 0.5 - aPos.y) * uScale - uShadowOffset.y,
    aPos.z + uZOffset);
  // sheet space has y running down, world space has it running up
  vNormal = vec3(aNormal.x, -aNormal.y, aNormal.z);
  vUV = aUV;
  vEdge = aEdge;
  gl_Position = uMVP * vec4(wp, 1.0);
}`

const FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
in vec3 vNormal;
in float vEdge;
uniform sampler2D uTex;
uniform float uOpacity;
uniform vec2 uGrain; // frequency of the torn fibre fringe, in sheet space
uniform float uShadow; // >0 draws this sheet as the shadow it casts below
out vec4 frag;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

// Value noise: a torn fibre edge is lumpy, not per-pixel static.
float lumps(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

void main() {
  // Chew a ragged fringe out of the triangles that border a tear. The noise is
  // several times finer than one cell, so the silhouette reads as torn fibre
  // rather than as the mesh it is cut from.
  if (vEdge > 0.35) {
    vec2 q = vUV * uGrain;
    float n = lumps(q) * 0.55 + lumps(q * 2.7) * 0.3 + lumps(q * 6.1) * 0.15;
    if (vEdge > 0.30 + 0.62 * n) discard;
  }
  // The shadow pass reuses the same geometry and the same torn edges, so a
  // hole in the paper is a hole in its shadow.
  if (uShadow > 0.0) {
    frag = vec4(0.0, 0.0, 0.0, uShadow);
    return;
  }
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 L = normalize(vec3(-0.30, 0.45, 0.84));
  float diff = clamp(dot(n, L), 0.0, 1.0);
  float wrap = clamp(dot(n, normalize(vec3(0.5, -0.3, 0.6))), 0.0, 1.0); // fill
  vec4 c = texture(uTex, vUV);
  if (!gl_FrontFacing) c.rgb = mix(vec3(0.94, 0.92, 0.88), c.rgb, 0.16); // paper back
  float shade = 0.54 + 0.42 * diff + 0.12 * wrap;
  frag = vec4(c.rgb * shade, c.a * uOpacity);
}`

function compile(gl, type, src) {
  const sh = gl.createShader(type)
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(sh) || 'shader compile failed')
  }
  return sh
}

function mul(a, b) { // column-major 4x4
  const o = new Float32Array(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]
    }
  }
  return o
}

const STRIDE = 28 // x,y,z, nx,ny,nz, edge

export function createRenderer(canvas) {
  const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, premultipliedAlpha: false })
  if (!gl) throw new Error('WebGL2 is required')

  const prog = gl.createProgram()
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT))
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG))
  gl.bindAttribLocation(prog, 0, 'aPos')
  gl.bindAttribLocation(prog, 1, 'aNormal')
  gl.bindAttribLocation(prog, 2, 'aEdge')
  gl.bindAttribLocation(prog, 3, 'aUV')
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog))
  gl.useProgram(prog)
  const uMVP = gl.getUniformLocation(prog, 'uMVP')
  const uSize = gl.getUniformLocation(prog, 'uSize')
  const uOpacity = gl.getUniformLocation(prog, 'uOpacity')
  const uZOffset = gl.getUniformLocation(prog, 'uZOffset')
  const uScale = gl.getUniformLocation(prog, 'uScale')
  const uGrain = gl.getUniformLocation(prog, 'uGrain')
  const uShadow = gl.getUniformLocation(prog, 'uShadow')
  const uShadowOffset = gl.getUniformLocation(prog, 'uShadowOffset')
  gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0)

  gl.enable(gl.DEPTH_TEST)
  gl.depthFunc(gl.LEQUAL)
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

  let camD = 1


  function resize(w, h, dpr) {
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    gl.viewport(0, 0, canvas.width, canvas.height)

    const fov = Math.PI / 4
    const D = h / 2 / Math.tan(fov / 2) // plane z=0 fills the viewport exactly
    camD = D
    const aspect = w / h
    const near = D * 0.05, far = D * 4
    const f = 1 / Math.tan(fov / 2)
    const P = new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) / (near - far), -1,
      0, 0, (2 * far * near) / (near - far), 0,
    ])
    const T = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -D, 1])
    gl.useProgram(prog)
    gl.uniformMatrix4fv(uMVP, false, mul(P, T))
    gl.uniform2f(uSize, w, h)

  }

  // `live` marks a sheet whose texture is updated every frame (it has video on
  // it). Those cannot use mipmaps: the chain would go stale the moment a new
  // frame is uploaded into part of the texture.
  function createTexture(source, live = false) {
    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
    if (!live) gl.generateMipmap(gl.TEXTURE_2D)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, live ? gl.LINEAR : gl.LINEAR_MIPMAP_LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return tex
  }

  // One mesh per sheet: interleaved vertices from the worker, static UVs, and
  // an index buffer that only changes when paper actually tears.
  // Pushes a new video frame into the part of the sheet texture it occupies.
  // Only that rectangle is uploaded, so a playing video costs about as much as
  // a small sprite rather than a full-page texture every frame.
  function updateTextureRegion(tex, region, scratch) {
    const { video, x, y, w, h, radius, overlay, backdrop, pageWidth, pageHeight } = region
    if (video.readyState < 2 || !video.videoWidth) return false
    const ctx = scratch.getContext('2d')
    const sw = video.videoWidth, sh = video.videoHeight
    const scale = Math.max(w / sw, h / sh)
    const dw = sw * scale, dh = sh * scale
    ctx.clearRect(0, 0, w, h)
    if (backdrop) {
      ctx.fillStyle = backdrop
      ctx.fillRect(0, 0, w, h)
    }
    if (radius) {
      // the corners were rounded when the sheet was baked; keep them that way
      const r = Math.min(radius, w / 2, h / 2)
      ctx.save()
      ctx.beginPath()
      ctx.moveTo(r, 0)
      ctx.arcTo(w, 0, w, h, r)
      ctx.arcTo(w, h, 0, h, r)
      ctx.arcTo(0, h, 0, 0, r)
      ctx.arcTo(0, 0, w, 0, r)
      ctx.closePath()
      ctx.clip()
    }
    ctx.filter = 'grayscale(1) contrast(1.05)' // web-tear is monochrome
    ctx.drawImage(video, (w - dw) / 2, (h - dh) / 2, dw, dh)
    ctx.filter = 'none'
    if (radius) ctx.restore()
    // put the page's own markup back on top of the fresh frame
    if (overlay) ctx.drawImage(overlay, -x, -y, pageWidth, pageHeight)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE, scratch)
    return true
  }

  function createMesh(nodes, uv) {
    const vao = gl.createVertexArray()
    gl.bindVertexArray(vao)
    const vertBuf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, vertBuf)
    gl.bufferData(gl.ARRAY_BUFFER, nodes * STRIDE, gl.DYNAMIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE, 0)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, STRIDE, 12)
    gl.enableVertexAttribArray(2)
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, STRIDE, 24)
    const uvBuf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf)
    gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW)
    gl.enableVertexAttribArray(3)
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, 0, 0)
    const idxBuf = gl.createBuffer()
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, (nodes * 6 + 6) * 4, gl.DYNAMIC_DRAW)
    gl.bindVertexArray(null)
    return {
      vao, vertBuf, idxBuf, count: 0,
      dispose() {
        gl.deleteVertexArray(vao); gl.deleteBuffer(vertBuf)
        gl.deleteBuffer(uvBuf); gl.deleteBuffer(idxBuf)
      },
    }
  }

  function uploadVerts(mesh, verts) {
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vertBuf)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, verts)
  }

  function uploadIndices(mesh, indices) {
    gl.bindVertexArray(mesh.vao)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.idxBuf)
    gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, indices)
    gl.bindVertexArray(null)
    mesh.count = indices.length
  }

  function begin(r, g, b) {
    gl.clearColor(r, g, b, 1)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    gl.useProgram(prog)
  }

  // `depth` is how far behind the front sheet this layer sits, in pixels. The
  // matching scale keeps it covering the viewport exactly despite perspective.
  // The shadow a sheet casts on whatever is beneath it. Drawn before the sheet
  // itself, with the same mesh: that is what makes a tear read as an opening
  // with something further away behind it, rather than a flat hole.
  function drawShadow(mesh, depth, grain, strength, offset) {
    if (!mesh.count) return
    const d = depth || 0
    gl.depthMask(false)
    gl.uniform1f(uShadow, strength)
    gl.uniform2f(uShadowOffset, offset, offset)
    gl.uniform1f(uOpacity, 1)
    gl.uniform1f(uZOffset, -d)
    gl.uniform1f(uScale, (camD + d) / camD)
    gl.uniform2f(uGrain, grain[0], grain[1])
    gl.bindVertexArray(mesh.vao)
    gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0)
    gl.uniform1f(uShadow, 0)
    gl.uniform2f(uShadowOffset, 0, 0)
    gl.depthMask(true)
  }

  function drawCloth(mesh, tex, depth, grain) {
    if (!mesh.count) return
    const d = depth || 0
    gl.uniform1f(uOpacity, 1)
    gl.uniform1f(uZOffset, -d)
    gl.uniform1f(uScale, (camD + d) / camD)
    gl.uniform2f(uGrain, grain[0], grain[1])
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.bindVertexArray(mesh.vao)
    gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0)
  }

  return {
    gl, resize, createTexture, createMesh, uploadVerts, uploadIndices, updateTextureRegion,
    begin, drawCloth, drawShadow,
    deleteTexture: (t) => gl.deleteTexture(t),
  }
}
