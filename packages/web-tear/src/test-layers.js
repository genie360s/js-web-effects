// Layer stacks for the two test pages: image.html and video.html.
//
// Each is one full-bleed piece of media on top of a plain floor, and nothing
// else. What the tear does to a photograph, and to video that keeps playing
// while it comes apart, is the only thing on screen.
import { FONT_STACK } from './font'
import photoUrl from '../../../test_assets/portrait.png'
import videoUrl from '../../../test_assets/elephant_video.mp4'

const BASE = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  .page { position: relative; width: 100%; height: 100%; overflow: hidden;
          font-family: ${FONT_STACK}; }
  .tag { position: absolute; left: 28px; top: 24px; display: flex; gap: 12px;
         align-items: baseline; text-shadow: 0 2px 12px rgba(0, 0, 0, .55); }
  .tag b { font-size: 26px; font-weight: 800; letter-spacing: -.03em; }
  .tag span { font-size: 12px; font-weight: 600;
              letter-spacing: .16em; text-transform: uppercase; opacity: .8; }
  /* a 100 px rule, so where the rip actually cut can be read off it */
  .grid { position: absolute; inset: 0; }
  .grid i { position: absolute; background: currentColor; opacity: .18; }
  /* the floor labels itself at the bottom, clear of the page in front of it */
  .floor-tag { top: auto; bottom: 24px; }
`

function grid(w, h) {
  const lines = []
  for (let x = 100; x < w; x += 100) lines.push(`<i style="left:${x}px;top:0;width:1px;height:100%"></i>`)
  for (let y = 100; y < h; y += 100) lines.push(`<i style="left:0;top:${y}px;width:100%;height:1px"></i>`)
  return `<div class="grid">${lines.join('')}</div>`
}

// The floor every test page hangs in front of: plain, and it never tears, so
// what you see through a hole is unmistakably the hole.
const floor = {
  name: 'floor',
  tearable: false,
  css: `${BASE}
    .page { background:
      repeating-linear-gradient(0deg, rgba(255,255,255,.06) 0 1px, transparent 1px 40px),
      repeating-linear-gradient(90deg, rgba(255,255,255,.06) 0 1px, transparent 1px 40px),
      #0b0b0b; color: #f2f2f0; }`,
  html: (w, h) => `
    ${grid(w, h)}
    <div class="tag floor-tag"><b>FLOOR</b><span>behind the tear &#183; does not tear</span></div>
  `,
}

const mediaPage = (name, item, label, tearable = true) => ({
  name,
  tearable,
  // the photograph has an alpha channel: without this the floor shows straight
  // through it and a tear is impossible to make out
  backdrop: '#f2f2f0',
  // `behind` puts the media under the page's own markup, so the labels and the
  // rule stay readable on top of a full-bleed photograph or video
  media: (w, h) => [{ ...item, x: 0, y: 0, w, h, behind: true }],
  css: `${BASE} .page { background: transparent; color: #ffffff; }`,
  html: (w, h) => `
    ${grid(w, h)}
    <div class="tag"><b>${name.toUpperCase()}</b><span>${label}</span></div>
  `,
})

const imagePage = (label) => mediaPage('image', { kind: 'image', src: photoUrl }, label)
const videoPage = (label) => mediaPage('video', { kind: 'video', src: videoUrl }, label)

export const imageLayers = [
  imagePage('1312 &#215; 1199 png &#183; grab it and pull'),
  floor,
]

export const videoLayers = [
  videoPage('1280 &#215; 720 h264 &#183; plays while it comes apart'),
  floor,
]

// Both, stacked: the photograph in front, the video playing behind it. Tear the
// photograph to reach the video, then tear the video too.
export const bothLayers = [
  imagePage('photograph in front &#183; tear it to reach the video'),
  videoPage('behind the photograph &#183; tear this one too'),
  floor,
]

// A page that only ever creases. Drag it, fold it, drape it, fling it: it
// stretches and springs back and it never gives.
export const untearableLayers = [
  mediaPage(
    'unbreakable',
    { kind: 'image', src: photoUrl },
    'drag and fold all you like &#183; this one cannot be torn',
    false,
  ),
  floor,
]

export const FLOOR_COLOR = '#0b0b0b'
