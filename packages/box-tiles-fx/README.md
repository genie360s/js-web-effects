# box tiles

The grid from a title sequence, for the web. A fine grid of squares sits over
the picture, and on their own time — and harder when something happens — the
squares misbehave: one goes black, one shows the picture from a few cells
away, one flares up, a 2×2 block does it together. Then they let go. Names
arrive through the grid tile by tile and leave the same way. Turn the sound on
and the beat knocks the grid.

It works over whatever the page actually contains: a playing video, a
photograph, live text, a login form that keeps working underneath. The grid
is a state machine with a clock, written in Rust and compiled to WebAssembly,
stepped on a worker thread, and drawn in WebGL2.

[Live demo](https://genie360s.github.io/js-web-effects/box-tiles-fx/) · [How it works, on video](https://genie360s.github.io/js-web-effects/#box-tiles-fx)

## Install

```bash
npm install box-tiles-fx
```

```js
import { TileSurface, TileLayer } from 'box-tiles-fx'
import 'box-tiles-fx/style.css'
```

Vue 3 is a peer dependency. The components are described under [Putting the grid over something](#putting-the-grid-over-something). Without Vue, `createTiles(element, options)` from the same package returns the engine they drive, and `attachAudio` lets a sound source knock it.

## Running the demo

From this folder, in a clone of [js-web-effects](https://github.com/genie360s/js-web-effects):

```bash
npm install
npm run dev
```

## The pages

**home** (`#/`) — the tiles over a clip, with every dial on a slider: cell
size, ambient rate, hold, block chance, reach, flare, the weights of the
three kinds, the grade. Presets (quiet, titles, storm, mosaic, blackout),
three grades (blue, orange, mono), a reseed, and a **sound** button that
lets the clip's own audio drive it.

**titles** (`#/titles`) — a title sequence. A looping clip, a grade that
switches with the cut, five credits that arrive and leave tile by tile on the
clip's own clock, a burst on every cue, a logo with a reticle, letterbox. With
the sound on, a burst on every beat as well. Nothing on the page is a special
mode of the engine: the credits are `<TileLayer>`s whose `reveal` is driven
from `video.currentTime`, the grade is two colours written through
`setParams`, the bursts are `beat()`.

**text, login, image, video, all** — one page per thing the grid can sit
over, so each can be looked at on its own.

## What a tile does

Each cell of the grid carries four numbers, packed as half floats for the
shader:

| channel | meaning |
|---|---|
| `dx`, `dy` | which cell this tile shows instead of itself, in whole cells |
| `lift` | brightness, in stops; at or below −8 the tile is black |
| `lot` | a static random number per cell, for revealing things tile by tile |

A tile at rest is `0, 0, 0`. When it *flips* it takes one of three states and
a hold time — `hold` seconds, jittered — and goes back to rest when the time
is up. Everything pops; nothing eases. That is what the reference does, and
it is why it reads as a cut rather than as an effect.

What makes a tile flip is **excitement**. Each cell has a little of its own,
which the pointer adds to in a Gaussian around where it is, and the grid has
one global amount, which a beat adds to. Both fade at `decay` per second. A
cell at rest flips with probability `(rate + (global + drive) · pulseGain +
local · pulseGain) · dt` each step, so an ambient `rate` keeps a few tiles
popping on their own and a beat makes a burst that dies away. `drive` is the
same thing without the fading — a sound level, held by the host.

`block` is the chance a flip takes a 2×2. Blocks sit on even anchors, so two
of them either coincide or do not touch: a block is never half overwritten.

**Reveal is not simulated.** Each cell's `lot` is dealt once per seed, and a
layer's `reveal` (0..1) is compared against it in the shader: the cell shows
once the progress has passed its number, softened over `revealSoft`. `sweep`
mixes the lottery with the cell's own x position, so a name can wipe in from
the left and still arrive raggedly. The curve is squeezed so that at 0 nothing
shows and at 1 everything does, whatever a cell was dealt — `tiles.check.js`
asserts that for every lottery number, because the first version did not,
and left a few cells of every title permanently missing.

The same seed replays the same sequence. `reseed` deals a new lottery and a
new sequence; `reset` only puts the tiles down.

## Sound

`src/audio/beat.js` is in two halves. `createOnsetDetector` is pure: feed it
the energy of a band once a frame and it says whether a beat just landed and
how hard, judged against a short memory of what the music has been doing. A
beat has to be loud, louder than the recent mean, *and getting louder* —
without the last condition a note held for half a second fired once every
refractory period, which `beat.check.js` now asserts it does not.

`attachAudio(engine, mediaElementOrStream)` is the browser half: an
`AnalyserNode` on the element (or a microphone), the 30–150 Hz band where the
kick lives, and a loop that turns onsets into `engine.beat(strength)` and the
running level into `engine.drive(level)`. Browsers keep audio silent until a
gesture, so call its `resume()` from a click. An element can only be wrapped
once per document; the attachment is remembered and reused.

## Putting the grid over something

```vue
<TileSurface :options="{ cell: 40, grade: 0.8, shadows: '#06142e', highlights: '#cfe3ff' }">
  <TileLayer>
    <video src="clip.mp4" autoplay muted loop playsinline />
  </TileLayer>

  <TileLayer :reveal="progress" :sweep="0.6">
    <h1>A NAME</h1>
  </TileLayer>

  <TileLayer :tiles="false">
    <p>The grid leaves this alone.</p>
  </TileLayer>
</TileSurface>
```

`<TileLayer>` works on anything: live DOM, an `<img>`, a `<video>` that
keeps playing, a `<canvas>`. Live DOM is rasterised through an SVG
`foreignObject` and re-rasterised when it changes — including on every
keystroke, so a form is tiled as it currently reads. Images, video and
canvases go straight to the GPU without a rasterisation step.

The real element stays in the document the whole time and keeps its layout,
its links, its focus and its screen-reader text. The engine only makes it
transparent once the GPU is actually drawing it, so a browser without WebGL2
shows the ordinary page, and so does one whose context has just been lost.
Visitors who have asked for reduced motion get the picture without the tiles.

Per layer: `reveal`, `revealSoft`, `sweep`, `tiles`, `live` (re-read a canvas
each frame), `capture` (your own rasteriser).

## The dials

Every one can be written at any time, including mid-frame, and takes effect
on the next step. The solver keeps its own as one flat array in linear
memory, so setting one is a store, not a call.

```js
engine.setParams({ rate: 0.2, black: 2, cell: 32 })
engine.beat(1)          // knock the whole grid
engine.pulse({ clientX, clientY, strength: 2 })
engine.drive(0.5)       // keep it excited until told otherwise
engine.reseed(42)
```

`src/sim/params.js` is the full list of solver parameters with one-line
descriptions; `DEFAULTS` in `src/engine.js` is the rest — the cell size, the
pointer, and the look: `lineColor`, `lineAlpha`, `lineWidth`, `lineGlow`,
`gridMask` (`'content'` draws the grid only over layers, `'surface'` over the
whole box), the duotone `shadows` / `highlights` / `grade`, `exposure`,
`vignette`.

| name | what it does |
|---|---|
| `cell` | tile size in CSS pixels. The look's one real dial. |
| `rate` | flips per cell per second with nothing happening; 0 is a still picture |
| `hold`, `holdJitter` | how long a tile keeps its state |
| `shift`, `black`, `lift` | the weights of the three kinds |
| `block` | chance a flip takes a 2×2 |
| `offsetMax` | furthest a shifted tile looks, in cells |
| `liftMax` | brightest a flare gets, in stops |
| `decay` | how fast a stroke or a beat fades |
| `pulseGain`, `beatGain` | how hard excitement flips tiles, and how much a beat excites |
| `maxActive` | most of the grid that may be active at once |

## Running it

The compiled `src/sim/tiles-core.wasm` is committed, so Rust is only needed if
you change the solver:

```bash
npm run wasm             # cargo build + copy into src/sim/
npm test                 # all of the below
npm run test:unit        # cargo test, the beat detector, the governor, the seam
npm run test:regression  # the real wasm through the real ABI, against golden.json
npm run test:integration # the real worker, under node, through its message protocol
```

**`cargo test`** — seventeen assertions against the struct. That a quiet
grid is inert; that a stroke pops tiles under the pointer and nowhere else;
that they hold and then let go; that shifts and flares stay inside their
dials and black sits below the shader's threshold; that a block is four cells
that agree; that a beat lands everywhere and fades; that the same seed
replays the same tiles and a different one does not; that the lottery is
fair, survives a reset and not a reseed; that an ambient rate gives the
occupancy the arithmetic predicts, `r·h / (1 + r·h)`; that the cap holds
against a huge beat; that drive keeps it awake until let go; and that hostile
input — NaN coordinates, infinite radii, a parameter table full of garbage —
is refused without panicking and without a non-finite texel ever reaching
the renderer.

**`node wasm/test.mjs`** — the same solver, but through the real C ABI,
reading the real half-float texels the shader will sample. It catches what the
Rust tests cannot: a packing mistake, a renamed export, or a parameter table
that has drifted away from the JavaScript one. It is also the **regression
test**: a seeded, scripted run is fingerprinted and compared with
`wasm/golden.json`, so a change to the solver that was not meant to change
what the tiles do fails here. One that was: `node wasm/test.mjs --update`.

**`node src/render/tiles.check.js`** — the seam. The numbers the solver packs
have to land in the range the shader's expressions were written for, and the
two formulas the renderer depends on — the reveal curve and the lift — are
mirrored in JavaScript and asserted at their ends. It also asserts the GLSL
still contains the mirrored expressions, so the two cannot drift silently.

**`node src/audio/beat.check.js`** — the onset detector against a signal
with a known answer: every kick found within a frame, nothing found between
them, nothing in silence, one beat for one held note.

**`node src/render/quality.check.js`** — the governor: demotes after
sustained slow frames and not after one, climbs back after a comfortable
stretch, stops climbing after being knocked down twice, reads 16.7 ms as fine
on a 60 Hz panel and slow on a 120 Hz one, and honours a pinned tier.

**`node src/sim/worker.check.js`** — the **integration test**: the actual
worker file, under Node's `worker_threads`, with the actual wasm, through the
actual message protocol. A refused grid says so; `ready` reports the grid it
built; a quiet grid sends nothing; a stroke wakes it; frames stop when the two
buffers are not returned and resume when they are; it holds the display rate
while busy and goes quiet when settled; a resize changes the frame shape and
a stale buffer is swapped out; pause means pause; reseed is deterministic.
Writing this is what found that a refused first grid followed by a good one
never started the clock.

## Performance

The grid is not a quality tier. A cell is a look, chosen in CSS pixels, and
the solver is too cheap to care how many there are — measured per 60 Hz
step, busy:

| viewport | grid | cells | ms/step |
|---|---|---|---|
| phone | 10×22 | 220 | 0.004 |
| laptop | 36×23 | 828 | 0.007 |
| 1080p | 48×27 | 1296 | 0.012 |
| 4k | 96×54 | 5184 | 0.052 |
| the most allowed | 512×512 | 262k | 3.3 |

What a tier buys is pixels: the backing-store resolution the layers are drawn
at. The tier is picked from a device probe and then adjusted by a governor
watching frame times, which learns the display's own cadence rather than
assuming 16.7 ms, needs ~45 sustained slow frames before dropping a tier, and
stops trying to climb after being knocked down twice. Quality can also be
pinned from the panel.

A settled grid is not stepped and not sent: with `rate` at zero and nothing
exciting it, the worker drops to a tenth of its rate and the main thread
holds no animation frame at all. The whole thing also pauses when the tab is
hidden or the surface is scrolled out of view.

## How it fits together

```
wasm/src/lib.rs             the grid, and its seventeen tests
wasm/test.mjs               the ABI, the texels, the golden fingerprint, the cost
src/sim/tileWorker.js       worker: owns the wasm, fixed timestep, ping-pong buffers
src/sim/params.js           the tunables, by name — the other half of lib.rs
src/sim/worker.check.js     the worker, for real, under node
src/render/renderer.js      WebGL2: the layers through the field, the grid over them
src/render/shaders.js       the GLSL, and the JavaScript mirrors of what matters
src/render/quality.js       tiers, device probe, and the adaptive governor
src/render/tiles.check.js   the seam between the solver and the shader
src/audio/beat.js           onset detection, and wiring a media element to the engine
src/ui/capture.js           live DOM to a texture, with no dependencies
src/engine.js               binds it together: layers, input, the frame
src/components/             TileSurface, TileLayer
src/pages/                  one file per page; App.vue routes on the hash
```

**The boundary.** No wasm-bindgen: the solver exports plain `extern "C"`
functions and its linear memory, which is all a numeric kernel needs. Frames
cross to the renderer as interleaved half floats — `dx, dy, lift, lot` — and
WebGL2 reads `RGBA16F` natively. The field is sampled with nearest filtering,
because a cell is a cell and a texel filtered against its neighbour would be
a tile half shifted. Two buffers ping-pong between the threads by transfer, so
the worker throttles itself to the display rate without any timer agreeing
with any other, and no frame is ever copied across.

**The grid lines** are one full-screen pass over everything, at a fixed
weight in device pixels so they are the same at every cell size. With
`gridMask: 'content'` the pass blends by destination alpha, which masks the
lines to wherever a layer has been drawn without a second pass.

## Deliberate limits

- Shifts are whole cells. The reference shows fractional slides occasionally;
  whole cells keep the mosaic reading as a mosaic.
- The sequence on the titles page is a list of times in a component, not a
  timeline format. It is forty lines; a format can be added when there is a
  second sequence.
- `::before` / `::after` content, cross-origin fonts and images without CORS
  headers, and iframes do not make it into a DOM capture. Pass your own
  `capture` function if you need them.
- There is no browser-driven end-to-end test; the pages were checked by hand.

## Controls

- **move** — disturb the tiles under the pointer; faster is harder
- **click** — knock them
- **sound** — let the clip's audio drive it (home, titles)
- **beat** — one knock, from a button
- **settle** — every tile back to rest
- **h** — hide the panel (home)

Type is [42dot Sans](https://fonts.google.com/specimen/42dot+Sans).
MIT.
