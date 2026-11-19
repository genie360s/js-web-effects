# web-sand

Beach sand for the web. Move the cursor and the grains under it are pushed
aside, piled along the rim of the groove, and left to slump until nothing
stands steeper than sand can stand — like running a stick through sand.

The sand under the stick travels with it, so whatever is already written in the
beach is dragged along and broken up as you cross it — a stroke wrecks the
marks it passes through instead of laying a clean groove over the top of them.
Drag faster and the spoil is thrown ahead of the stick instead of evenly to
both sides. Hold the button down and it presses in deeper, until the walls
slump back at the angle of repose, the way a hole in dry sand does. The cut is
roughened cell by cell, so its edge crumbles rather than looking cast. Make the
stick as fine as you like: below the width of a cell it cuts a fainter mark
rather than disappearing.

Everything on the page is drawn on that surface. Text, components, images and
playing video all sit on the sand, take its light, slide when the sand under
them moves, and disappear under the sand pushed over them. Stir through any of
it and its colour lifts off into the grains and smears along wherever you drag
it.

The grain simulation is our own, written in Rust and compiled to wasm: 22 KB,
no bindgen, no glue. Rendering is one WebGL2 context, one draw call for the
beach and one per content layer.

[Live demo](https://genie360s.github.io/js-web-effects/web-sand/) · [How it works, on video](https://genie360s.github.io/js-web-effects/#web-sand)

## Install

```bash
npm install web-sand
```

```js
import { SandSurface, SandDistort } from 'web-sand'
import 'web-sand/style.css'
```

Vue 3 is a peer dependency. The components are described under [Using it](#using-it). Without Vue, `createSand(element, options)` from the same package returns the engine they drive, with its wasm already wired.

## Running the demo

From this folder, in a clone of [js-web-effects](https://github.com/genie360s/js-web-effects):

```bash
npm install
npm run dev      # builds the wasm first, then serves on :5173
npm run build    # dist/
npm run check    # cargo tests, then the field self-check against the real wasm
```

Pages, all served by the same dev server:

One screen of beach per page. Nothing scrolls: a surface pinned to the viewport
would sit still while the page slid across it, so each thing gets its own page
and its own patch of sand.

| page | what it is for |
| --- | --- |
| `index.html` | the hero, and the way in to the rest |
| `text.html` | live DOM only: a heading, a paragraph with a link, a card |
| `text-distortion.html` | how far the sand bends what lies on it, on a slider — text, a component, a photograph and a playing video together |
| `login.html` | a working login card — type in it, tick the box, then drag through it |
| `colour.html` | four coloured components to stir the colour out of |
| `image.html` | one photograph, from `test_assets/` |
| `video.html` | one playing video, from `test_assets/` |

For a page that does scroll, give each section its own contained surface —
`<SandSurface :fullscreen="false">` around the section — so the sand scrolls
with the content and every section arrives as fresh beach.

## Using it

```vue
<SandSurface :options="{ radius: 10, depth: 0.85 }">
  <main>
    <SandDistort><h1>This gets dragged through the sand</h1></SandDistort>
    <SandDistort><img src="/photo.jpg" alt="" /></SandDistort>
    <SandDistort :bury="1.6"><video src="/reel.mp4" autoplay muted loop /></SandDistort>
  </main>
</SandSurface>
```

`SandSurface` pins a canvas behind the page and owns the simulation.
`SandDistort` hands what is inside it to that canvas: an `<img>`, `<video>` or
`<canvas>` goes to the GPU directly, anything else is rasterised from the live
DOM. The real element stays in the document with its layout, its links and its
screen-reader text intact, and only goes transparent once the GPU is actually
drawing it — so a browser without WebGL2 shows the ordinary page.

Without Vue, `createSand(container)` from the package gives you the same
thing (in this repo, `createSand(container, { wasm })` from `src/engine.js`): `addLayer(el, options)`, `setParams(patch)`, `reset()`,
`destroy()`.

## Knobs

Defaults live in `DEFAULTS` in `src/engine.js`; pass any of them to
`<SandSurface :options>` or `setParams`. The ones worth reaching for:

| | |
| --- | --- |
| `radius`, `depth` | the stick: how wide it is in css pixels, how deep it presses |
| `dwell`, `dwellCap` | how much deeper each second of holding it still presses, and when that stops |
| `drag` | how much of the sand under the stick is carried along with it — what wrecks the marks you cross. `0` leaves them untouched |
| `repose` | steepest slope sand will hold before it slumps |
| `recovery` | wind, per second. `0` by default: marks stay until you smooth them over. Above zero the beach heals itself — taking the stirred colour with it — and redraws every frame until it has |
| `driftDecay` | how quickly the stirring dies away after the stick has gone |
| `rippleScale`, `rippleAmp`, `dunes` | the standing beach: ripple size, height, and the slow undulation under them |
| `displace` | how far content slides down the slope of sand you have moved |
| `warp` | how far the standing ripples bend content, before you touch anything. `0` by default; `text-distortion.html` puts it on a slider |
| `shade`, `stain`, `bury` | what else the sand does to content: lighting, discolouring, burial |
| `pickup`, `pigment`, `spread`, `scrape` | stirring: how readily colour lifts off content, how strongly it shows in the sand, how much it blends as it goes, and how much the content loses in the process |
| `sandLight`, `sandDark`, `sandDamp`, `light` | the colour of the beach, as `#rrggbb`, and the direction the sun comes from |
| `sparkle`, `exposure`, `heightScale`, `reliefAmp` | how bright the grains glint, overall exposure, and how strongly the two height sources read |
| `grid`, `maxDpr`, `auto` | how much machine to spend |

`SandDistort` takes `displace`, `warp`, `shade`, `stain`, `bury`, `scrape` per
layer — so a heading can be bent hard while its caption stays readable — plus
`live` (poll a `<canvas>` every frame), `capture` (your own rasteriser) and
`disabled`. Its `update()` re-rasterises on demand, for changes a
MutationObserver cannot see.

Real hardware never matches the model, and sand least of all: every one of
these is meant to be turned. Press `tune` on the front page to do it live.

## What it costs

Measured on an M4 at 1280x800:

- wasm step: one ordinary stroke settles over 151 frames for **4 ms of total
  CPU**, because the working rectangle follows the moving sand instead of only
  growing. Worst case, with a 256x144 grid entirely in motion every frame, is
  0.93 ms per step. A pointer event, including hauling the sand it crosses,
  costs 4.8 µs. State is about 1 MB.
- draw: under 0.01 ms per frame for the beach and every layer on it (measured
  with fourteen at once).
- the standing beach is baked to a texture once per resize: 0.1 ms.
- stirring runs at twice the simulation grid and only while sand is moving.
- 22 KB of wasm, gzipped to 10 KB.

It also stops. Once the sand settles the loop cancels itself and the page
holds no rAF callback at all; it restarts on the next pointer move, scroll,
resize or video frame. A surface scrolled out of view, or a hidden tab, is not
drawn. Only the rectangle the simulation reports as changed is uploaded, and a
video is uploaded only when a new frame actually arrives.

On a device reporting 4 GB or fewer, or 4 cores or fewer, the grid, the pixel
ratio and the relief texture all drop automatically (`auto: false` to stop it).
Under `prefers-reduced-motion: reduce` the sand still responds but content
stops sliding.

## How it works

`wasm/src/lib.rs` — the field. A stroke cuts a capsule-shaped groove, measures
exactly what it removed, and gives all of it back to the rim, so sand is
conserved; then every slope steeper than the angle of repose topples until it
is not. Before it cuts, it hauls: every cell in its path gives a share of what
it is holding to the cells a little further along the stroke, which is what
drags the writing you cross out of shape. How fast the stick is travelling does
not change how much sand moves, only where it lands — forward, into a bow wave
— and it leaves a drift vector behind, which is what colour is carried along. Work is confined to a rectangle
that follows the moving sand, and the whole thing reports when it has stopped.
Height, disturbance and drift are packed to half floats for the GPU.

`src/sim.js` — loads that module and hands back a field. No bindgen: the
exports are plain C ABI and the texels are read straight out of linear memory.

`src/gl.js` — the GLSL and the plumbing. Note the two fullscreen vertex
shaders: the canvas puts clip-space +1 at the top, a framebuffer puts texel row
0 at clip-space -1, so a pass that renders into a texture needs the other one
or its output is stored upside-down relative to every later read. Four programs share one description of
the surface: `bake` turns the analytic beach (asymmetric wind ripples that
meander and come in patches, a second set crossing them, shell grit) into a
texture once per resize; `sand` shades it; `layer` paints content onto it; and
`pigment` does the stirring — the page is flattened into a small texture, and
colour is lifted off it wherever sand was turned, then carried along the drift
a step per frame and left on the grains.

`src/capture.js` — rasterises live DOM through an SVG `<foreignObject>`, with
web fonts and nested images inlined because an SVG rendered as an image cannot
fetch anything. It must be a `data:` URL: Chrome treats an SVG image from a
`blob:` URL as not origin-clean and WebGL then refuses to upload it. Going via
a 2D canvas does not help — it taints the same way.

`src/engine.js` — the context, the frame loop, layers, and the pointer.

Forms keep working under the sand. The real inputs are still in the page, so
they take focus, typing and clicks as usual, and every keystroke, tick and
focus ring is re-rasterised onto the surface — `login.html` is that, dragged
through. A password renders as its dots, never its characters.

Web fonts, nested images and `background-image` urls are fetched and inlined,
since the SVG cannot fetch them itself. A `<video>` nested inside captured DOM
becomes the frame it was showing; a video handed straight to `<SandDistort>`
keeps playing under the sand, uploaded only when a new frame arrives.

### Limits

`::before`/`::after` content is not reproduced in captured DOM, cross-origin
fonts and images without CORS headers are skipped, and iframes render blank.
A text caret is not drawn, and a line of text can re-wrap by a pixel in the
rasterised copy, so a label that only just fits may want `white-space: nowrap`.
Pass your own rasteriser as `:capture` if you need them. Resizing the window
reallocates the field, so whatever was drawn on it is lost. Losing the WebGL
context does not: the field lives in wasm memory and re-uploads itself.

## License

MIT, Alex Mkwizu <alexgmkwizu@gmail.com>
