// 42dot Sans, used by the whole of web-tear.
//
// The DOM gets it from style.css. Sheet textures cannot: they are rasterised
// through an SVG <foreignObject>, which will not fetch anything, so the font
// has to travel inside the markup as a data URI. Fetched and encoded once.
import fontUrl from './assets/42dot-sans.woff2?url'

let embedded = null

export function fontFaceCss() {
  if (!embedded) {
    embedded = fetch(fontUrl)
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        let binary = ''
        const bytes = new Uint8Array(buf)
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
        const base64 = btoa(binary)
        return `@font-face {
          font-family: '42dot Sans';
          font-style: normal;
          font-weight: 300 800;
          src: url(data:font/woff2;base64,${base64}) format('woff2');
        }`
      })
      .catch(() => '') // no font is better than no page
  }
  return embedded
}

export const FONT_STACK = `'42dot Sans', system-ui, sans-serif`
