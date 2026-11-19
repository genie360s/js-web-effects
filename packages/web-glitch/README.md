# web glitch

A controlled glitch for the web. A picture arrives in blocks: rectangles of
one, two, four and eight cells that find the subject, follow its silhouette,
and bring it in before the background. Blocks that have just landed are
unsettled for a moment — one drops out, one goes to coarse pixels, one shows
the picture from a few cells sideways, one carries a four-digit number beside
it. Now and then, or on a click, the whole subject flicks through a fixed
sequence of other renderings — dots, a grey mosaic, a white mask with
hairlines, fragments — and lets go.

It works over whatever the page actually contains: a photograph, a playing
video, live text, a login form that keeps working underneath. The blocks are
decided by a small solver written in Rust and compiled to WebAssembly, and
drawn in WebGL2.

[Live demo](https://genie360s.github.io/js-web-effects/web-glitch/) · [How it works, on video](https://genie360s.github.io/js-web-effects/#web-glitch)

## Install

```bash
npm install web-glitch
```

```vue
<script setup>
import { GlitchSurface } from 'web-glitch'
import 'web-glitch/style.css'
</script>

<template>
  <GlitchSurface :options="{ cutout: true }" :visible="show">
    <img src="/portrait.png" alt="A portrait" />
  </GlitchSurface>
</template>
```

Vue 3 is a peer dependency. Without Vue, `createGlitch(element, options)` from
the same package returns the engine the component drives:

```js
import { createGlitch } from 'web-glitch'

const glitch = await createGlitch(document.querySelector('h1'), { cell: 8 })
glitch.burst()
```

The element needs a positioned ancestor; the engine lays a canvas exactly over
it as its next sibling.

## Running the demo

From this folder, in a clone of [js-web-effects](https://github.com/genie360s/js-web-effects):

```bash
npm install
npm run dev
```

## The pages

**home** (`#/`) — a portrait, a headline and a paragraph, each its own
surface, with every dial on a slider. The five renderings, four presets
(quiet, titles, storm, bloom), cutout, reseed.

**image, video, text, styles, login** — one page per thing the glitch can sit
over. *styles* is the same picture resting in each of the five renderings.

## What it does

The surface is a grid of cells, 14 CSS pixels by default. Three things happen
to it.

**The subject is found.** The picture is read back from the GPU at two probes
a cell. If it has transparency, the subject is whatever is opaque — which for
text is the letters themselves. If it is opaque all over, the background is
taken to be the colour most of the border is, and the subject is whatever is
far enough from it. `key: 'none'` skips this and treats the whole box as
subject; `key: '#0b0b0b'` names the background.

**The grid is cut and queued.** A quadtree cuts it into blocks. A block the
subject's edge runs through always splits, so the silhouette is drawn fine;
one that is all subject or all background splits by lottery, so the inside
stays coarse. Each block then gets a place in a queue: distance through the
subject from a handful of seeds, plus a little noise, so the picture grows
along its own shape instead of raining in. The subject fills the first 85% of
the queue and the background the rest, which is why `reveal(0.85)` stops with
the subject standing on nothing.

**A state machine runs over it.** `progress` moves along the queue at
`speed`. A block that has just arrived flashes and is unsettled; at rest a
share of them (`glitch`) still misbehave, each re-rolling on its own clock
every `hold` seconds. The pointer unsettles the blocks around it. A *burst*
replaces the whole subject with the next rendering in a fixed sequence every
`switch` seconds for `burstLength` seconds.

For each cell the solver hands the shader four bytes — what to draw, the
block's size, and a random byte the block shares — and one byte of glow,
already blurred. The same seed cuts the same blocks and replays the same
sequence.

## The component

```vue
<GlitchSurface :options="options" :visible="true" @ready="onReady" @error="onError">
  anything
</GlitchSurface>
```

- `options` — anything under [The dials](#the-dials). Watched deeply; changes
  take effect at once.
- `visible` — whether the content should be there. It arrives and leaves at
  `speed`, and a surface that is off the screen waits until it is scrolled to.
- `@ready` hands you the engine; `@error` fires if there is no WebGL2 or the
  wasm cannot load, in which case the content simply shows as it is.

A single `<img>`, `<video>` or `<canvas>` in the slot is handed straight to
the GPU. Anything else is rasterised from the DOM, and rasterised again when
it changes: on a mutation, on typing, on focus, on resize.

The engine, from `@ready`, a template ref's `.engine`, or `createGlitch`:

| | |
| --- | --- |
| `reveal(amount = 1)` | bring it in, all or part |
| `hide()` | take it out |
| `burst(strength = 1)` | flick through the sequence; strength scales how long |
| `pulse({ clientX, clientY, radius?, strength? })` | unsettle the blocks around a point |
| `reseed(seed)` | re-cut the blocks |
| `setParams(patch)` | any dial |
| `update()` | read the element again — a canvas you drew on |
| `progress`, `grid` | where it has got to, and the grid it is on |
| `destroy()` | remove the canvas and put the element back |

## The dials

| option | default | |
| --- | --- | --- |
| `cell` | 14 | CSS px — the smallest block |
| `seed` | 1 | the same seed replays the same blocks |
| `style` | `'image'` | resting rendering: `image`, `dots`, `mosaic`, `mask`, `ascii` |
| `key` | `'auto'` | how the subject is found: `auto`, `alpha`, `none`, or a hex colour |
| `tolerance` | 0.14 | how far from the key colour still counts as background |
| `cutout` | `false` | leave a keyed background out for good |
| `speed` | 0.7 | progress per second: a reveal takes 1/speed seconds |
| `glitch` | 0.04 | share of blocks misbehaving at rest; 0 is a still picture |
| `hold` | 0.16 | s a block keeps its misbehaviour |
| `hole`, `pixel`, `shift` | 1, 1, 0.6 | weights of dropping out, coarse pixels, a sideways copy |
| `burstRate` | 0.1 | bursts per second, on its own |
| `burstLength` | 0.6 | s a burst lasts |
| `switch` | 0.09 | s a burst holds each rendering |
| `labels` | 0.2 | share of blocks beside the subject that carry a number |
| `glow`, `glowDecay` | 1, 3 | flash as a block arrives, and 1/s it fades |
| `threshold` | 0.12 | how much subject a cell needs to count |
| `split` | 0.45 | how finely the inside of the subject is cut |
| `dots` | 0.5 | share of subject cells that get a dot |
| `interactive` | `true` | whether the pointer does anything |
| `pointer`, `pointerGain` | 60, 1.2 | radius in CSS px, and strength, of a stroke |
| `clickBurst` | 1 | strength of the burst a click sets off; 0 for none |
| `decay`, `exciteGain` | 3, 0.5 | 1/s a stroke fades, and misbehaviour per unit of it |
| `ink`, `glowColor` | `#ffffff`, `#bfe6ff` | dots, masks, hairlines, characters, numbers; the bloom |
| `capture` | — | your own rasteriser for DOM content |

## Running it

```bash
npm run wasm    # build the Rust core to src/sim/glitch-core.wasm
npm test        # cargo tests, then wasm/test.mjs against the built wasm
npm run build   # the demo site -> dist/
npm run build:lib   # what npm ships -> lib/
```

## How it fits together

```
wasm/src/lib.rs          the solver: quadtree, queue, state machine, glow
src/sim/params.js        its tunables by name; the same table as lib.rs
src/engine.js            one element, one canvas over it, the frame loop
src/render/              the WebGL2 renderer and its one shader
src/ui/capture.js        rasterising live DOM
src/components/          GlitchSurface.vue
src/pages/               the demo
```

A step of a 160×90 grid takes about 0.2 ms, so the solver runs on the main
thread, 30 times a second. The frame loop stops when there is nothing to draw:
while the element is off the screen, while the tab is hidden, and once the
picture is whole and still — at which point the canvas steps aside and the
real element shows itself again.

## Deliberate limits

- It flashes. With `prefers-reduced-motion: reduce` there is no glitch at
  all: the canvas stays out of it and `visible` simply shows or hides the
  element. Keep `burstRate` low over large bright pictures regardless.
- One surface is one element and one WebGL context. A page of dozens wants a
  shared context, which this does not have.
- A transform on the element itself is not followed; put it on a wrapper.
- A `<canvas>` is read when it is added and on `update()`, not every frame.
- `::before` / `::after` content, cross-origin fonts and images without CORS
  headers, and iframes do not make it into a DOM capture. Pass your own
  `capture` function if you need them.

## Controls

- **move** — unsettle the blocks under the pointer
- **click** — a burst
- **replay**, **hide / reveal**, **burst** — from the buttons
- **h** — hide the panel (home)

MIT.
