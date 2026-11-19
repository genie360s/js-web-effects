# web-oil-colours

Wet oil paint in a browser. Move the cursor and the paint moves with it —
colours mix the way pigment mixes, bleed across their seams, and hold the
ridges the brush leaves. A Rust/WebAssembly solver runs on a worker thread; a
WebGL2 shader lights the result.

[Live demo](https://genie360s.github.io/js-web-effects/web-oil-colours/) · [How it works, on video](https://genie360s.github.io/js-web-effects/#web-oil-colours)

## Install

```bash
npm install web-oil-colours
```

```js
import { OilSurface, OilCanvas, OilCard, vOil } from 'web-oil-colours'
import 'web-oil-colours/style.css'
```

Vue 3 is a peer dependency. Register the directive once with `app.directive('oil', vOil)`, then see [Making your own components out of paint](#making-your-own-components-out-of-paint). `<OilCanvas>` on its own is the bare canvas; it fills the box you put it in.

## Running the demo

From this folder, in a clone of [js-web-effects](https://github.com/genie360s/js-web-effects):

```
npm install
npm run wasm     # build the Rust core (needs the wasm32-unknown-unknown target)
npm run dev
```

`npm test` builds the core and runs its self-check: that blue over yellow comes
out green, that white over black stays dark, that a drag carries paint and a
flick grips as hard as a slow drag, that a stamped component smears like paint
rather than sitting on top of it, that the canvas settles, that wet paint bleeds
and tacky paint does not, and that nothing blows up under abuse.

`sonar-project.properties` is here for a SonarQube run; the scanner needs a
server to fetch its quality profile from.

## Why it looks like paint

**Colour mixes subtractively.** Blue and yellow give green, not grey. Nothing
in the solver stores RGB: each cell carries Kubelka-Munk absorption/scattering
ratios per channel, scaled by how much paint sits there. The KM mixture law
says a blend's K/S is the concentration-weighted mean of its parts', which is
exactly what you get by advecting `mass` and `mass × K/S` as separate conserved
quantities. Mixing is not a step in the pipeline — it is what transport does
once colour is stored this way. It is also why a little ivory black kills a lot
of titanium white, as it does on a real palette.

**Paint has a yield stress.** Oil paint is a Bingham plastic: below a threshold
shear it does not flow at all. That is why impasto peaks stay standing instead
of slumping overnight, and here it is also what lets an untouched canvas reach
a true rest, so the worker can stop and stay stopped.

**There is no inertia.** At a millimetre scale oil sits at a Reynolds number
near zero, so velocity is not integrated — it is a balance struck fresh each
step between what the brush drags along and where thickness wants to level out.
That lubrication term is what raises a bow wave ahead of a stroke.

**The brush is a brush.** Its footprint is an ellipse laid across the direction
of travel and combed into bristles, indexed by how far across the stroke a cell
sits rather than by where it is on the canvas — so the furrows stay attached to
the brush through a curve and run the length of the mark. A loaded brush also
runs dry with distance, so a stroke starts solid and breaks up as it goes.

**Thickness does the rest.** The shader gets a height field for free and takes
the surface normal, the cavity shading between ridges, and the canvas weave
showing through where paint has been scraped thin, all from that one channel.
The bristle furrows it lights are real ones in the thickness field, not a
procedural stand-in — an earlier version inferred stroke direction from the
thickness gradient, which points radially on a round dab and drew bullseyes on
paint no brush had touched.

## Two pages

**studio** (`#/studio`) is the canvas on its own, with a DOM panel beside it.

**oil colour ui** (`#/oil-colour-ui`) is an empty canvas with a sample login
card on it, and nothing else. The card *is* the paint: its white ground, its
brown fields and its crimson button are the only pigment anywhere. Drag across
it and they come off on the brush and mix into each other, subtractively, the
same as any two colours on the studio page. The text stays crisp and the form
still works.

**image & video** (`#/oil-media`) lays a picture into the paint. A still is laid
once, thickly, and is then simply paint — drag it and it smears and mixes like
anything else. A moving picture is laid a little at a time, every frame, and
that one is the interesting case: it reads as someone re-painting the same
picture over and over, so a smear survives for a moment and is then gradually
painted back in. Lay it too fast and it stops behaving as paint at all — the
solver never gets between two frames, and what you have is a video with a
texture on it. The *re-paint* slider is that trade.

The thing that makes a photograph read as paint rather than as a photograph is
**impasto**. Laid at one thickness there is no surface for the light to catch,
however good the pigment model is. So `stamp` takes a `relief` term that lays
the lights thicker than the darks, the way a painter does. It costs nothing in
colour: reflectance is K/S over mass, so scaling both leaves the hue exactly
where it was and moves only the height.

## Making your own components out of paint

Wrap them in an `<OilSurface>` and mark the ones that should be paint:

```vue
<OilSurface bare>            <!-- bare linen; the components are the only paint -->
  <article v-oil>                                    <!-- a scumbled ground -->
    <h2 data-oil-text>Sign in</h2>                   <!-- the letters too -->
    <input v-oil="{ pigment: 'burnt umber', pad: 3 }" type="email" />
    <button v-oil="'alizarin crimson'">Sign in</button>
  </article>
</OilSurface>
```

`v-oil` marks an element. The surface measures where CSS put it, draws its
surface — a slab of that pigment, combed with bristle furrows and laid with a
wobbled edge — and **deposits it into the pigment field**. It is not composited
over the canvas. From that moment the component's surface *is* paint: the cursor
drags it, it mixes with whatever it is dragged into, it bleeds at its own edges,
and its thickness catches the light. Nothing downstream knows a control was
involved. The attribute is the real contract, so plain `data-oil="viridian"`
works without the directive.

Components keep no background, border or shadow of their own — the paint is all
three. The surface watches its slot, so components that appear, move or resize
are found and laid again. Without `bare` the canvas starts as a seeded painting
and the components are laid into it, mixing with what is already there.

**Lettering.** `data-oil-text` puts an element's glyphs into the paint as well,
so a stroke drags the letters like anything else. The browser has already done
the line breaking and the font fallback, so the painter asks it where each glyph
landed rather than redoing any of that; the text stays in the DOM, selectable
and read out as text, and only the browser's own copy of the glyphs is hidden.

It is opt-in because of a hard limit: paint lives on a grid of a few hundred
cells, two or three screen pixels each. Type below roughly 24px has fewer cells
of x-height than it has strokes and comes out as mush. This is for display type
— a heading, a wordmark. The small print is better left crisp, and an editable
field's contents have to be, or you cannot see what you type.

**Where the line falls.** A card's *surface* is paint, so the pointer passes
through it and a stroke can cross it. Its *controls* take their events back, so
the form still works. The DOM keeps focus order, keyboard, screen readers and
selectable text; the canvas keeps material. Neither re-implements the other.

**Limits.** The slab is a rectangle the size of the element's box, so this suits
things shaped like cards, buttons and fields; it does not trace an arbitrary
silhouette. And paint that has been dragged off is gone — hence `relay()`, which
scrapes a bare canvas back to linen first so a fresh card does not stack on the
ghost of the smeared one. The login card exposes it as "re-lay the paint",
because that is the honest affordance for a surface you can smear.

**The one thing that had to be got right.** Alpha is not opacity here, it is how
much paint a pixel is worth. A furrow combed into a slab is *thinner*, not more
see-through. Getting that wrong punches a hole through every bristle mark.

## Shape

| | |
| --- | --- |
| `wasm/src/lib.rs` | the solver. Plain `cdylib`, no wasm-bindgen — scalars and linear memory are all a numeric core needs |
| `wasm/test.mjs` | asserts the physics: mixing, transport, settling, bleeding, and that nothing blows up |
| `src/sim/paintWorker.js` | owns the core, fixed timestep, ping-pong transferable frames |
| `src/render/renderer.js` | WebGL2 lighting |
| `src/render/quality.js` | tiers and the governor that moves between them |
| `src/components/OilCanvas.vue` | the component: pointer, resize, visibility, lifecycle |
| `src/components/OilSurface.vue` | the canvas plus a slot; lays `v-oil` elements into the paint |
| `src/ui/oil.js` | the `v-oil` directive — it only marks an element |
| `src/components/OilCard.vue` | a worked example: an `<article>` that asked for paint |
| `src/ui/paint.js` | what a component's surface looks like: slabs with combed furrows |
| `src/pages/` | the two pages; `App.vue` routes on the hash |

## Being a good guest on the machine

The simulation grid, render resolution and shader detail come from a tier the
governor picks from the frame times it actually measures, starting from a guess
based on cores, memory and screen density. Frames cross to the main thread as
transferred buffers, so nothing is copied between threads. When the paint
settles and the cursor has been away for a moment, the worker stops its timer
entirely and the render loop shuts down with it — nothing on this canvas
animates on its own, so there is nothing to draw until you touch it again. A
hidden tab pauses both.

## Known edges

- Resizing past a tier boundary restarts the painting: the core has no
  resampler, and adding one to survive a window drag was not worth the code.
- A freshly worked canvas does not reach *exactly* zero flow — a few cells
  chatter around the yield surface at well under a hundredth of a cell per
  step. The worker treats that as rest rather than chasing it.

## License

MIT — Alex Mkwizu <alexgmkwizu@gmail.com>. See [LICENSE](LICENSE).
