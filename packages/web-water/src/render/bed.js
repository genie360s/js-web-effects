// Procedural pond bed: silt, pebbles and fallen leaves, drawn once into a
// canvas and handed to the GPU as a texture. Everything below the waterline is
// generated here — there are no image assets in this project.
//
// Deterministic: the same seed always draws the same bed, so a look you like is
// a number you can write down.

/** Small, fast, seedable PRNG. */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TAU = Math.PI * 2

/** Light comes from the upper left, as it does in most outdoor photographs. */
const LIGHT = { x: -0.62, y: -0.78 }

const SILT = ['#4c4a36', '#585437', '#3e3f2d', '#615c3e']
// Wet stone under water is dark and saturated, not pale grey.
const ROCK = [
  { base: '#4f4a41', lit: '#6d665a', dark: '#2a2823' },
  { base: '#43423d', lit: '#5d5b55', dark: '#24241f' },
  { base: '#584f43', lit: '#786c5b', dark: '#2f2a22' },
  { base: '#3c4039', lit: '#565c50', dark: '#20231d' },
  { base: '#5a5348', lit: '#7d7362', dark: '#322d26' },
  { base: '#4a4340', lit: '#665d58', dark: '#272220' },
]
const LEAF = [
  { fill: '#a8552a', vein: '#d08a4e', edge: '#6d3318' },
  { fill: '#b8843a', vein: '#dcb066', edge: '#7a5320' },
  { fill: '#8f3f22', vein: '#bf6b3c', edge: '#5b2413' },
  { fill: '#7c6a25', vein: '#a89544', edge: '#4e4214' },
  { fill: '#5f6b2f', vein: '#8a9450', edge: '#3a431b' },
  { fill: '#6d4a28', vein: '#99724a', edge: '#402a15' },
]

const pick = (rnd, arr) => arr[(rnd() * arr.length) | 0]
const lerp = (a, b, t) => a + (b - a) * t

/**
 * Draw the bed.
 * @param {object} o
 * @param {number} o.width  texture width in px
 * @param {number} o.height texture height in px
 * @param {number} o.seed
 * @param {number} o.density 0..1 — scales how much litter is on the bottom
 * @returns {HTMLCanvasElement}
 */
export function generateBed({ width, height, seed = 1, density = 1 }) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  const rnd = mulberry32(seed)
  // Scale every hand-tuned size with the texture, so a 1024px bed and a 2048px
  // bed differ in detail, not in composition.
  const S = Math.min(width, height) / 1000

  silt(ctx, rnd, width, height, S)

  // Deeper litter first, so later (shallower) pieces overlap it correctly.
  const rocks = Math.round(((width * height) / 44000) * density)
  const leaves = Math.round(((width * height) / 56000) * density)

  gravel(ctx, rnd, width, height, S, density)
  const placed = []
  for (let i = 0; i < rocks; i++) drawRock(ctx, rnd, width, height, S, placed)
  for (let i = 0; i < leaves; i++) drawLeaf(ctx, rnd, width, height, S)

  detritus(ctx, rnd, width, height, S, density)
  vignette(ctx, width, height)
  ctx.filter = 'none'
  return canvas
}

/** Wet silt: a dark base, broken up by soft blotches and a fine grain. */
function silt(ctx, rnd, w, h, S) {
  const g = ctx.createLinearGradient(0, 0, w * 0.4, h)
  g.addColorStop(0, '#585539')
  g.addColorStop(0.5, '#4a4833')
  g.addColorStop(1, '#3a3b2b')
  ctx.fillStyle = '#4c4a34'
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)

  // Soft blotches at two scales read as uneven sediment.
  for (const [count, size, alpha] of [[90, 240, 0.6], [220, 90, 0.45]]) {
    ctx.globalAlpha = alpha
    for (let i = 0; i < count; i++) {
      const x = rnd() * w
      const y = rnd() * h
      const r = size * S * (0.4 + rnd())
      const blob = ctx.createRadialGradient(x, y, 0, x, y, r)
      blob.addColorStop(0, pick(rnd, SILT))
      blob.addColorStop(1, 'transparent')
      ctx.fillStyle = blob
      ctx.beginPath()
      ctx.arc(x, y, r, 0, TAU)
      ctx.fill()
    }
  }
  ctx.globalAlpha = 1

  // Grain. Tiny, but dense: this is the high-frequency detail that lets a
  // ripple show itself when it passes over open silt.
  const grains = Math.round((w * h) / 320)
  for (let i = 0; i < grains; i++) {
    const x = rnd() * w
    const y = rnd() * h
    const v = rnd()
    ctx.fillStyle = v > 0.5 ? `rgba(180,172,140,${0.06 + rnd() * 0.1})` : `rgba(20,20,14,${0.08 + rnd() * 0.12})`
    ctx.fillRect(x, y, Math.max(1, S * 1.6), Math.max(1, S * 1.6))
  }
}

