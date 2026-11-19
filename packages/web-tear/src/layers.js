// The pages web-tear hangs, in order, front to back.
//
// Each layer is real HTML and CSS. It gets rasterised once (SVG <foreignObject>
// -> canvas) and handed to the GPU as a sheet texture, so the thing you shred is
// an actual page. Media declared in `media` is composited into that texture, so
// photographs and video tear with the paper they sit on. Anything in
// `components` stays live DOM on top of the sheet and keeps working.
//
// Monochrome throughout: ink, paper, and the greys between them.
import { fontFaceCss, FONT_STACK } from './font'
import photoUrl from '../../../test_assets/portrait.png'
import reelUrl from '../../../test_assets/elephant_video.mp4'

const INK = '#0b0b0b'
const PAPER = '#f2f2f0'
const RADIUS = '4px'

const BASE = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  .page {
    position: relative; overflow: hidden; width: 100%; height: 100%;
    font-family: ${FONT_STACK};
    -webkit-font-smoothing: antialiased;
  }
  .center { position: absolute; inset: 0; display: flex; flex-direction: column;
            align-items: center; justify-content: center; text-align: center; }
  .display { font-weight: 800; letter-spacing: -0.04em; line-height: 0.92; }
  .rule { position: absolute; background: currentColor; opacity: .25; }
  .card { position: absolute; border-radius: ${RADIUS}; overflow: hidden; }
  .kicker { font-weight: 700; letter-spacing: .2em; text-transform: uppercase; }
