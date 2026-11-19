// The paint under the interface.
//
// The components are ordinary HTML — a card, inputs, a button. What they do not
// have is a surface, and this file paints one for each of them: a slab of the
// pigment they asked for, combed with bristle furrows and laid with a wobbled
// edge, because a flat rounded rectangle comes out looking like plastic on a
// painting.
//
// What is drawn here is not composited over the canvas. It is deposited into
// the pigment field, so from that moment the component's surface is paint: the
// cursor drags it, it mixes subtractively with whatever it is dragged into, and
// it bleeds at its own edges. Alpha is the amount of paint a pixel is worth, so
// a furrow carved here becomes a thinner ridge there.

import { PALETTE, css } from './palette'

/** Deterministic noise, so a slab does not re-wobble on every repaint. */
function hash(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

const GROUND = [0.3, 0.26, 0.22]

/**
 * A rounded rectangle whose edges wander, the way a stroke laid with a loaded
 * brush does. `seed` keeps one slab's wander stable between repaints.
 */
function slabPath(ctx, r, seed) {
  const k = Math.min(14, r.h * 0.4)
  // The wander scales with the slab, or a large one comes out as a rounded
  // rectangle with a faint tremor, which reads as plastic.
  const amp = Math.min(r.h * 0.18, r.w * 0.05, 15)
  const w = (i) => (hash(seed + i) - 0.5) * amp
  ctx.beginPath()
  ctx.moveTo(r.x + k, r.y + w(1))
  ctx.quadraticCurveTo(r.x + r.w * 0.5, r.y + w(2), r.x + r.w - k, r.y + w(3))
  ctx.quadraticCurveTo(r.x + r.w + w(4), r.y, r.x + r.w + w(5), r.y + k)
  ctx.quadraticCurveTo(r.x + r.w + w(6), r.y + r.h * 0.5, r.x + r.w + w(7), r.y + r.h - k)
  ctx.quadraticCurveTo(r.x + r.w, r.y + r.h + w(8), r.x + r.w - k, r.y + r.h + w(9))
  ctx.quadraticCurveTo(r.x + r.w * 0.5, r.y + r.h + w(10), r.x + k, r.y + r.h + w(11))
  ctx.quadraticCurveTo(r.x + w(12), r.y + r.h, r.x + w(13), r.y + r.h - k)
  ctx.quadraticCurveTo(r.x + w(14), r.y + r.h * 0.5, r.x + w(15), r.y + k)
  ctx.quadraticCurveTo(r.x, r.y + w(16), r.x + k, r.y + w(1))
  ctx.closePath()
}

/** Lay a slab, then comb furrows out of its alpha so it reads as brushed. */
function slab(ctx, r, rgb, seed, combed = true) {
  ctx.save()
  slabPath(ctx, r, seed)
  ctx.fillStyle = css(rgb)
  ctx.fill()

  if (combed) {
    ctx.clip()
    // Carving, not painting: this takes thickness away, which is what a bristle
    // does. Painted in colour instead it would just be a stripe.
    ctx.globalCompositeOperation = 'destination-out'
    ctx.lineCap = 'round'
    // Spaced by the slab's size, not its height alone: a card combed as
    // densely as a button comes out corrugated rather than brushed, and on a
    // pale pigment the relief turns every furrow into a hard stripe.
    const n = Math.max(3, Math.round(Math.min(r.h / 9, 14)))
    for (let i = 0; i < n; i++) {
      const y = r.y + ((i + 0.5) / n) * r.h
      ctx.globalAlpha = 0.03 + 0.07 * hash(seed + i * 3.1)
      ctx.lineWidth = 1 + 2.4 * hash(seed + i * 7.3)
      ctx.beginPath()
      ctx.moveTo(r.x - 4, y + (hash(seed + i * 5.9) - 0.5) * 3)
      ctx.lineTo(r.x + r.w + 4, y + (hash(seed + i * 11.3) - 0.5) * 3)
      ctx.stroke()
    }
  }
  ctx.restore()
}

/**
 * A scumbled ground for something the size of a card. Not one slab: a ground is
 * scrubbed in with a wide brush in overlapping passes, and it is the ragged
 * ends of those passes that stop a card reading as a translucent sheet laid
 * over the painting. Opaque in the middle, because the contrast of the text a
 * component puts on top cannot depend on what happens to be underneath.
 */
function scumble(ctx, r, seed) {
  const rows = Math.max(4, Math.round(r.h / 60))
  const h = (r.h / rows) * 1.6
  ctx.save()
  slab(ctx, { x: r.x + 12, y: r.y + 12, w: r.w - 24, h: r.h - 24 }, GROUND, seed + 3, false)
  for (let i = 0; i < rows; i++) {
    const t = rows === 1 ? 0 : i / (rows - 1)
    const over = 10 + 16 * hash(seed + i * 2.7)
    slab(
      ctx,
      {
        x: r.x - over,
        y: r.y + t * (r.h - h),
        w: r.w + over + 10 + 20 * hash(seed + i * 5.3),
        h,
      },
      // Ground is mixed on the palette, so no two passes are quite equal.
      GROUND.map((c) => c * (0.9 + 0.2 * hash(seed + i * 9.1))),
      seed + i * 17,
      false,
    )
  }
  // One comb over the lot, kept inside so it cannot chew the edges just made.
  ctx.beginPath()
  ctx.rect(r.x + 6, r.y + 6, r.w - 12, r.h - 12)
  ctx.clip()
  ctx.globalCompositeOperation = 'destination-out'
  ctx.lineCap = 'round'
  const n = Math.round(r.h / 9)
  for (let i = 0; i < n; i++) {
    const y = r.y + ((i + 0.5) / n) * r.h
    ctx.globalAlpha = 0.05 + 0.09 * hash(seed + i * 3.7)
    ctx.lineWidth = 1 + 2 * hash(seed + i * 6.1)
    ctx.beginPath()
    ctx.moveTo(r.x, y + (hash(seed + i * 4.3) - 0.5) * 4)
    ctx.lineTo(r.x + r.w, y + (hash(seed + i * 8.9) - 0.5) * 4)
    ctx.stroke()
  }
  ctx.restore()
}

/** A `data-oil` value to a pigment, or null for a scumbled ground. */
function pigment(name) {
  if (!name || name === 'ground') return null
  return PALETTE.find((p) => p.name === name)?.rgb ?? GROUND
}

/**
 * Draw one element's surface, filling a `w` x `h` canvas. The alpha this leaves
 * behind is how much paint each pixel is worth when it is laid into the field,
 * so a combed furrow becomes a thinner ridge and a ragged edge becomes a ragged
 * edge, in paint.
 */
export function drawPlaque(ctx, rect, oil, seed) {
  // `rect` is the element's own box inside a canvas that is larger than it,
  // because every edge here deliberately wanders outside the box it was given —
  // the slab's wobble by up to 15px, a scumble pass by up to 26. Drawn flush to
  // the canvas those excursions are clipped square, and the result is a rounded
  // rectangle with bites out of it: the "looks like plastic" the wobble exists
  // to avoid.
  if (rect.w <= 0 || rect.h <= 0) return
  const rgb = pigment(oil)
  if (rgb) slab(ctx, rect, rgb, seed)
  else scumble(ctx, rect, seed)
}
