/**
 * Rasterises a live DOM subtree so it can be handed to the GPU as something
 * that can be tiled.
 *
 * The browser will not hand you pixels for arbitrary DOM, so the standard
 * route is taken: clone the subtree, copy the computed styles the clone will
 * not inherit, wrap it in an SVG `<foreignObject>`, and let the image decoder
 * do the rasterising. Everything an isolated SVG cannot reach — web fonts,
 * nested images, canvases — is inlined first.
 *
 * Known limits, in exchange for zero dependencies:
 *   - `::before` / `::after` content is not reproduced.
 *   - Cross-origin fonts and images without CORS headers are skipped.
 *   - Iframes and plugin content render blank.
 * Pass your own `capture` function (e.g. html2canvas) if you need those.
 *
 * Copyright (c) 2026 Alex Mkwizu <alexgmkwizu@gmail.com> — MIT.
 */

/** Computed properties worth carrying to the clone. Copying all ~350 would
 *  multiply the SVG size by an order of magnitude for no visual gain. */
const STYLE_PROPS = [
  'display', 'position', 'top', 'right', 'bottom', 'left', 'float', 'clear',
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'box-sizing', 'overflow', 'visibility', 'opacity', 'z-index',
  'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis',
  'justify-content', 'align-items', 'align-self', 'align-content', 'gap',
  'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row',
  'color', 'background-color', 'background-image', 'background-size',
  'background-position', 'background-repeat', 'background-clip',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-top-left-radius', 'border-top-right-radius',
  'border-bottom-left-radius', 'border-bottom-right-radius',
  'box-shadow', 'outline', 'filter', 'mix-blend-mode',
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
  'font-stretch', 'line-height', 'letter-spacing', 'word-spacing',
  'text-align', 'text-transform', 'text-decoration', 'text-indent',
  'text-shadow', 'white-space', 'word-break', 'overflow-wrap', 'direction',
  'vertical-align', 'list-style', 'transform', 'transform-origin',
  '-webkit-text-fill-color', '-webkit-background-clip'
]

/** Elements the GPU can read straight from the DOM, once they hold pixels. */
export function isMedia(el) {
  return el instanceof HTMLImageElement
    || el instanceof HTMLVideoElement
    || el instanceof HTMLCanvasElement
}

/** The same elements, but only once there is actually something to read. */
export function directSource(el) {
  if (el instanceof HTMLImageElement) return el.complete && el.naturalWidth > 0 ? el : null
  if (el instanceof HTMLVideoElement) return el
  if (el instanceof HTMLCanvasElement) return el
  return null
}

export function isLiveSource(el) {
  return el instanceof HTMLVideoElement || el instanceof HTMLCanvasElement
}

const dataUriCache = new Map()
let fontCssPromise = null

async function toDataUri(url) {
  if (dataUriCache.has(url)) return dataUriCache.get(url)
  const pending = (async () => {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' })
    if (!res.ok) throw new Error(`${res.status} for ${url}`)
    const blob = await res.blob()
    return await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(blob)
    })
  })().catch(() => {
    // A failure here is usually transient. Caching it would drop that font or
    // image from every later capture for the life of the document.
    dataUriCache.delete(url)
    return null
  })
  dataUriCache.set(url, pending)
  return pending
}

/**
 * An SVG rendered as an image cannot fetch anything, so every @font-face the
 * page uses has to travel with it. Result is cached: this runs once per page.
 */
function collectFontCss() {
  fontCssPromise = fontCssPromise || buildFontCss()
  return fontCssPromise
}

async function buildFontCss() {
  const rules = []
  for (const sheet of Array.from(document.styleSheets)) {
    let cssRules
    try {
      cssRules = sheet.cssRules
    } catch {
      continue // cross-origin stylesheet, not readable by design
    }
    for (const rule of Array.from(cssRules || [])) {
      if (rule.type === CSSRule.FONT_FACE_RULE) rules.push(rule)
    }
  }
  const out = await Promise.all(rules.map(async (rule) => {
    const src = rule.style.getPropertyValue('src')
    const match = /url\(["']?([^"')]+)["']?\)/.exec(src)
    if (!match) return ''
    const uri = await toDataUri(new URL(match[1], document.baseURI).href)
    if (!uri) return ''
    return `@font-face{font-family:${rule.style.getPropertyValue('font-family')};`
      + `font-weight:${rule.style.getPropertyValue('font-weight') || 'normal'};`
      + `font-style:${rule.style.getPropertyValue('font-style') || 'normal'};`
      + `src:url("${uri}")}`
  }))
  return out.join('')
}

function copyComputedStyle(from, to) {
  const computed = getComputedStyle(from)
  let css = ''
  for (const prop of STYLE_PROPS) {
    const value = computed.getPropertyValue(prop)
    if (value) css += `${prop}:${value};`
  }
  to.setAttribute('style', css)
}

/**
 * Replace anything the isolated SVG cannot load with inline data.
 *
 * `live` maps each node in the clone back to the one still in the document,
 * because a cloned `<canvas>` carries no bitmap and a cloned `<video>` carries
 * no media: the pixels have to be read off the originals.
 */
async function inlineResources(clone, live) {
  const jobs = [
    ...inlineImages(clone),
    ...inlineBackgrounds(clone),
  ]
  inlineCanvases(clone, live)
  inlineVideos(clone, live)
  await Promise.all(jobs)
}

/**
 * What someone has typed lives in the `value` property, which `cloneNode` does
 * not copy — it only carries the attribute the markup was written with. A form
 * that is tiled would otherwise always rasterise empty.
 */
function mirrorFormState(clone, live) {
  for (const node of Array.from(clone.querySelectorAll('input, textarea, select'))) {
    const original = live.get(node)
    if (original) mirrorField(node, original)
  }
}

