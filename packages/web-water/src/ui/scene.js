// The interface that lives under the water.
//
// These are real controls — they lay out, take hover and press states, and hit
// test — but they are never DOM. They are drawn into a canvas that the water
// shader samples as a submerged layer, so they refract, catch the caustics and
// take the green of the water exactly as the leaves on the bed do.
//
// Coordinates are CSS pixels throughout, which is what the pointer speaks.

/** Every widget's geometry and current state. */
export function createScene() {
  const widgets = [
    { id: 'panel', type: 'panel', title: 'water ui' },
    { id: 'caption', type: 'caption', text: 'controls, submerged' },

    { id: 'breeze', type: 'slider', label: 'breeze', value: 1, min: 0, max: 2 },
    { id: 'depth', type: 'slider', label: 'depth', value: 0.14, min: 0.04, max: 0.26 },
    { id: 'chop', type: 'toggle', label: 'surface chop', value: true },

    { id: 'stone', type: 'button', label: 'drop a stone' },
    { id: 'bed', type: 'button', label: 'new bed' },
  ]

  const byId = Object.fromEntries(widgets.map((w) => [w.id, w]))
  let hover = null
  let active = null

  /** Place everything for a viewport. Returns the panel's bounds. */
  function layout(vw, vh) {
    const w = Math.min(430, vw - 48)
    const pad = 26
    const x = Math.round(vw / 2 - w / 2)
    // Sit a little above centre: the lower half of the frame is where the
    // pointer does most of its work, and the panel should not be in the way.
    let y = Math.round(vh * 0.5 - 168)

    const p = byId.panel
    p.x = x
    p.y = y
    p.w = w

    let cy = y + pad + 6
    p.titleAt = { x: x + pad, y: cy + 20 }
    cy += 40

    byId.caption.x = x + pad
    byId.caption.y = cy + 8
    byId.caption.w = w - pad * 2
    cy += 34

    for (const id of ['breeze', 'depth']) {
      const s = byId[id]
      s.x = x + pad
      s.y = cy
      s.w = w - pad * 2
      s.h = 34
      s.trackY = cy + 24
      cy += 52
    }

    const t = byId.chop
    t.x = x + pad
    t.y = cy
    t.w = w - pad * 2
    t.h = 30
    cy += 46

    const gap = 12
    const bw = (w - pad * 2 - gap) / 2
    byId.stone.x = x + pad
    byId.bed.x = x + pad + bw + gap
    for (const id of ['stone', 'bed']) {
      const b = byId[id]
      b.y = cy
      b.w = bw
      b.h = 42
    }
    cy += 42 + pad

    p.h = cy - y
    return { x: p.x, y: p.y, w: p.w, h: p.h }
  }

  /** Interactive widget under a point, or null. */
  function hitTest(px, py) {
    for (const wgt of widgets) {
      if (wgt.type === 'panel' || wgt.type === 'caption') continue
      const box = hitBox(wgt)
      if (px >= box.x && px <= box.x + box.w && py >= box.y && py <= box.y + box.h) return wgt
    }
    return null
  }

  /** Sliders take a taller grab area than they draw — thin tracks are fiddly. */
  function hitBox(wgt) {
    if (wgt.type === 'slider') return { x: wgt.x - 8, y: wgt.trackY - 16, w: wgt.w + 16, h: 32 }
    return { x: wgt.x, y: wgt.y, w: wgt.w, h: wgt.h }
  }

  /** Value a slider would take if grabbed at this x. */
  function valueAt(wgt, px) {
    const t = Math.min(Math.max((px - wgt.x) / wgt.w, 0), 1)
    return wgt.min + (wgt.max - wgt.min) * t
  }

  /** The area a widget's paint touches, including its shadow. */
  function damage(wgt) {
    const box = hitBox(wgt)
    const bleed = 14
    return {
      x: Math.floor(box.x - bleed),
      y: Math.floor(box.y - bleed),
      w: Math.ceil(box.w + bleed * 2),
      h: Math.ceil(box.h + bleed * 2),
    }
  }

  return {
    widgets,
    byId,
    layout,
    hitTest,
    hitBox,
    valueAt,
    damage,
    get hover() {
      return hover
    },
    set hover(v) {
      hover = v
    },
    get active() {
      return active
    },
    set active(v) {
      active = v
    },
  }
}
