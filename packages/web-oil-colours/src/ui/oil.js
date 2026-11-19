// `v-oil` — the directive that makes an ordinary element out of oil paint.
//
//   <button v-oil="'cadmium red'">save</button>
//   <article v-oil>a card</article>
//   <span v-oil="{ pigment: 'ultramarine', pad: 6 }">a pill</span>
//
// All it does is mark the element. The <OilSurface> it sits inside finds every
// marked element, measures where CSS put it, and lays a slab of paint under it
// in the canvas's interface layer. The attribute is the actual contract, so
// plain HTML with `data-oil="viridian"` works just as well as the directive —
// the directive exists so a value can be bound and change.
//
// What it cannot do: the slab is a rectangle the size of the element's box, so
// this suits things shaped like cards, buttons and pills. It does not trace an
// arbitrary silhouette.

function apply(el, value) {
  const v = typeof value === 'string' ? { pigment: value } : (value ?? {})
  const pigment = v.pigment ?? 'ground'
  const pad = v.pad == null ? '' : String(v.pad)
  // Compared against what is already on the element, not against the previous
  // binding: the bindings are object literals, so they are a fresh object on
  // every render and an identity check never short-circuits. The surface
  // watches this attribute, so a needless write costs a re-measure.
  if (el.dataset.oil !== pigment) el.dataset.oil = pigment
  if ((el.dataset.oilPad ?? '') === pad) return
  if (pad) el.dataset.oilPad = pad
  else delete el.dataset.oilPad
}

export const vOil = {
  mounted: (el, binding) => apply(el, binding.value),
  updated: (el, binding) => apply(el, binding.value),
}
