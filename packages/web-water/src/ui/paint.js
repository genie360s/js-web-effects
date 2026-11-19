// Painting the submerged interface.
//
// These are drawn as objects sitting in a pond, not as flat interface chrome:
// pale ceramic with a grain to it, a soft shadow dropped onto the silt, a wet
// highlight along the lit edge. The water then takes care of the rest — it
// refracts them, runs caustics over them and pulls them green.
//
// Everything is painted light and warm on purpose. The absorption in the shader
// eats red first, so anything drawn cool and dark down here turns to mud.

const FACE = '#d9d3c0'
const FACE_LOW = '#bcb4a0'
const EDGE_LIT = '#f2ecdc'
const EDGE_DARK = '#8d856f'
const INK = '#3a3427'
const INK_SOFT = 'rgba(58, 52, 39, 0.62)'
const ACCENT = '#6f8f5e'
const ACCENT_LOW = '#54704a'
const TRACK_OFF = '#a9a292'

const FONT = '"42dot Sans", ui-sans-serif, system-ui, sans-serif'

function rr(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rad, y)
  ctx.arcTo(x + w, y, x + w, y + h, rad)
  ctx.arcTo(x + w, y + h, x, y + h, rad)
  ctx.arcTo(x, y + h, x, y, rad)
  ctx.arcTo(x, y, x + w, y, rad)
  ctx.closePath()
}

/** A soft shadow cast down onto the bed. */
function shadow(ctx, draw, blur, dy, alpha = 0.42) {
  ctx.save()
  ctx.filter = `blur(${blur}px)`
  ctx.globalAlpha = alpha
  ctx.fillStyle = '#10140d'
  ctx.translate(1.5, dy)
  draw()
  ctx.fill()
  ctx.restore()
}

/** Fine speckle, so a face reads as fired clay rather than as a filled rect. */
function grain(ctx, x, y, w, h, seed) {
  let a = seed >>> 0
  const rnd = () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const n = Math.round((w * h) / 90)
  for (let i = 0; i < n; i++) {
    const px = x + rnd() * w
    const py = y + rnd() * h
    ctx.fillStyle = rnd() > 0.5 ? `rgba(255,252,240,${rnd() * 0.3})` : `rgba(60,54,40,${rnd() * 0.16})`
    ctx.fillRect(px, py, 1, 1)
  }
}

/** A raised ceramic face with a lit top edge and a shaded bottom one. */
function face(ctx, x, y, w, h, r, { pressed = false, warm = 0, seed = 1 } = {}) {
  const g = ctx.createLinearGradient(0, y, 0, y + h)
  if (pressed) {
    g.addColorStop(0, FACE_LOW)
    g.addColorStop(1, '#cdc6b3')
  } else {
    g.addColorStop(0, `rgb(${233 + warm * 8}, ${228 + warm * 6}, ${212 + warm * 2})`)
    g.addColorStop(1, FACE_LOW)
  }
  ctx.fillStyle = g
  rr(ctx, x, y, w, h, r)
  ctx.fill()

  ctx.save()
  rr(ctx, x, y, w, h, r)
  ctx.clip()
  grain(ctx, x, y, w, h, seed)
  // The wet rim: bright where the light lands, dark where it does not.
  ctx.lineWidth = 2
  ctx.strokeStyle = pressed ? EDGE_DARK : EDGE_LIT
  rr(ctx, x + 1, y + (pressed ? 1.5 : 1), w - 2, h - 2, r)
  ctx.stroke()
  ctx.strokeStyle = pressed ? EDGE_LIT : EDGE_DARK
  ctx.globalAlpha = 0.5
  rr(ctx, x + 1, y - (pressed ? 1.5 : 1), w - 2, h - 2, r)
  ctx.stroke()
  ctx.restore()
}

function label(ctx, text, x, y, { size = 14, weight = 500, color = INK, align = 'left' } = {}) {
  ctx.font = `${weight} ${size}px ${FONT}`
  ctx.textAlign = align
  ctx.textBaseline = 'alphabetic'
  // Etched, not printed: a pale offset underneath reads as cut into the face.
  ctx.fillStyle = 'rgba(255,252,242,0.5)'
  ctx.fillText(text, x, y + 1)
  ctx.fillStyle = color
  ctx.fillText(text, x, y)
}

/**
 * Paint the scene. With `clip` only that rectangle is redrawn, which is what
 * makes dragging a control cheap.
 */
export function paintScene(ctx, scene, dpr, clip) {
  ctx.save()
  ctx.scale(dpr, dpr)

  if (clip) {
    ctx.beginPath()
    ctx.rect(clip.x, clip.y, clip.w, clip.h)
    ctx.clip()
    ctx.clearRect(clip.x, clip.y, clip.w, clip.h)
  } else {
    ctx.clearRect(0, 0, ctx.canvas.width / dpr, ctx.canvas.height / dpr)
  }

  for (const wgt of scene.widgets) {
    if (clip && wgt.type !== 'panel' && !overlaps(scene.damage(wgt), clip)) continue
    paintWidget(ctx, scene, wgt)
  }
  ctx.restore()
}

