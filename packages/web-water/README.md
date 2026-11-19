# still water

An interactive pond. The surface is a real wave simulation — a damped wave
equation with a drift field — solved in Rust/WebAssembly on a worker thread and
shaded in WebGL2 over a procedurally generated bed of silt, gravel, stones and
fallen leaves. There are no image assets in this project; everything you see is
generated at runtime.

Move the pointer slowly and it sheds ripples. Drive it fast and it stops being a
point poking the surface and starts being something travelling through it — a V
opens up behind, transverse crests stack up inside the V, and the track is left
churned and cloudy. Click and something drops in.

[Live demo](https://genie360s.github.io/js-web-effects/web-water/) · [How it works, on video](https://genie360s.github.io/js-web-effects/#web-water)

## Install

```bash
npm install web-water
```

```js
import { WaterSurface } from 'web-water'
import 'web-water/style.css'
```

Vue 3 is a peer dependency. `<WaterSurface>` fills the box you put it in, for example `<div style="position: fixed; inset: 0"><WaterSurface /></div>`. Props: `breeze`, `quality` (`auto`, `low`, `medium`, `high`, `ultra`), `seed`, `waterDepth`, `uiDepth` and `dropOnPress`. It exposes `splash(clientX, clientY)` and `setUiLayer(canvas)`, the submerged interface layer described below.

## The two pages

**pond** (`#/pond`) is the water on its own.

**water ui** (`#/water-ui`) puts an interface *in* it. The panel, sliders,
toggle and buttons are not DOM — they are painted into a canvas that the shader
samples as a second submerged layer, so they refract, take the caustics and pick
up the green exactly as the leaves on the bed do. Ripples visibly bend them, and
using a control disturbs the water where you touched it. The controls drive the
water they are floating in.

One deliberate cheat makes them usable: the layer's displacement is measured
against a *flat* surface rather than against the screen. A plane at that depth
would otherwise sit a couple of hundred pixels from where it was drawn, because
looking into water at an angle shifts everything you see through it, and every
click would miss. Registered this way it sits exactly where it was painted, and
only the ripples move it — so hit testing is plain rectangle arithmetic in CSS
pixels, and what you click is what you hit.

Dragging a control repaints and re-uploads only that strip of the layer.
Re-sending the whole screen per frame would cost more than everything else the
frame does put together.

## Running it

```bash
npm install
npm run dev
```

The compiled `src/sim/water-core.wasm` is committed, so Rust is only needed if
you change the solver:

```bash
npm run wasm    # cargo build + copy into src/sim/
npm test        # build, then assert the physics still holds
```

`npm test` is the check that matters. It asserts the things that make the
surface read as water rather than as a shader trick: that a ripple actually
travels outward, that it stays round (under 35% anisotropy — it currently
measures 0.1%), that amplitude stays bounded, that energy decays instead of
ringing forever, and that a hard flick carries the wake downstream.

## How it fits together

```
src/sim/waterWorker.js    worker: owns the wasm, fixed 60Hz timestep, input → forces
wasm/src/lib.rs           the solver
src/render/renderer.js    WebGL2: refraction, absorption, caustics, reflection
src/render/bed.js         the procedural pond floor
src/render/quality.js     tiers, device probe, and the adaptive governor
src/ui/scene.js           the submerged controls: layout, state, hit testing
src/ui/paint.js           how they are drawn — ceramic, not interface chrome
src/components/WaterSurface.vue   binds it together
src/pages/                one file per page; App.vue routes on the hash
```

**The solver.** A height field integrated with a damped wave equation in
velocity form, using a 9-point isotropic Laplacian — the usual 5-point stencil
makes ripples that visibly square off along the grid axes. A separate drift
field, injected by fast pointer strokes and decayed each step, advects the
surface semi-Lagrangianly, which is what makes a flick read as *motion* rather
than as a bigger splash. The border is a sponge layer so waves leave the view
instead of bouncing off an invisible wall.

The ambient breeze is deliberately *not* integrated. Driving a wave equation
with a steady periodic force pumps energy into whichever modes resonate with it,
and the surface climbs without bound — an early version reached 20× the
intended amplitude and drowned every real ripple. It is now laid over the solved
height at pack time as two travelling wave trains, split into per-row and
per-column factors so a travelling wave costs two multiplies per cell rather
than a sine.

**The wake.** Past about 220 cells a second the moving point leaves a boat-style
wake: two divergent arms, the transverse crests stacked between them, and a
churned trail down the middle. The half-angle opens to about 34 degrees just
over the threshold and tightens onto 19.5 degrees — the real deep-water Kelvin
angle — as it speeds up.

That geometry is imposed rather than emergent, which is a deliberate call worth
being plain about. A moving point in this height field *would* raise its own
cone, but the field is non-dispersive: waves cross it at about 36 cells a second
while a flicked cursor covers several thousand, so the cone the solver produces
unaided is under a degree wide — a straight scar, not a wake. Getting a visible
angle honestly would mean running the wave speed ten times higher, which costs
ten sub-steps a frame. The angle is set instead, and `npm test` measures the V
that actually comes out rather than trusting the constant.

The deposit is scaled by distance travelled, not by the timestep. The whole V is
re-laid every frame, so a point barely moving would otherwise paint the same
water sixty times a second and pile up a ridge — which is exactly what an
earlier version did, and why a slow drag once left a bigger disturbance than a
fast one.

**The boundary.** No wasm-bindgen: the solver exports plain `extern "C"`
functions and its linear memory, which is all a numeric kernel needs. Frames
cross to the renderer as interleaved half floats (height, stirred silt) — half
the bandwidth of `f32`, and WebGL2 filters `RG16F` natively, so the shader gets
smooth normals for free. Two buffers ping-pong between the threads by transfer,
so the worker throttles itself to the display rate without any timer agreeing
with any other, and no frame is ever copied across the boundary.

**The shading** follows the path light actually takes. It either reflects off
the surface (Fresnel, showing a canopy overhead) or refracts into it (Snell),
crosses a depth of water that absorbs the red out of it, bounces off the bed and
comes back. Caustics fall out of the same geometry: a crest is a converging
lens, so the bed brightens under it. The pond is deliberately a shaded one —
reflection is held to 20% of its physical value and the sun glint is gated on
surface slope, because a directional light on dead-flat water spreads one
enormous soft lobe across the frame, which is a rendering artefact rather than a
highlight.

Disturbed water here goes cloudy rather than white: a wake lifts silt off the
bed. Pond water does not foam under a fingertip.

## Performance

The simulation runs on a worker, so its cost never blocks a frame. Measured on
this machine, per 60Hz step at 16:9:

| tier   | grid    | cells | ms/step | + wake | share of a 60fps frame |
|--------|---------|-------|---------|--------|------------------------|
| low    | 224×126 | 28k   | 0.46    | 0.53   | 3.1%                   |
| medium | 320×180 | 58k   | 0.94    | 1.06   | 6.3%                   |
| high   | 448×252 | 113k  | 1.83    | 2.03   | 12.1%                  |
| ultra  | 592×333 | 197k  | 3.21    | 3.50   | 20.9%                  |

The wake column is the cost with a wake being driven every frame, which only
happens while the pointer is actually moving fast.

The tier is picked from a device probe (cores, memory, mobile, DPR) and then
adjusted by a governor watching frame times. It learns the display's own cadence
rather than assuming 16.7ms, needs ~45 sustained slow frames before dropping a
tier, and stops trying to climb after being knocked down twice — the machine has
told you where it stands. Quality can also be pinned from the panel.

Resource awareness beyond that: the simulation drops to 30Hz once the surface
has settled and nothing is touching it (`dt` scales with it, so the breeze stays
wall-clock correct), and pauses entirely when the tab is hidden.

## Controls

- **pointer** — ripples when slow, a Kelvin wake when driven fast
- **click** — drop a stone
- **h** — hide the panel
- **panel** — quality tier, breeze strength, and a new procedural bed
- **nav, bottom left** — between the pond and the submerged interface

Type is [42dot Sans](https://fonts.google.com/specimen/42dot+Sans).

## License

MIT. See [LICENSE](LICENSE).
