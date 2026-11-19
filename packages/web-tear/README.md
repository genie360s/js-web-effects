# web-tear

Tearable interfaces. Full-screen sheets of "paper" you take hold of and pull
until they rip, with the next page waiting underneath — after
[pushmatrix/tearable](https://pushmatrix.github.io/tearable/).

Monochrome throughout, set in 42dot Sans, 4 px corners on everything.

The cloth simulation is our own, written in Rust, compiled to wasm, and run in
a Web Worker. Nothing simulates on the main thread. The pages carry real
images, playing video and working controls, and all of it tears.

[Live demo](https://genie360s.github.io/js-web-effects/web-tear/) · [How it works, on video](https://genie360s.github.io/js-web-effects/#web-tear)

## Install

```bash
npm install web-tear
```

```vue
<script setup>
import { TearableCloth } from 'web-tear'
import 'web-tear/style.css'

// front to back; the last one is the floor and never tears
const layers = [
  {
    name: 'cover',
    css: '.page { background: #f2f2f0; color: #0b0b0b }',
    html: (w, h, s) => `<h1 style="font-size:${96 * s}px">Tear me</h1>`,
  },
  {
    name: 'floor',
    tearable: false,
    css: '.page { background: #0b0b0b; color: #f2f2f0 }',
    html: (w, h, s) => `<h1 style="font-size:${64 * s}px">Underneath</h1>`,
  },
]
</script>

<template>
  <TearableCloth :layers="layers" />
</template>
```

Vue 3 is a peer dependency. `layers` is required: each one is `{ name, css, html(w, h, scale) }`, optionally with `media` and `tearable: false`. [`src/layers.js`](src/layers.js) is the demo's own stack and shows everything a layer can carry.

## Running the demo

From this folder, in a clone of [js-web-effects](https://github.com/genie360s/js-web-effects):

```bash
npm install
npm run dev      # builds the wasm first, then serves on :5173
npm run build    # dist/
npm run check    # sim self-check against the real wasm module (node)
```

Pages, all served by the same dev server:

| page | what it is for |
| --- | --- |
| `/` | the site: four stacked pages with type, controls, a photo and a video |
| `/image.html` | one full-bleed photograph, alone, to watch a tear go through it |
| `/video.html` | one full-bleed video, playing the whole time it is torn |
| `/both.html` | photograph in front, video behind: tear through to it, then tear that too |
| `/untearable.html` | a page that only ever folds — pull as hard as you like |

The test pages use `test_assets/` and carry a 100 px rule, so where a tear
actually cut can be read straight off the grid.

Building the sim needs the Rust wasm target once:

```bash
rustup target add wasm32-unknown-unknown
```

## The interaction

You never cut this page. You pinch it and pull. The load travels out through
the sheet, it stretches and wrinkles, and the paper fails where the force is
concentrated — deterministically, by strength, not by dice. Tearing is a
consequence of the pull, never an input of its own.

The material has tensile strength, so how you pull decides what happens:

| what you do | what the paper does |
| --- | --- |
| nudge it (~40 px) | stretches and springs back, no damage |
| pull gently (~190 px) | folds and wrinkles across the sheet, still no tear |
| pull firmly | gives way just outside your fingers, a tear opens |
| keep dragging | the tear runs along your drag, as your hand re-grips |
| let go | the tear stops where it is — it never runs on down the page |
| shred a page down | once little of it still covers the screen, the rest lets go and falls |
| pull the last page | nothing. It creases and springs back; it never tears |

Those thresholds are not guesses. Peak strain was measured for each gesture
(1.2 for a nudge, 2.0 gentle, 2.5 firm, 2.8 hard) and the yield point set
between gentle and firm.

## How it works

| file | job |
| --- | --- |
| `wasm/src/lib.rs` | The sim. Verlet nodes on a grid, C ABI exports, no bindgen. |
| `src/sim.js` | Loads the wasm and reads its buffers straight out of linear memory. |
| `src/cloth.worker.js` | Owns every sheet, hit-tests grabs, steps the sim, posts packed vertices. |
| `src/gl.js` | WebGL2 renderer. One program, one draw call per sheet. No 3D library. |
| `src/layers.js` | The pages themselves, as HTML + CSS, rasterised through `<foreignObject>`. |
| `src/TearableCloth.vue` | Canvas, pointer input, frame loop, talks to the worker. |

### The forces

- **Elasticity.** Structural links stretch and recover; rigid links had nothing
  to store the pull with, so the sheet could only sit there or break.
- **Bending.** Links between every other node give the paper flexural
  stiffness. That is the difference between smooth waves and sharp creases, and
  it is what makes a gentle pull read as a fold.
- **Shear.** Diagonals stop the grid behaving like a fishnet.
- **Gravity**, carried by paper that has come free, fading in over ~110 px
  around a tear. An intact page is tacked to the viewport and must not droop —
  its layout is the design.
- **Damping**, high enough that a wave crosses the sheet and dies rather than
  ringing forever.
- **The grip is a spring, not a clamp.** How hard you are pulling is how far
  your hand has got ahead of the paper, which is what makes a gentle drag
  incapable of tearing and a hard one capable.
- **Yield and damage.** Past yield a link takes damage; each step the sim ranks
  every link by how close it is to letting go and breaks only the worst few.
  A crack tip yields sooner (stress concentration) so tears run — but only
  while the paper is still loaded, so they arrest when you stop.

### The rest of the model, and why each piece is there

- **Load wakes paper.** A node starts asleep and asleep means immovable. Wake
  only on *motion* and the sleeping ring around your grip acts as a rigid
  frame: the pull never reaches the sheet and you tear out a patch. So a link
  stretched past 2% wakes whatever it is pulling on, and force travels.
- **Settled paper sleeps again**, which is what makes the mesh density
  affordable — an untouched sheet costs nothing at all.
- **Weight fades with distance from a tear.** Whole page is tacked to the
  viewport and does not sag; paper near a rip carries its own weight and
  drapes. Without it the sheet creeps forever and never settles.
- **Edges are tacked, not nailed**, so a hard pull shifts the whole page in
  your hand before it gives, then it settles back.
- **Diagonals hold the shape.** Shear links stop the grid behaving like a
  fishnet; they exist only while their quad still has a way around, so they
  need no state and vanish exactly when the paper is cut.
- **Failure is ranked, not random.** Links accumulate damage past yield; each
  step the sim ranks every link by how close it is to letting go and breaks
  only the worst few. Same gesture, same tear, every run.
- **Starting a tear costs more than extending one.** Without that threshold the
  worst-loaded links on a strained sheet are scattered all over and the page
  develops confetti holes instead of a rip.
- **Paper does not fail inside your fingers.** What you hold is reinforced, so
  the crack starts just outside the grip and runs on from there as you drag.

### What is on the pages

- **Images and video are part of the paper.** A layer can declare `media`, and
  those are composited into its texture: the photo on the hero page and the
  playing reel tear with the sheet they sit on, because they *are* the sheet.
  Video frames are pushed into just their rectangle of the texture each frame,
  so a playing video costs about as much as a small sprite.
- **Controls keep working.** A layer can declare `components`, which are real
  DOM elements on top of the paper — they hover, click and toggle like any
  other control. They disappear the moment the paper under them is torn away,
  and a control belonging to a lower page only appears once the pages above it
  have been torn open. Click one to use it, drag from it to tear it.
- **A page can be untearable.** `tearable: false` on a layer means it only ever
  creases: it stretches, folds, drapes and springs back under any pull, but it
  never gives. The last page is one.

### The rendering

- The sim packs position, a **smooth per-vertex normal** and an edge value per
  node; the renderer uploads that one interleaved buffer. Screen-space
  derivative normals shade every triangle flat, which is what made torn paper
  look like folded cardboard.
- **Tear edges are eroded in the fragment shader** with value noise at a fibre
  scale (~6 px), independent of mesh density, and quads hanging on by one
  corner are dropped at rebuild — otherwise a rip reads as stray pixels.
- **Torn paper casts a shadow on the page below it**, drawn from the same mesh
  with the same torn edges, which is what makes a tear read as an opening with
  something further away behind it rather than a flat hole.
- **All sheets exist at once**, 90 px apart in depth with a matching scale so
  each still covers the viewport exactly. A drag takes the topmost sheet that
  still has paper under the cursor, which is why the page below shows through
  the hole immediately, and why a deep wrinkle cannot poke through it.

## Tuning it from JavaScript

Every number the material is made of is a live tunable, not a constant:

```js
sim.params.gravity = 900      // heavier paper
sim.params.yieldStrain = 1.4  // tears much more easily
sim.params.bounce = 1.4       // springier recovery
sim.params.dropAt = 0.5       // lets go sooner once shredded
sim.resetParams()             // back to the tuned defaults
```

The full list is `PARAM_NAMES` in `src/sim.js`, mirroring `set_param` in the
Rust. Changes apply to the running simulation immediately, which is how the
thresholds in the table above were found.

## What it asks of the machine

The starting mesh density comes from a device tier (`hardwareConcurrency` and
`deviceMemory`): 128 / 104 / 78 divisions across the short edge, and device
pixel ratio capped at 2 or 1.5. Those are only the starting point — the worker
measures its own step cost and trims a solver pass when steps run past 12 ms,
putting it back when there is room. Iterations are the dial rather than mesh
density, because changing them costs nothing and keeps every tear, where
rebuilding the sheets would throw them away.

## Editing the content

`src/layers.js` is a list of `{ name, css, html(w, h, scale) }`. Write ordinary
HTML and CSS; it is rasterised at device resolution and handed to the GPU. Two
constraints come from `<foreignObject>`: no external images (use CSS gradients
and shapes, or inline data URIs) and no webfonts unless you embed them, so the
display type uses a local stack. The last layer is the backdrop and is not
tearable.

## Performance

Measured in Chrome on an M-series Mac at 1200x705. Sheets run at spacing
`min(w, h) / 128`, here 5.5 px — **28,251 nodes per sheet**.

Sim cost tracks how much paper is awake, not the sheet size. An untouched sheet
is free; a pull wakes the load path, which is the point of it.

| state | awake nodes | cost per step |
| --- | --- | --- |
| untouched | ~0 | 0.0 ms |
| typical pull | 6–10k | 8–17 ms |
| heavy pull, most of the page loaded | 15k | ~28 ms |

Main thread while shredding: median **8.4 ms**, p95 17 ms. The page renders
whatever the latest simulated state is, so sim rate and frame rate are
independent.

Ship weight: 91 kB JS (35 kB gzipped), 65 kB wasm (22 kB gzipped), 4 kB worker.

Three things were worth more than any constant tuning, and are easy to undo by
accident:

- **The worker loop must not be paced by `setTimeout`.** Chained timeouts
  throttled the whole simulation to 9 Hz. It is scheduled through a
  `MessageChannel` instead, which is not clamped.
- **Wasm starts on the baseline compiler.** Cold, this module runs at a third
  of its speed (24 ms vs 8.6 ms for the same work); it only tiers up once the
  code has been hot for about a second. The worker burns in a small sheet at
  startup, behind the layer rasterisation.
- **Backpressure via the buffer pool.** The worker hands out vertex buffers
  only as the renderer returns them, so it never queues frames the page has not
  caught up with.

If you want more headroom: SIMD (`+simd128` and a vectorised solver), a worker
per sheet, or a coarser `spacing` in `TearableCloth.vue`. Measure `awake`
first — it is exposed on the sim, and `peak_strain` and `dead_link_stats` are
there too for working out where a sheet is actually failing.

Requires WebGL2; the component renders a message instead of the canvas if it is
unavailable.

## Credits

Built by Alex Mkwizu &lt;alexgmkwizu@gmail.com&gt;.

Type is [42dot Sans](https://fonts.google.com/specimen/42dot+Sans) (SIL Open
Font License), embedded in the page and in the sheet textures. The interaction
follows [pushmatrix/tearable](https://pushmatrix.github.io/tearable/); the
simulation, renderer and pages here are original.

MIT licensed — see [LICENSE](./LICENSE).