function overlaps(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

function paintWidget(ctx, scene, wgt) {
  const hot = scene.hover === wgt
  const down = scene.active === wgt

  switch (wgt.type) {
    case 'panel': {
      shadow(ctx, () => rr(ctx, wgt.x, wgt.y, wgt.w, wgt.h, 20), 18, 14, 0.5)
      face(ctx, wgt.x, wgt.y, wgt.w, wgt.h, 20, { seed: 99 })
      label(ctx, wgt.title, wgt.titleAt.x, wgt.titleAt.y, { size: 25, weight: 300 })
      // A hairline under the title, the way a stamped plate would be scored.
      ctx.strokeStyle = 'rgba(58,52,39,0.18)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(wgt.x + 26, wgt.titleAt.y + 34)
      ctx.lineTo(wgt.x + wgt.w - 26, wgt.titleAt.y + 34)
      ctx.stroke()
      break
    }

    case 'caption':
      label(ctx, wgt.text, wgt.x, wgt.y, { size: 12, weight: 400, color: INK_SOFT })
      break

    case 'slider': {
      label(ctx, wgt.label, wgt.x, wgt.y + 10, { size: 12, weight: 500, color: INK_SOFT })
      label(ctx, wgt.value.toFixed(2), wgt.x + wgt.w, wgt.y + 10, {
        size: 12, weight: 500, color: INK_SOFT, align: 'right',
      })

      const t = (wgt.value - wgt.min) / (wgt.max - wgt.min)
      const kx = wgt.x + wgt.w * t

      ctx.lineCap = 'round'
      ctx.lineWidth = 4
      ctx.strokeStyle = 'rgba(58,52,39,0.22)'
      ctx.beginPath()
      ctx.moveTo(wgt.x, wgt.trackY)
      ctx.lineTo(wgt.x + wgt.w, wgt.trackY)
      ctx.stroke()

      ctx.strokeStyle = ACCENT
      ctx.beginPath()
      ctx.moveTo(wgt.x, wgt.trackY)
      ctx.lineTo(kx, wgt.trackY)
      ctx.stroke()

      const r = down ? 10 : hot ? 9.5 : 8.5
      shadow(ctx, () => { ctx.beginPath(); ctx.arc(kx, wgt.trackY, r, 0, Math.PI * 2) }, 5, 4, 0.45)
      const kg = ctx.createLinearGradient(0, wgt.trackY - r, 0, wgt.trackY + r)
      kg.addColorStop(0, EDGE_LIT)
      kg.addColorStop(1, FACE_LOW)
      ctx.fillStyle = kg
      ctx.beginPath()
      ctx.arc(kx, wgt.trackY, r, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = 'rgba(90,82,64,0.5)'
      ctx.lineWidth = 1
      ctx.stroke()
      break
    }

    case 'toggle': {
      label(ctx, wgt.label, wgt.x, wgt.y + 20, { size: 13, weight: 500 })
      const tw = 52
      const th = 26
      const tx = wgt.x + wgt.w - tw
      const ty = wgt.y + 2

      shadow(ctx, () => rr(ctx, tx, ty, tw, th, th / 2), 6, 4, 0.4)
      ctx.fillStyle = wgt.value ? ACCENT_LOW : TRACK_OFF
      rr(ctx, tx, ty, tw, th, th / 2)
      ctx.fill()
      ctx.save()
      rr(ctx, tx, ty, tw, th, th / 2)
      ctx.clip()
      grain(ctx, tx, ty, tw, th, 7)
      ctx.restore()

      const kx = wgt.value ? tx + tw - th / 2 : tx + th / 2
      const kr = th / 2 - 3.5
      shadow(ctx, () => { ctx.beginPath(); ctx.arc(kx, ty + th / 2, kr, 0, Math.PI * 2) }, 4, 3, 0.4)
      const kg = ctx.createLinearGradient(0, ty, 0, ty + th)
      kg.addColorStop(0, EDGE_LIT)
      kg.addColorStop(1, FACE_LOW)
      ctx.fillStyle = kg
      ctx.beginPath()
      ctx.arc(kx, ty + th / 2, kr + (hot ? 0.6 : 0), 0, Math.PI * 2)
      ctx.fill()
      break
    }

    case 'button': {
      shadow(ctx, () => rr(ctx, wgt.x, wgt.y, wgt.w, wgt.h, 11), down ? 5 : 9, down ? 3 : 7, 0.45)
      face(ctx, wgt.x, wgt.y + (down ? 1.5 : 0), wgt.w, wgt.h, 11, {
        pressed: down,
        warm: hot ? 1 : 0,
        seed: wgt.id.length * 37,
      })
      label(ctx, wgt.label, wgt.x + wgt.w / 2, wgt.y + wgt.h / 2 + 5 + (down ? 1.5 : 0), {
        size: 14,
        weight: 500,
        align: 'center',
      })
      break
    }
  }
}
