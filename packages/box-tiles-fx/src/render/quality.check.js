// The governor and the grid arithmetic, without a browser:
// `node src/render/quality.check.js`
//
// The governor is the one piece of logic that runs on every frame of every
// page and never shows itself; a bug in it is a page that is slower than it
// needs to be, forever, with nothing on screen to say why.
//
// Copyright (c) 2026 Alex Mkwizu <alexgmkwizu@gmail.com> — MIT.

import assert from 'node:assert/strict'
import { createGovernor, gridFor, pixelsFor, detectTier, TIERS, ORDER } from './quality.js'

// --- it demotes under sustained load, and not before ----------------------

{
  const changes = []
  const g = createGovernor((tier, reason) => changes.push([tier, reason]), 'high')
  for (let i = 0; i < 40; i++) g.sample(16.7)
  assert.equal(g.tier, 'high')
  // One bad frame proves nothing.
  g.sample(120)
  for (let i = 0; i < 40; i++) g.sample(16.7)
  assert.equal(changes.length, 0, 'a single slow frame must not demote')
  // Fifty bad ones do.
  for (let i = 0; i < 120; i++) g.sample(33)
  assert.deepEqual(changes[0], ['medium', 'slow'])
  assert.equal(g.tier, 'medium')
}

// --- it climbs back after a comfortable stretch, until knocked down twice --

{
  const changes = []
  const g = createGovernor((tier, reason) => changes.push([tier, reason]), 'low')
  for (let i = 0; i < 700; i++) g.sample(16.7)
  assert.deepEqual(changes[0], ['medium', 'headroom'])
}

{
  const changes = []
  const g = createGovernor((tier, reason) => changes.push([tier, reason]), 'ultra')
  // Each demotion takes ~45 slow frames plus a 90-frame cooldown: 290 frames
  // is two of them and not quite three.
  for (let i = 0; i < 290; i++) g.sample(40)
  const demoted = changes.filter(([, why]) => why === 'slow').length
  assert.equal(demoted, 2, `should have been knocked down twice, was ${demoted}`)
  assert.equal(g.tier, 'medium')
  const before = changes.length
  for (let i = 0; i < 3000; i++) g.sample(10)
  const climbs = changes.slice(before).filter(([, why]) => why === 'headroom').length
  assert.equal(climbs, 0, `kept climbing after being knocked down twice: ${climbs} climbs`)
}

// --- it learns the display's cadence --------------------------------------
// 16.7ms frames are a 60Hz panel doing fine, and a 120Hz panel running at
// half speed. The same number has to be read two ways.

{
  const fast = []
  const g120 = createGovernor((tier, reason) => fast.push([tier, reason]), 'high')
  for (let i = 0; i < 400; i++) g120.sample(8.3)
  for (let i = 0; i < 200; i++) g120.sample(16.7)
  assert.ok(fast.some(([, why]) => why === 'slow'), 'a 120Hz panel dropping to 60fps is slow')

  const steady = []
  const g60 = createGovernor((tier, reason) => steady.push([tier, reason]), 'high')
  for (let i = 0; i < 600; i++) g60.sample(16.7)
  assert.ok(!steady.some(([, why]) => why === 'slow'), 'a 60Hz panel at 60fps is not slow')
}

// --- a pinned tier is a pinned tier ---------------------------------------

{
  const changes = []
  const g = createGovernor((tier, reason) => changes.push([tier, reason]), 'medium')
  g.setManual('ultra')
  assert.equal(g.tier, 'ultra')
  assert.equal(g.auto, false)
  for (let i = 0; i < 500; i++) g.sample(60)
  assert.equal(g.tier, 'ultra', 'the governor overruled a manual tier')
  g.setManual(null)
  assert.equal(g.auto, true)
  assert.throws(() => g.setManual('potato'))
  // Garbage samples are ignored, not averaged.
  g.sample(NaN)
  g.sample(-5)
  g.sample(10000)
  assert.ok(Number.isFinite(g.fps))
}

// --- the grid ---------------------------------------------------------------

{
  const g = gridFor(40, 1920, 1080)
  assert.deepEqual([g.w, g.h], [48, 27])
  assert.equal(g.px, 40)
  const odd = gridFor(40, 1000, 700)
  assert.deepEqual([odd.w, odd.h], [25, 18], 'a partial cell at the edge is still a cell')
  assert.ok(Math.abs(odd.across - 25) < 1e-9 && Math.abs(odd.down - 17.5) < 1e-9)
  const tiny = gridFor(1, 4000, 2000)
  assert.ok(tiny.w <= 512 && tiny.h <= 512, 'a cell too small for the solver must be made bigger')
  assert.ok(tiny.px > 1)
  const small = gridFor(500, 300, 200)
  assert.ok(small.w >= 2 && small.h >= 2, 'a cell bigger than the box still gives a grid')
}

// --- pixels and tiers -------------------------------------------------------

{
  for (const tier of ORDER) {
    assert.ok(tier in TIERS)
    const p = pixelsFor(tier, 1000, 500)
    assert.ok(p.w >= 1 && p.h >= 1 && p.dpr >= 1)
    assert.ok(p.w <= 1000 * TIERS[tier].dpr && p.h <= 500 * TIERS[tier].dpr)
  }
  assert.ok(ORDER.includes(detectTier()), 'detection must work with no window at all')
}

console.log('quality ok')