function mirrorField(node, original) {
  if (node instanceof HTMLSelectElement) {
    // Selectedness takes the last `selected` in the markup, so whatever the
    // clone inherited has to go before the real choice is marked.
    for (const option of Array.from(node.options)) option.removeAttribute('selected')
    const chosen = node.options[original.selectedIndex]
    if (chosen) chosen.setAttribute('selected', 'selected')
    return
  }
  if (node instanceof HTMLTextAreaElement) {
    node.textContent = original.value
    return
  }
  if (original.type === 'checkbox' || original.type === 'radio') {
    if (original.checked) node.setAttribute('checked', 'checked')
    else node.removeAttribute('checked')
    return
  }
  if (original.type === 'password') {
    // A password field shows its dots, never its contents.
    node.setAttribute('value', '\u2022'.repeat(original.value.length))
    node.setAttribute('type', 'text')
    return
  }
  node.setAttribute('value', original.value)
}

// The root is not in querySelectorAll('*'), and it is very often the element
// carrying the background.
const selfAndDescendants = (node) => [node, ...node.querySelectorAll('*')]

function inlineImages(clone) {
  const jobs = []
  for (const img of selfAndDescendants(clone).filter((n) => n.tagName === 'IMG')) {
    const src = img.getAttribute('src')
    if (!src || src.startsWith('data:')) continue
    jobs.push(toDataUri(new URL(src, document.baseURI).href).then((uri) => {
      if (uri) img.setAttribute('src', uri)
      else img.remove()
    }))
  }
  return jobs
}

function inlineBackgrounds(clone) {
  const jobs = []
  for (const node of selfAndDescendants(clone)) {
    const match = /url\(["']?([^"')]+)["']?\)/.exec(node.style.backgroundImage || '')
    if (!match || match[1].startsWith('data:')) continue
    jobs.push(toDataUri(new URL(match[1], document.baseURI).href).then((uri) => {
      node.style.backgroundImage = uri ? `url("${uri}")` : 'none'
    }))
  }
  return jobs
}

function inlineCanvases(clone, live) {
  for (const canvas of Array.from(clone.querySelectorAll('canvas'))) {
    const original = live.get(canvas)
    if (original) replaceWithSnapshot(canvas, original)
    else canvas.remove()
  }
}

// A video nested inside captured DOM becomes the frame it is showing. Only a
// video handed straight to <TileLayer> keeps playing under the tiles.
function inlineVideos(clone, live) {
  for (const video of Array.from(clone.querySelectorAll('video'))) {
    const original = live.get(video)
    const box = original ? original.getBoundingClientRect() : null
    if (!box || !box.width || !box.height) {
      video.remove()
      continue
    }
    const frame = document.createElement('canvas')
    frame.width = original.videoWidth || Math.ceil(box.width)
    frame.height = original.videoHeight || Math.ceil(box.height)
    try {
      frame.getContext('2d').drawImage(original, 0, 0, frame.width, frame.height)
      replaceWithSnapshot(video, frame)
    } catch {
      video.remove() // cross-origin media; nothing we can legally read
    }
  }
}

// Swap a live element for a still picture of `pixels`, keeping its box.
function replaceWithSnapshot(node, pixels) {
  const img = document.createElement('img')
  img.setAttribute('style', node.getAttribute('style') || '')
  try {
    img.setAttribute('src', pixels.toDataURL())
    node.replaceWith(img)
  } catch {
    node.remove() // tainted by cross-origin content; nothing we can legally read
  }
}

/**
 * @param {HTMLElement} el      element to rasterise
 * @param {number} dpr          device pixels per CSS pixel
 * @param {{width:number,height:number}} size  CSS-pixel box to render
 * @returns {Promise<HTMLImageElement|null>}
 */
export async function captureElement(el, dpr, size) {
  const width = Math.ceil(size.width)
  const height = Math.ceil(size.height)
  if (width < 1 || height < 1) return null

  const clone = el.cloneNode(true)
  const sources = [el, ...el.querySelectorAll('*')]
  const targets = [clone, ...clone.querySelectorAll('*')]
  const live = new Map()
  for (let i = 0; i < sources.length && i < targets.length; i++) {
    copyComputedStyle(sources[i], targets[i])
    live.set(targets[i], sources[i])
  }
  // The live element is transparent (the GPU draws it instead) and may be
  // positioned or transformed; the clone has to be plain, opaque and at origin.
  clone.style.cssText += ';opacity:1;visibility:visible;position:static;'
    + `margin:0;transform:none;width:${width}px;height:${height}px;`

  mirrorFormState(clone, live)
  await inlineResources(clone, live)
  const css = await collectFontCss()

  // The viewBox does the scaling, so the SVG rasterises straight to device
  // pixels and the result is sharp on a retina screen.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width * dpr)}"`
    + ` height="${Math.round(height * dpr)}" viewBox="0 0 ${width} ${height}">`
    + (css ? `<defs><style type="text/css">${escapeCss(css)}</style></defs>` : '')
    + '<foreignObject x="0" y="0" width="100%" height="100%">'
    + `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${width}px;height:${height}px">`
    + new XMLSerializer().serializeToString(clone)
    + '</div></foreignObject></svg>'

  const image = new Image()
  // A data: URL and not a blob: one. Chrome treats an SVG image from a blob URL
  // as not origin-clean, and WebGL then refuses to upload it; a data URL is
  // accepted. Going via a 2D canvas does not help: it taints the same way.
  image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  await image.decode()
  return image
}

function escapeCss(css) {
  return css.replace(/]]>/g, ']]&gt;').replace(/</g, '&lt;')
}
