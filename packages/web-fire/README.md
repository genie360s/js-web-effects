# web fire

Set fire to a web page. Not a shader that looks like fire — a combustion
solver, written in Rust and compiled to WebAssembly, running on a worker
thread, burning whatever the page actually contains: text, a card, a login
form, a photograph, a playing video.

Drag across something to hold a match to it. It chars, the char glows, it
burns through, and the flame over it leans in the wind and is bent by its own
heat haze. Everything that survives is still a working page underneath: the
form keeps its focus ring, keeps what you typed, and keeps submitting.

[Live demo](https://genie360s.github.io/js-web-effects/web-fire/) · [How it works, on video](https://genie360s.github.io/js-web-effects/#web-fire)

## Install

```bash
npm install web-fire
```

```js
import { FireSurface, FireLayer } from 'web-fire'
import 'web-fire/style.css'
```

Vue 3 is a peer dependency. The components are described under [Burning something](#burning-something). Without Vue, `createFire(element, options)` from the same package returns the engine they drive.

## Running the demo

From this folder, in a clone of [js-web-effects](https://github.com/genie360s/js-web-effects):

```bash
npm install
npm run dev
```

## What is actually being solved

A flame is a loop, and every link in it is here:

1. **A hot surface pyrolyses.** Above about 800 K the material starts giving
   off combustible vapour. The rate is Arrhenius, `A·exp(-Ta/T)`, which is
   what makes ignition a threshold rather than a fade-in: between a warm page
   and a burning one that term moves four orders of magnitude.
2. **The vapour is carried off by the flow, and burns where it meets
   oxygen.** This is the flame, and it is the part that took two attempts.
   Burning the solid where it stands does not work: buoyancy empties the cell
   over a burning surface in about a millisecond, so all the heat released
   there is gone before it can do anything, and the fire goes out every time.
   Releasing vapour into the gas lets the reaction happen all the way up the
   plume — which is where a real diffusion flame is — and the flame is then
   tall and hot enough to keep its own fuel coming.
3. **The hot gas rises,** because air's density goes as `1/T` (Boussinesq).
4. **The air is incompressible,** so it cannot go up the middle without
   something coming in from the sides. What comes in is fresh oxygen, and
   that is what keeps the base of the flame alight. Take it away — turn
   `oxygenRefresh` to zero — and the fire eats what it has and dies.
5. **The flame radiates back down** onto the surface, which keeps it
   pyrolysing. This one cannot be a local term, because the flame is never in
   the same cell as the fuel feeding it: the gas touching a burning surface is
   the cold air being entrained into the base of the plume. The sooty flame's
   emission is smeared over a few cells instead — the diffusion approximation
   to radiative transfer — and what lands on the surface is what closes the
   loop.

Nothing about the shape of a flame is authored. It flickers because a buoyant
plume is unstable, leans because wind is a body force on the air, curls
because vorticity confinement puts back the small eddies that semi-Lagrangian
advection eats, spreads upward far faster than sideways because the plume
preheats what is above it and nothing preheats what is below, and stops at a
gap in the fuel because there is nothing there to burn.

**Two temperatures, not one.** The gas is carried by the flow; the surface is
not. They exchange heat by ordinary convection, which is deliberately weak —
a large coefficient there does not light the page, it puts it out.

**The colour is Planck's law.** `src/render/blackbody.js` integrates the
Planck spectrum against the CIE 1931 colour matching functions and converts
to sRGB primaries, once, into a 256-entry table the shader samples by
temperature. Deep red at 800 K through orange to near-white at 2600 K is not
a gradient somebody picked; it is the same function evaluated 1800 K apart.

Three things emit, and they are different physics, which is why a flame is
not one colour: soot in the flame is incandescent and radiates as a grey body
(the yellow); the reaction zone emits in bands from excited radicals rather
than as a hot body (the blue at the base, where the gas is hot and has not
sooted up yet); and soot that has cooled is smoke, which absorbs rather than
emits and is lit from below by the fire it came from.

## Burning without being burnt

`#/eternal` is the other half of the model. Everything on that page is alight
and stays alight, and nothing on it is damaged, using no special case anywhere
in the solver or the renderer — just two ideas.

**`fuelSupply`** replaces fuel as fast as the flame takes it. At zero, a layer
is a sheet of paper and the fire eats it. Turned up, what is burning was never
the surface: the fuel arrives from somewhere else, which is what a gas ring is
and why you can run one under a kettle all day without losing the kettle.
`charRate: 0` is the other side of it — nothing is recording damage, so there
is none to record.

**The item is not the fuel.** Each one is wrapped in a layer with `:fuel="0"`,
so it cannot catch, cannot char and cannot be burnt through, and the thing
that is actually alight is a thin strip tucked under its bottom edge, in a
layer marked `invisible` — fuel that is never drawn, which is what a gas jet
is: you do not see the jet, you see the flame standing on it. That
part matters more than it sounds. Given endless fuel and no damage, a fire
spreads over every cell of fuel it can reach and then stays there — so an item
that is itself combustible ends up uniformly ablaze, and a flame as wide as
the card is a sheet of light with the card somewhere behind it. Burning a
burner instead gives tongues of flame off the bottom edge, and the item stays
legible: on fire, and still there. It works the same on a heading, a form, a
photograph, a playing video or a row of chips, because a burner does not care
what is standing on it.

A pilot light re-strikes each burner every 700ms at low heat. It does not
check whether anything is already alight first — an earlier version only lit
up when the whole grid had gone quiet, and the first burner to catch then kept
the grid busy forever while none of the others were ever lit. Always on also
covers the cases that wipe the fire deliberately, like a resize or a change of
quality tier, without having to know about them.

## Burning something

```vue
<FireSurface :options="{ scene: 1.2, windX: 2 }">
  <FireLayer>
    <form class="login">…</form>
  </FireLayer>

  <FireLayer :fuel="0">
    <p>This will not catch.</p>
  </FireLayer>
</FireSurface>
```

`<FireLayer>` works on anything: live DOM, an `<img>`, a `<video>` that keeps
playing while it burns, a `<canvas>`. Live DOM is rasterised through an SVG
`foreignObject` and re-rasterised when it changes — including on every
keystroke, so a form burns as it currently reads, not as it loaded. Images,
video and canvases go straight to the GPU without a rasterisation step.

The real element stays in the document the whole time and keeps its layout,
its links, its focus and its screen-reader text. The engine only makes it
transparent once the GPU is actually drawing it, so a browser without WebGL2
shows the ordinary page, and so does one whose context has just been lost.

**What burns is what is there.** The renderer composites the page flat at grid
resolution, reads its alpha back, and hands that to the solver as a fuel map.
So a photograph burns as a sheet, and a paragraph burns as letters with air
between them — because that is what a paragraph is. Whatever has already
charred stays charred when the map is re-sent, or typing into a form would
resurrect the part of it that is already ash.

## The dials

Every one of them can be written at any time, including mid-frame, and takes
effect on the next step. The solver keeps them as one flat array in its own
linear memory, so setting one is a store, not a call.

```js
engine.setParams({ windX: 4, gust: 0.6, sootYield: 12 })
```

`src/sim/params.js` is the full list with units and one-line descriptions —
45 of them, all SI. The ones worth knowing:

| name | what it does |
|---|---|
| `scene` | how tall the viewport is **in metres**. The dial that decides what size of fire you are looking at: everything else is SI, so this is what ties a metre to a pixel. |
| `windX`, `windY`, `gust`, `gustHz` | the weather |
| `turbulence` | vorticity confinement — the curl in the flame |
| `pyrolysisRate`, `pyrolysisActivation` | how readily, and how suddenly, a hot surface starts giving off vapour |
| `oxygenRefresh` | how fast fresh air arrives. Zero suffocates it. |
| `sootYield` | soot per unit burned. This is the yellow; without it the flame is nearly invisible, which is also true of real ones. |
| `flameFeedback`, `flameReach` | how hard, and how far, the flame radiates back into the page. This is the spread rate. |
| `flameTemp` | the adiabatic flame temperature, 2200 K. Nothing burns past it. |
| `fuelSupply` | 1/s that spent fuel is replaced. 0 is paper; high is a gas burner that never consumes what it stands on. |
| `gravity`, `buoyancy` | try `gravity: -9.81` |

Look, rather than physics — `exposure`, `haze`, `scorch`, `burn`, `glow`,
`sootEmit`, `blue`, `smoke`, `emberSize` — goes through the same call, and
`haze`, `scorch`, `burn`, `glow`, `fuel` and `invisible` can be set per layer
as props.

The hero page has all of it on sliders, and four presets (paper, bonfire,
gale, smoulder) that are nothing but numbers.

## Running it

The compiled `src/sim/fire-core.wasm` is committed, so Rust is only needed if
you change the solver:

```bash
npm run wasm    # cargo build + copy into src/sim/
npm test        # the solver, the boundary, and the seam between them
```

`npm test` is three things:

**`cargo test`** — twenty-two assertions about the physics, against the struct.
That cold fuel does not light itself and a match does; that ignition is a
threshold and not a fade; that fire climbs faster than it creeps down; that
the plume rises and wind leans it; that pyrolysis accounts for every bit of
fuel it takes; that suffocating it puts it out; that a gap in the fuel stops
it; that it burns out and goes quiet; that the projection leaves the flow
nearly divergence-free; that confinement adds curl without adding wind; that
embers are thrown by a fire and by nothing else; and that hostile input —
NaN coordinates, infinite radii, a parameter table full of garbage — is
refused without panicking and without a non-finite texel ever reaching the
renderer. And, for the burner, that it is still burning half a minute later
with nothing damaged and no runaway, and that turning the supply off lets it
burn out again like anything else.

**`node wasm/test.mjs`** — the same solver, but through the real C ABI,
reading the real half-float texels the shader will sample. It catches what
the Rust tests cannot: a packing mistake, a renamed export, or a parameter
table that has drifted away from the JavaScript one. It also prints what a
step costs.

**`node src/render/flame.check.js`** — the seam. The numbers the solver packs
have to land in the range the shader's constants were chosen for, and nothing
else checks that. The first working version of this produced a perfectly good
fire — a real burning front, the right temperatures, char in the right places
— and rendered nothing at all, because the soot it made was a hundredth of
what `sootEmit` expected and every flame pixel came out transparent.

## Performance

The solver runs on a worker, so its cost never blocks a frame. Measured on
this machine, per 60Hz step, with the fire actually burning:

| tier   | grid    | cells | ms/step | share of a 60fps frame |
|--------|---------|-------|---------|------------------------|
| low    | 160×90  | 14k   | 1.32    | 7.9%                   |
| medium | 224×126 | 28k   | 2.51    | 15.1%                  |
| high   | 288×162 | 47k   | 4.22    | 25.3%                  |
| ultra  | 384×216 | 83k   | 7.42    | 44.5%                  |

Getting there took three things. The pressure solve is the most expensive
part of a frame, so it is red-black **over-relaxed** Gauss-Seidel rather than
plain: over-relaxing takes the step it was going to take anyway and then
takes it again, which is worth roughly an order of magnitude in sweeps. The
chemistry, the radiation and the diffusion are integrated **once per frame**
with the whole timestep, because they are smooth and rate-limited and do not
care that the frame was cut into three; only advection and the pressure solve
are sub-stepped, and only as often as the CFL condition demands. And the four
advected scalars share **one traversal**, because working out where a cell
came from costs more than the four interpolations put together.

The tier is picked from a device probe (cores, memory, mobile, DPR) and then
adjusted by a governor watching frame times. It learns the display's own
cadence rather than assuming 16.7ms, needs ~45 sustained slow frames before
dropping a tier, and stops trying to climb after being knocked down twice.
Quality can also be pinned from the panel.

Resource awareness beyond that: **a fire that has gone out is not stepped and
not sent.** One last frame goes out as it dies, and then the worker does
nothing at all until something is lit again, and the main thread's animation
loop lets go four frames later. A page that burned down an hour ago costs
nothing. The whole thing also pauses when the tab is hidden or the surface is
scrolled out of view, and a layer that is off screen is neither drawn nor
counted as fuel.

## How it fits together

```
wasm/src/lib.rs             the solver, and its twenty tests
wasm/test.mjs               the physics, through the real ABI
src/sim/fireWorker.js       worker: owns the wasm, fixed timestep, ping-pong buffers
src/sim/params.js           the tunables, by name — the other half of lib.rs
src/render/renderer.js      WebGL2: the passes, the textures, the fuel readback
src/render/shaders.js       the GLSL
src/render/blackbody.js     Planck's law, once, into a lookup table
src/render/quality.js       tiers, device probe, and the adaptive governor
src/render/flame.check.js   the seam between the physics and the shader
src/ui/capture.js           live DOM to a texture, with no dependencies
src/engine.js               binds it together: layers, input, the frame
src/components/             FireSurface, FireLayer
src/pages/                  one file per page; App.vue routes on the hash
```

**The boundary.** No wasm-bindgen: the solver exports plain `extern "C"`
functions and its linear memory, which is all a numeric kernel needs. Frames
cross to the renderer as interleaved half floats — gas heat, soot, char,
surface heat — at half the bandwidth of `f32`, and WebGL2 filters RGBA16F
natively, so the shader gets a smooth field for free. The sparks ride in the
same buffer behind the field. Two buffers ping-pong between the threads by
transfer, so the worker throttles itself to the display rate without any
timer agreeing with any other, and no frame is ever copied across.

One trap worth naming, since it cost an afternoon: `UNPACK_PREMULTIPLY_ALPHA_WEBGL`
applies to typed-array uploads as well as to images, and this field is not an
image — its fourth channel is the temperature of the burning surface, not an
opacity. Left on, it multiplies the heat and the soot by it, which zeroes the
flame everywhere the surface underneath has already burnt away: that is to
say, everywhere the flame actually is.

## Deliberate limits

- The reaction sheet is a fraction of a millimetre thick, which no grid this
  size can resolve, so the flame is anchored by letting the hot surface stand
  in for the gas temperature where the two meet. Without it the flame is
  blown off the moment the plume gets going.
- The Kelvin-angle problem in reverse: advection is first-order
  semi-Lagrangian and therefore diffusive. Vorticity confinement is what pays
  that back. BFECC would be the honest fix if the smoke ever needs to hold an
  edge.
- Radiative conductivity along the surface is evaluated at the hottest point
  rather than per cell, because a coefficient that varies from cell to cell
  makes the explicit stencil asymmetric and heat then flows uphill.
- `::before` / `::after` content, cross-origin fonts and images without CORS
  headers, and iframes do not make it into a DOM capture. Pass your own
  `capture` function if you need them.

## Controls

- **drag** — hold a match to whatever is under the pointer; moving fast fans it
- **put it out** — reset
- **h** — hide the panel (hero page)
- **nav, top right** — between the hero, one page per thing that can burn, and
  `eternal`, where nothing is consumed

Type is [42dot Sans](https://fonts.google.com/specimen/42dot+Sans).
MIT.
