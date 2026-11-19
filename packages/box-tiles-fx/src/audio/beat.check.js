// The onset detector against a signal we know the answer to:
// `node src/audio/beat.check.js`
//
// A kick every half second, over a noise floor, at 60 frames a second. Every
// kick must be found within a frame of where it was put, nothing must be
// found between them, and silence must find nothing at all.
//
// Copyright (c) 2026 Alex Mkwizu <alexgmkwizu@gmail.com> — MIT.

import assert from 'node:assert/strict'
import { createOnsetDetector, bandEnergy } from './beat.js'

// Deterministic noise, so the check is the same check every time.
let seed = 12345
const noise = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return seed / 2 ** 32
}

const FPS = 60
const FRAME = 1000 / FPS

/** `seconds` of signal with a kick every `periodMs`, decaying over 4 frames. */
function track(seconds, periodMs, floor = 0.12, kick = 0.9) {
  const frames = []
  const kicks = []
  for (let i = 0; i < seconds * FPS; i++) {
    const t = i * FRAME
    let e = floor + (noise() - 0.5) * 0.05
    const sinceKick = t % periodMs
    if (sinceKick < FRAME * 4) {
      if (sinceKick < FRAME) kicks.push(i)
      e += kick * (1 - sinceKick / (FRAME * 4))
    }
    frames.push(e)
  }
  return { frames, kicks }
}

function detect(frames, options) {
  const d = createOnsetDetector(options)
  const found = []
  const strengths = []
  frames.forEach((e, i) => {
    const r = d.feed(e, i * FRAME)
    if (r.beat) {
      found.push(i)
      strengths.push(r.strength)
    }
    assert.ok(r.level >= 0 && r.level <= 1, `level ${r.level} out of range`)
    assert.ok(r.strength >= 0 && r.strength <= 1, `strength ${r.strength} out of range`)
  })
  return { found, strengths }
}

// --- every kick, and only the kicks ----------------------------------------

{
  const { frames, kicks } = track(10, 500)
  const { found, strengths } = detect(frames)
  // The first half-window is warm-up and may miss; after that, nothing may.
  const expected = kicks.filter((i) => i > 30)
  for (const k of expected) {
    assert.ok(found.some((f) => Math.abs(f - k) <= 1), `missed the kick at frame ${k}`)
  }
  for (const f of found) {
    assert.ok(kicks.some((k) => Math.abs(f - k) <= 1), `false beat at frame ${f}`)
  }
  assert.ok(strengths.every((s) => s >= 0.25), 'a found beat is never weaker than a nudge')
  assert.ok(strengths.some((s) => s > 0.8), 'a kick this far over the floor should hit hard')
}

// --- silence, and a steady tone, are not beats ----------------------------

{
  const silence = new Array(600).fill(0)
  assert.equal(detect(silence).found.length, 0, 'silence had beats in it')
  const hum = new Array(600).fill(0.5)
  assert.equal(detect(hum).found.length, 0, 'a steady tone had beats in it')
  const steady = Array.from({ length: 600 }, () => 0.3 + (noise() - 0.5) * 0.04)
  assert.equal(detect(steady).found.length, 0, 'gentle noise had beats in it')
}

// --- one kick is one beat ---------------------------------------------------

{
  // A long kick that stays loud for 20 frames must not fire 20 times.
  const frames = new Array(300).fill(0.1)
  for (let i = 100; i < 120; i++) frames[i] = 0.95
  const { found } = detect(frames)
  assert.equal(found.length, 1, `a sustained hit fired ${found.length} times`)
  assert.equal(found[0], 100)
}

// --- a quieter track still finds its beats ---------------------------------

{
  const { frames, kicks } = track(6, 400, 0.04, 0.25)
  const { found } = detect(frames)
  const expected = kicks.filter((i) => i > 30)
  const hit = expected.filter((k) => found.some((f) => Math.abs(f - k) <= 1)).length
  assert.ok(hit >= expected.length - 1, `quiet track: found ${hit} of ${expected.length}`)
}

// --- garbage in, nothing out ----------------------------------------------

{
  const d = createOnsetDetector()
  for (const bad of [NaN, Infinity, -1, 5, undefined]) {
    const r = d.feed(bad, 0)
    assert.equal(r.beat, false)
    assert.ok(Number.isFinite(r.level) && Number.isFinite(r.strength))
  }
  d.reset()
  assert.equal(d.feed(1, 0).beat, false, 'a beat on the very first frame is noise, not music')
}

// --- band energy ------------------------------------------------------------

{
  const bins = new Uint8Array(512)
  bins.fill(255, 0, 5) // bins 0..4 cover 30..150 Hz at 44.1k / 1024 (43 Hz a bin)
  assert.ok(Math.abs(bandEnergy(bins, 44100, 1024, 30, 150) - 1) < 1e-9, 'a full low band is 1')
  assert.equal(bandEnergy(bins, 44100, 1024, 5000, 8000), 0, 'an empty band is 0')
  assert.equal(bandEnergy(bins, 44100, 1024, 8000, 5000), 0, 'a backwards band is 0, not NaN')
}

console.log('beat ok')