`

export const layers = [
  {
    name: 'cover',
    media: (w, h) => [
      { kind: 'image', src: photoUrl, x: 0.06 * w, y: 0.5 * h, w: 0.2 * w, h: 0.36 * h, radius: 4 },
      { kind: 'video', src: reelUrl, x: 0.72 * w, y: 0.12 * h, w: 0.22 * w, h: 0.26 * h, radius: 4 },
    ],
    css: `
      .page { background: ${PAPER}; color: ${INK}; }
      .slab { position: absolute; background: ${INK}; border-radius: ${RADIUS}; }
      .outline { position: absolute; border: 1.5px solid ${INK}; border-radius: ${RADIUS}; }
      .grey { position: absolute; background: #c9c9c6; border-radius: ${RADIUS}; }
    `,
    html: (w, h, s) => `
      <div class="slab" style="left:${0.06 * w}px;top:${0.12 * h}px;width:${0.1 * w}px;height:${0.3 * h}px"></div>
      <div class="grey" style="left:${0.2 * w}px;top:${0.16 * h}px;width:${0.14 * w}px;height:${0.22 * h}px"></div>
      <div class="outline" style="left:${0.62 * w}px;top:${0.52 * h}px;width:${0.3 * w}px;height:${0.3 * h}px"></div>
      <div class="rule" style="left:${0.06 * w}px;top:${0.9 * h}px;width:${0.88 * w}px;height:1px"></div>
      <div class="kicker" style="position:absolute;left:${0.06 * w}px;top:${0.06 * h}px;font-size:${12 * s}px">
        web-tear &#183; tearable interfaces
      </div>
      <div class="center">
        <div class="display" style="font-size:${132 * s}px">WEB&#8209;TEAR</div>
        <div style="font-size:${19 * s}px;margin-top:${24 * s}px;font-weight:500;max-width:${0.5 * w}px">
          Every page here is cloth. Take hold of it and pull.
        </div>
      </div>
      <div class="kicker" style="position:absolute;right:${0.06 * w}px;bottom:${0.05 * h}px;font-size:${11 * s}px;opacity:.6">
        Alex Mkwizu
      </div>
    `,
    components: (w, h, s) => [
      { id: 'cover-cta', kind: 'button', label: 'Tear this button',
        x: 0.5 * w - 100 * s, y: 0.63 * h, w: 200 * s, h: 44 * s },
    ],
  },
  {
    name: 'controls',
    css: `
      .page { background: #1a1a1a; color: #f2f2f0; }
      .panel { position: absolute; background: #f2f2f0; color: ${INK};
               border-radius: ${RADIUS}; overflow: hidden; }
      .row { display: flex; align-items: center; justify-content: space-between; }
      .label { color: #6f6f6f; font-weight: 500; }
      .field { background: #fff; border: 1px solid #d8d8d6; border-radius: ${RADIUS};
               color: ${INK}; font-weight: 500; }
      .bar { background: #e2e2e0; border-radius: ${RADIUS}; overflow: hidden; }
      .bar > i { display: block; height: 100%; background: ${INK}; }
      .chart { display: flex; align-items: flex-end; gap: 6px; }
      .chart > i { display: block; background: ${INK}; border-radius: ${RADIUS} ${RADIUS} 0 0; }
    `,
    html: (w, h, s) => {
      const bars = [38, 62, 48, 80, 55, 92, 70, 44, 66, 86, 58, 74]
      return `
      <div class="kicker" style="position:absolute;left:${0.06 * w}px;top:${0.06 * h}px;font-size:${12 * s}px;opacity:.6">
        02 &#183; the controls still work
      </div>
      <div class="panel" style="left:${0.06 * w}px;top:${0.14 * h}px;width:${0.36 * w}px;height:${0.62 * h}px;padding:${26 * s}px">
        <div class="display" style="font-size:${26 * s}px">Settings</div>
        <div class="label" style="font-size:${13 * s}px;margin-top:${22 * s}px">Name</div>
        <div class="field" style="font-size:${15 * s}px;padding:${11 * s}px ${13 * s}px;margin-top:${7 * s}px">Alex Mkwizu</div>
        <div class="label" style="font-size:${13 * s}px;margin-top:${16 * s}px">Email</div>
        <div class="field" style="font-size:${15 * s}px;padding:${11 * s}px ${13 * s}px;margin-top:${7 * s}px">alexgmkwizu@gmail.com</div>
        <div class="label" style="font-size:${13 * s}px;margin-top:${20 * s}px">Tension</div>
        <div class="bar" style="width:100%;height:${6 * s}px;margin-top:${12 * s}px"><i style="width:68%"></i></div>
      </div>
      <div class="panel" style="left:${0.5 * w}px;top:${0.14 * h}px;width:${0.44 * w}px;height:${0.34 * h}px;padding:${26 * s}px">
        <div class="row">
          <div class="display" style="font-size:${22 * s}px">Tears per second</div>
          <div class="label" style="font-size:${13 * s}px">last 12 min</div>
        </div>
        <div class="chart" style="height:${0.18 * h}px;margin-top:${20 * s}px">
          ${bars.map(() => '').map((_, i) => `<i style="width:${(0.44 * w - 52 * s - 66) / 12}px;height:${bars[i]}%"></i>`).join('')}
        </div>
      </div>
      <div class="panel" style="left:${0.5 * w}px;top:${0.54 * h}px;width:${0.44 * w}px;height:${0.22 * h}px;padding:${26 * s}px">
        <div class="display" style="font-size:${20 * s}px">It keeps working while you rip it</div>
        <div class="label" style="font-size:${15 * s}px;margin-top:${10 * s}px">
          Hover the switches. Click them. Then tear the paper out from under them.
        </div>
      </div>
    `
    },
    components: (w, h, s) => [
      { id: 'grain', kind: 'toggle', label: 'Paper grain', on: true,
        x: 0.06 * w + 26 * s, y: 0.56 * h, w: 0.36 * w - 52 * s, h: 32 * s },
      { id: 'autosave', kind: 'toggle', label: 'Auto-save', on: false,
        x: 0.06 * w + 26 * s, y: 0.62 * h, w: 0.36 * w - 52 * s, h: 32 * s },
      { id: 'save', kind: 'button', label: 'Save changes',
        x: 0.06 * w + 26 * s, y: 0.68 * h, w: 0.18 * w, h: 42 * s },
    ],
  },
  {
    name: 'specimen',
    media: (w, h) => [
      { kind: 'video', src: reelUrl, x: 0.08 * w, y: 0.3 * h, w: 0.36 * w, h: 0.44 * h, radius: 4 },
    ],
    css: `
      .page { background: ${PAPER}; color: ${INK}; }
      .block { position: absolute; background: ${INK}; border-radius: ${RADIUS}; }
    `,
    html: (w, h, s) => `
      <div class="kicker" style="position:absolute;left:${0.08 * w}px;top:${0.08 * h}px;font-size:${12 * s}px;opacity:.6">
        03 &#183; specimen
      </div>
      <div class="block" style="left:${0.52 * w}px;top:${0.62 * h}px;width:${0.4 * w}px;height:${0.16 * h}px"></div>
      <div style="position:absolute;left:${0.52 * w}px;top:${0.24 * h}px;width:${0.4 * w}px">
        <div class="display" style="font-size:${92 * s}px">42dot<br/>Sans</div>
        <div style="font-size:${16 * s}px;margin-top:${20 * s}px;font-weight:500;line-height:1.5;color:#4a4a4a">
          Cloth simulation in wasm, off the main thread, one draw call a sheet.
          Ink on paper, nothing else.
        </div>
      </div>
      <div class="rule" style="left:${0.08 * w}px;top:${0.2 * h}px;width:${0.84 * w}px;height:1px"></div>
    `,
  },
  {
    name: 'floor',
    // The last page never gives. Pull it as hard as you like: it stretches,
    // creases and springs back, and that is all it will ever do.
    tearable: false,
    css: `
      .page { background:
        repeating-linear-gradient(0deg, rgba(255,255,255,.06) 0 1px, transparent 1px 40px),
        repeating-linear-gradient(90deg, rgba(255,255,255,.06) 0 1px, transparent 1px 40px),
        ${INK}; color: #f2f2f0; }
      .box { position: absolute; border: 1.5px dashed rgba(242,242,240,.4); border-radius: ${RADIUS}; }
    `,
    html: (w, h, s) => `
      <div class="box" style="left:${0.08 * w}px;top:${0.12 * h}px;width:${0.36 * w}px;height:${0.3 * h}px"></div>
      <div class="box" style="left:${0.56 * w}px;top:${0.12 * h}px;width:${0.36 * w}px;height:${0.66 * h}px"></div>
      <div class="box" style="left:${0.08 * w}px;top:${0.5 * h}px;width:${0.36 * w}px;height:${0.28 * h}px"></div>
      <div class="center">
        <div class="display" style="font-size:${72 * s}px">NOTHING<br/>LEFT TO TEAR</div>
        <div style="font-size:${15 * s}px;margin-top:${20 * s}px;font-weight:500;opacity:.7">
          And this one does not tear. Pull it and see.
        </div>
      </div>
    `,
  },
]

export const FLOOR_COLOR = '#0b0b0b'

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('could not load ' + src))
    img.src = src
  })
}

function loadVideo(src) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.src = src
    video.muted = true
    video.loop = true
    video.playsInline = true
    video.crossOrigin = 'anonymous'
    video.oncanplay = () => resolve(video)
    video.onerror = () => reject(new Error('could not load ' + src))
    video.load()
  })
}

function roundedPath(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

// Draws a media item into the layer canvas, cropped to fill its rect. Media is
// desaturated: web-tear is monochrome, and a colour photograph in the middle of
// it would be the only thing anyone looked at.
function paintMedia(ctx, source, item, dpr) {
  const x = item.x * dpr, y = item.y * dpr, w = item.w * dpr, h = item.h * dpr
  const sw = source.videoWidth || source.naturalWidth || source.width
  const sh = source.videoHeight || source.naturalHeight || source.height
  if (!sw || !sh) return
  const scale = Math.max(w / sw, h / sh)
  const dw = sw * scale, dh = sh * scale
  ctx.save()
  roundedPath(ctx, x, y, w, h, (item.radius || 0) * dpr)
  ctx.clip()
  ctx.filter = 'grayscale(1) contrast(1.05)'
  ctx.drawImage(source, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh)
  ctx.restore()
}

// HTML (+ images and video) -> a canvas the GPU can take as the sheet texture.
// Video items keep their element and device-pixel rect so the renderer can push
// each new frame into that part of the texture while the sheet is alive.
export async function rasterize(layer, w, h, dpr) {
  const s = Math.min(w, h) / 820
  const font = await fontFaceCss()
  const doc = `<div xmlns="http://www.w3.org/1999/xhtml" class="page">` +
    `<style>${font}${BASE}${layer.css}</style>${layer.html(w, h, s)}</div>`
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(w * dpr)}" height="${Math.round(h * dpr)}" viewBox="0 0 ${w} ${h}">` +
    `<foreignObject x="0" y="0" width="${w}" height="${h}">${doc}</foreignObject></svg>`

  const img = new Image()
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  await img.decode()

  const items = layer.media ? layer.media(w, h, s) : []
  if (!items.length) return { source: img, videos: [] }

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  const ctx = canvas.getContext('2d')
  if (layer.backdrop) {
    ctx.fillStyle = layer.backdrop
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }

  const videos = []
  // `behind: true` puts a media item under the page's own markup, which is how
  // a full-bleed photo can still have readable labels on top of it.
  const paint = async (item) => {
    try {
      if (item.kind === 'video') {
        const video = await loadVideo(item.src)
        await video.play().catch(() => {}) // autoplay may be refused; still tearable
        paintMedia(ctx, video, item, dpr)
        videos.push({
          video,
          x: Math.round(item.x * dpr),
          y: Math.round(item.y * dpr),
          w: Math.round(item.w * dpr),
          h: Math.round(item.h * dpr),
          radius: (item.radius || 0) * dpr,
          // Media drawn under the page's markup has to put that markup back
          // after each new frame, or the upload wipes the labels off it.
          overlay: item.behind ? img : null,
          backdrop: item.behind ? layer.backdrop : null,
          pageWidth: canvas.width,
          pageHeight: canvas.height,
        })
      } else {
        paintMedia(ctx, await loadImage(item.src), item, dpr)
      }
    } catch (err) {
      // a missing asset must not take the page down with it
      console.warn(err.message)
    }
  }

  await Promise.all(items.filter((i) => i.behind).map(paint))
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  await Promise.all(items.filter((i) => !i.behind).map(paint))

  return { source: canvas, videos }
}
