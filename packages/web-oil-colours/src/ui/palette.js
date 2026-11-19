// The studio palette, sRGB 0..1. The same ten pigments the core lays down, so
// a swatch and the paint under it are the same material.
export const PALETTE = [
  { name: 'titanium white', rgb: [0.961, 0.957, 0.933] },
  { name: 'cadmium yellow', rgb: [0.988, 0.761, 0.078] },
  { name: 'cadmium red', rgb: [0.871, 0.188, 0.125] },
  { name: 'alizarin crimson', rgb: [0.549, 0.078, 0.173] },
  { name: 'ultramarine', rgb: [0.125, 0.173, 0.549] },
  { name: 'cerulean', rgb: [0.094, 0.486, 0.698] },
  { name: 'viridian', rgb: [0.047, 0.431, 0.361] },
  { name: 'yellow ochre', rgb: [0.776, 0.557, 0.157] },
  { name: 'burnt umber', rgb: [0.337, 0.204, 0.141] },
  { name: 'ivory black', rgb: [0.102, 0.094, 0.102] },
]

/** A pigment as a CSS colour. */
export const css = (rgb, alpha = 1) =>
  `rgb(${rgb.map((c) => Math.round(c * 255)).join(' ')} / ${alpha})`