/** An irregular closed blob, built from a few harmonics of radial noise. */
function blobPath(ctx, rnd, cx, cy, r, squash, rot, lumpiness = 0.22) {
  const k = 26
  const a1 = rnd() * TAU, a2 = rnd() * TAU, a3 = rnd() * TAU
  const h1 = lumpiness, h2 = lumpiness * 0.55, h3 = lumpiness * 0.3
  ctx.beginPath()
  for (let i = 0; i <= k; i++) {
    const a = (i / k) * TAU
    const rr = r * (1 + h1 * Math.sin(a * 2 + a1) + h2 * Math.sin(a * 3 + a2) + h3 * Math.sin(a * 5 + a3))
    const x = Math.cos(a) * rr
    const y = Math.sin(a) * rr * squash
    const px = cx + x * Math.cos(rot) - y * Math.sin(rot)
    const py = cy + x * Math.sin(rot) + y * Math.cos(rot)
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.closePath()
}

/** A scatter of small gravel. Cheap, and it is most of what a pond floor is. */
function gravel(ctx, rnd, w, h, S, density) {
  const count = Math.round(((w * h) / 5200) * density)
  for (let i = 0; i < count; i++) {
    const x = rnd() * w
    const y = rnd() * h
    const r = S * (2.5 + rnd() * 7)
    const pal = pick(rnd, ROCK)
    const squash = 0.55 + rnd() * 0.4
    const rot = rnd() * TAU

    ctx.save()
    ctx.globalAlpha = 0.5 + rnd() * 0.45
    // A touch of shadow on the shaded side is what makes a pebble read as a
    // pebble rather than a dot.
    ctx.fillStyle = '#1c1d15'
    blobPath(ctx, mulberry32((rnd() * 1e9) | 0), x - LIGHT.x * r * 0.35, y - LIGHT.y * r * 0.35, r * 1.05, squash, rot, 0.3)
    ctx.fill()

    const seed = (rnd() * 1e9) | 0
    blobPath(ctx, mulberry32(seed), x, y, r, squash, rot, 0.3)
    const g = ctx.createLinearGradient(x + LIGHT.x * r, y + LIGHT.y * r, x - LIGHT.x * r, y - LIGHT.y * r)
    g.addColorStop(0, pal.lit)
    g.addColorStop(0.6, pal.base)
    g.addColorStop(1, pal.dark)
    ctx.fillStyle = g
    ctx.fill()
    ctx.restore()
  }
}

function drawRock(ctx, rnd, w, h, S, placed) {
  // Many small pebbles, few large ones.
  const t = rnd()
  const r = lerp(10, 78, t * t * t) * S * (0.7 + rnd() * 0.6)
  const cx = rnd() * w
  const cy = rnd() * h

  // Keep the big ones from piling into one lump.
  if (r > 30 * S) {
    for (const p of placed) {
      if (Math.hypot(p.x - cx, p.y - cy) < (p.r + r) * 0.72) return
    }
  }
  placed.push({ x: cx, y: cy, r })

  const pal = pick(rnd, ROCK)
  const squash = 0.6 + rnd() * 0.32
  const rot = rnd() * TAU
  const sink = 0.35 + rnd() * 0.4 // how bedded-in it looks

  const seedR = (rnd() * 1e9) | 0
  ctx.save()

  // Contact shadow: same outline as the body, cast away from the light.
  ctx.filter = `blur(${Math.max(1, r * 0.22)}px)`
  ctx.globalAlpha = 0.5
  ctx.fillStyle = '#14150f'
  blobPath(ctx, mulberry32(seedR), cx - LIGHT.x * r * 0.3, cy - LIGHT.y * r * 0.3, r * 1.06, squash, rot)
  ctx.fill()
  ctx.filter = 'none'
  ctx.globalAlpha = 1

  // Body.
  blobPath(ctx, mulberry32(seedR), cx, cy, r, squash, rot)
  ctx.save()
  ctx.clip()

  const g = ctx.createLinearGradient(cx + LIGHT.x * r, cy + LIGHT.y * r, cx - LIGHT.x * r, cy - LIGHT.y * r)
  g.addColorStop(0, pal.lit)
  g.addColorStop(0.45, pal.base)
  g.addColorStop(1, pal.dark)
  ctx.fillStyle = g
  ctx.fillRect(cx - r * 1.4, cy - r * 1.4, r * 2.8, r * 2.8)

  // Mineral speckle and a couple of fractures.
  const specks = Math.round(r * r * 0.03)
  for (let i = 0; i < specks; i++) {
    const a = rnd() * TAU
    const d = Math.sqrt(rnd()) * r
    const x = cx + Math.cos(a) * d
    const y = cy + Math.sin(a) * d * squash
    ctx.fillStyle = rnd() > 0.5 ? `rgba(226,220,200,${rnd() * 0.1})` : `rgba(0,0,0,${rnd() * 0.22})`
    ctx.fillRect(x, y, Math.max(1, S * 1.8), Math.max(1, S * 1.8))
  }
  // Broad tonal banding rather than drawn cracks: a stroked crack across a
  // pebble reads as a leaf vein, which is the one thing it must not look like.
  if (r > 16 * S) {
    for (let i = 0; i < 3; i++) {
      const bx = cx + (rnd() - 0.5) * r
      const by = cy + (rnd() - 0.5) * r * squash
      const br = r * (0.3 + rnd() * 0.5)
      const band = ctx.createRadialGradient(bx, by, 0, bx, by, br)
      band.addColorStop(0, rnd() > 0.5 ? `rgba(0,0,0,${0.1 + rnd() * 0.16})` : `rgba(190,180,158,${0.05 + rnd() * 0.08})`)
      band.addColorStop(1, 'transparent')
      ctx.fillStyle = band
      ctx.beginPath()
      ctx.arc(bx, by, br, 0, TAU)
      ctx.fill()
    }
  }

  // Silt drifted against the bedded edge.
  const bury = ctx.createLinearGradient(cx - LIGHT.x * r, cy - LIGHT.y * r * 0.2, cx - LIGHT.x * r * 0.1, cy - LIGHT.y * r)
  bury.addColorStop(0, `rgba(44,45,34,${sink})`)
  bury.addColorStop(1, 'rgba(44,45,34,0)')
  ctx.fillStyle = bury
  ctx.fillRect(cx - r * 1.4, cy - r * 1.4, r * 2.8, r * 2.8)

  // Algae on a few of them.
  if (rnd() > 0.68) {
    ctx.globalAlpha = 0.16 + rnd() * 0.2
    ctx.filter = `blur(${Math.max(1, r * 0.12)}px)`
    ctx.fillStyle = rnd() > 0.5 ? '#5c6b34' : '#47572e'
    blobPath(ctx, mulberry32((rnd() * 1e9) | 0), cx + (rnd() - 0.5) * r, cy + r * 0.3, r * 0.6, 0.7, rnd() * TAU, 0.45)
    ctx.fill()
    ctx.filter = 'none'
    ctx.globalAlpha = 1
  }
  ctx.restore()

  // Wet rim catching the light.
  blobPath(ctx, mulberry32(seedR), cx, cy, r, squash, rot)
  ctx.strokeStyle = `rgba(214,214,196,${0.05 + rnd() * 0.07})`
  ctx.lineWidth = Math.max(1, S * 2)
  ctx.save()
  ctx.clip()
  ctx.translate(LIGHT.x * S * 2.5, LIGHT.y * S * 2.5)
  blobPath(ctx, mulberry32(seedR), cx, cy, r, squash, rot)
  ctx.stroke()
  ctx.restore()

  ctx.restore()
}

function drawLeaf(ctx, rnd, w, h, S) {
  const len = (34 + rnd() * 86) * S
  const wid = len * (0.34 + rnd() * 0.26)
  const cx = rnd() * w
  const cy = rnd() * h
  const rot = rnd() * TAU
  const pal = pick(rnd, LEAF)
  // Depth: deeper leaves are dimmer, bluer and softer.
  const depth = rnd()
  const curl = (rnd() - 0.5) * 0.5

  ctx.save()
  ctx.translate(cx, cy)
  ctx.rotate(rot)

  // Shadow on the silt.
  ctx.save()
  ctx.filter = `blur(${Math.max(1.5, len * 0.08)}px)`
  ctx.globalAlpha = 0.34
  ctx.fillStyle = '#16170f'
  leafPath(ctx, len, wid, curl, len * 0.06, len * 0.05)
  ctx.fill()
  ctx.restore()

  if (depth > 0.55) ctx.filter = `blur(${(depth - 0.55) * 5 * S + 0.3}px)`
  ctx.globalAlpha = lerp(0.94, 0.55, depth)

  leafPath(ctx, len, wid, curl, 0, 0)
  ctx.save()
  ctx.clip()

  // Blade, lit across its length.
  const g = ctx.createLinearGradient(-len / 2, -wid / 2, len / 2, wid / 2)
  g.addColorStop(0, pal.edge)
  g.addColorStop(0.45, pal.fill)
  g.addColorStop(1, pal.edge)
  ctx.fillStyle = g
  ctx.fillRect(-len, -len, len * 2, len * 2)

  // Blotching and decay.
  for (let i = 0; i < 9; i++) {
    const x = (rnd() - 0.5) * len
    const y = (rnd() - 0.5) * wid
    const r = (0.06 + rnd() * 0.16) * len
    const b = ctx.createRadialGradient(x, y, 0, x, y, r)
    b.addColorStop(0, rnd() > 0.45 ? `rgba(60,40,18,${0.1 + rnd() * 0.3})` : `rgba(210,170,100,${0.06 + rnd() * 0.16})`)
    b.addColorStop(1, 'transparent')
    ctx.fillStyle = b
    ctx.beginPath()
    ctx.arc(x, y, r, 0, TAU)
    ctx.fill()
  }
  ctx.restore()

  // Midrib and veins.
  ctx.strokeStyle = pal.vein
  ctx.globalAlpha *= 0.65
  ctx.lineWidth = Math.max(1, S * 1.8)
  ctx.beginPath()
  ctx.moveTo(-len / 2, 0)
  ctx.quadraticCurveTo(0, wid * curl, len / 2, 0)
  ctx.stroke()

  ctx.lineWidth = Math.max(0.6, S * 1.1)
  ctx.globalAlpha *= 0.75
  const veins = 5 + ((rnd() * 4) | 0)
  for (let i = 1; i < veins; i++) {
    const t = i / veins
    const x = lerp(-len * 0.44, len * 0.42, t)
    const spread = Math.sin(t * Math.PI) * wid * 0.5
    const yMid = wid * curl * Math.sin(t * Math.PI)
    for (const s of [1, -1]) {
      ctx.beginPath()
      ctx.moveTo(x, yMid)
      ctx.quadraticCurveTo(x + len * 0.1, yMid + spread * s * 0.6, x + len * 0.16, yMid + spread * s)
      ctx.stroke()
    }
  }

  // Torn, darker margin.
  ctx.globalAlpha = lerp(0.5, 0.25, depth)
  ctx.strokeStyle = pal.edge
  ctx.lineWidth = Math.max(1, S * 2.2)
  leafPath(ctx, len, wid, curl, 0, 0)
  ctx.stroke()

  ctx.restore()
}

/** A leaf blade: two curves meeting at tip and stem, with a slight S-curl. */
function leafPath(ctx, len, wid, curl, ox, oy) {
  const hl = len / 2
  const hw = wid / 2
  ctx.beginPath()
  ctx.moveTo(-hl + ox, oy)
  ctx.bezierCurveTo(-hl * 0.4 + ox, -hw + oy, hl * 0.45 + ox, -hw * (1 + curl) + oy, hl + ox, oy)
  ctx.bezierCurveTo(hl * 0.45 + ox, hw * (1 - curl) + oy, -hl * 0.4 + ox, hw + oy, -hl + ox, oy)
  ctx.closePath()
}

/** Twigs, seed husks and specks — the small stuff that sells a real pond floor. */
function detritus(ctx, rnd, w, h, S, density) {
  const twigs = Math.round(((w * h) / 420000) * density)
  for (let i = 0; i < twigs; i++) {
    const x = rnd() * w
    const y = rnd() * h
    const len = (40 + rnd() * 130) * S
    const a = rnd() * TAU
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(a)
    ctx.globalAlpha = 0.5 + rnd() * 0.35
    ctx.filter = `blur(${S * 0.8}px)`
    ctx.strokeStyle = pick(rnd, ['#4a3a24', '#3b2f1d', '#5a4830'])
    ctx.lineWidth = Math.max(1, S * (2 + rnd() * 3))
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(-len / 2, 0)
    ctx.quadraticCurveTo(0, (rnd() - 0.5) * len * 0.22, len / 2, 0)
    ctx.stroke()
    ctx.restore()
  }
  ctx.filter = 'none'
  ctx.globalAlpha = 1

  const specks = Math.round(((w * h) / 9000) * density)
  for (let i = 0; i < specks; i++) {
    const x = rnd() * w
    const y = rnd() * h
    const r = S * (1 + rnd() * 2.6)
    ctx.fillStyle = rnd() > 0.35
      ? `rgba(28,24,14,${0.2 + rnd() * 0.45})`
      : `rgba(150,130,80,${0.1 + rnd() * 0.25})`
    ctx.beginPath()
    ctx.ellipse(x, y, r, r * (0.5 + rnd() * 0.5), rnd() * TAU, 0, TAU)
    ctx.fill()
  }
}

/** The bed falls off into shadow at the margins, as a real bank does. */
function vignette(ctx, w, h) {
  const g = ctx.createRadialGradient(w * 0.45, h * 0.4, Math.min(w, h) * 0.2, w * 0.5, h * 0.5, Math.max(w, h) * 0.78)
  g.addColorStop(0, 'rgba(0,0,0,0)')
  g.addColorStop(1, 'rgba(10,12,7,0.38)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
}
