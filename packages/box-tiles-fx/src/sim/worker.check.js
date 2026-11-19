// The worker, for real: `node src/sim/worker.check.js`
//
// The solver has its tests and the engine has the browser; this is the seam
// between them — the message protocol, run against the actual worker file
// under Node's worker_threads with the actual wasm. It asserts the things
// the engine relies on and nothing else checks: that `ready` comes back
// with the grid it asked for, that frames stop when the two buffers are
// not returned and start again when they are, that a settled grid goes
// quiet and a stroke wakes it, that a resize changes the frame size and an
// old buffer is not reused, that pause means pause.
//
// Copyright (c) 2026 Alex Mkwizu <alexgmkwizu@gmail.com> — MIT.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { PARAM_INDEX } from './params.js'

const wasm = readFileSync(new URL('./tiles-core.wasm', import.meta.url))
const worker = new Worker(new URL('./tileWorker.js', import.meta.url))

// Every message lands in a queue; tests pull what they are waiting for.
const inbox = []
const waiters = []
worker.on('message', (msg) => {
  inbox.push(msg)
  for (const w of waiters.splice(0)) w()
})
worker.on('error', (err) => { throw err })

/** The first queued message matching `pick`, waiting up to `ms`. */
function next(pick, ms = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${pick.toString()}`)), ms)
    const look = () => {
      const i = inbox.findIndex(pick)
      if (i < 0) return waiters.push(look)
      clearTimeout(timer)
      resolve(inbox.splice(i, 1)[0])
    }
    look()
  })
}
const ofType = (type) => (m) => m.type === type
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const countFrames = () => inbox.filter(ofType('frame')).length
const dropFrames = () => { for (let i = inbox.length - 1; i >= 0; i--) if (inbox[i].type === 'frame') inbox.splice(i, 1) }
const recycle = (buffer) => worker.postMessage({ type: 'recycle', buffer }, [buffer])

function half(u) {
  const e = (u >> 10) & 0x1f
  const m = u & 0x3ff
  const s = u & 0x8000 ? -1 : 1
  if (e === 0) return s * 2 ** -14 * (m / 1024)
  return s * 2 ** (e - 15) * (1 + m / 1024)
}
const activeIn = (frame) => {
  const t = new Uint16Array(frame.buffer)
  let n = 0
  for (let i = 0; i < frame.w * frame.h; i++) {
    if (half(t[i * 4]) || half(t[i * 4 + 1]) || half(t[i * 4 + 2])) n++
  }
  return n
}

// --- init: a refused grid says so, a good one says ready -------------------

worker.postMessage({ type: 'init', wasm: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength), w: 1, h: 1 })
const refused = await next(ofType('error'))
assert.match(refused.message, /refused a 1x1 grid/)

const W = 32
const H = 18
worker.postMessage({ type: 'init', w: W, h: H, params: { [PARAM_INDEX.rate]: 0 }, seed: 5 })
const ready = await next(ofType('ready'))
assert.deepEqual([ready.w, ready.h], [W, H], 'ready must report the grid it built')

// --- a quiet grid sends nothing ------------------------------------------

await wait(250)
assert.equal(countFrames(), 0, 'a grid with nothing happening sent frames')

// --- a stroke wakes it, and the frames are the right shape -----------------

worker.postMessage({ type: 'pulse', x: 10, y: 8, radius: 3, strength: 4 })
const woke = await next((m) => m.type === 'idle' && m.idle === false)
assert.ok(woke)
const first = await next(ofType('frame'))
assert.deepEqual([first.w, first.h], [W, H])
assert.equal(first.buffer.byteLength, W * H * 4 * 2, 'four half floats a cell')
assert.ok(typeof first.active === 'number')
const second = await next(ofType('frame'))

// --- two buffers, and no more until they come back -------------------------

await wait(200)
assert.equal(countFrames(), 0, 'the worker sent a frame it had no buffer for')
recycle(first.buffer)
recycle(second.buffer)
const third = await next(ofType('frame'))
assert.ok(activeIn(third) > 0 || third.active > 0, 'nothing popped under the stroke')
recycle(third.buffer)

// --- it keeps the display rate, roughly, while busy ------------------------
// Return every buffer promptly and count what arrives in a third of a second.

{
  dropFrames()
  let got = 0
  const until = Date.now() + 330
  while (Date.now() < until) {
    const f = await next(ofType('frame'), 500).catch(() => null)
    if (!f) break
    got++
    recycle(f.buffer)
  }
  assert.ok(got >= 8 && got <= 40, `${got} frames in a third of a second`)
}

// --- and settles, sending one last frame ----------------------------------

{
  const slept = await next((m) => m.type === 'idle' && m.idle === true, 4000)
  assert.ok(slept)
  // Drain what is in flight and return it, then nothing more should come.
  await wait(100)
  const tail = inbox.filter(ofType('frame'))
  dropFrames()
  for (const f of tail) recycle(f.buffer)
  await wait(250)
  assert.equal(countFrames(), 0, 'a settled grid kept sending frames')
}

// --- a parameter change can wake it, and a reset puts it down ---------------

worker.postMessage({ type: 'params', patch: { [PARAM_INDEX.rate]: 2 } })
await next((m) => m.type === 'idle' && m.idle === false)
{
  const f = await next(ofType('frame'))
  recycle(f.buffer)
}
worker.postMessage({ type: 'params', patch: { [PARAM_INDEX.rate]: 0 } })
worker.postMessage({ type: 'reset' })
{
  const f = await next(ofType('frame'))
  assert.equal(activeIn(f), 0, 'a reset frame should be clean')
  recycle(f.buffer)
}
await next((m) => m.type === 'idle' && m.idle === true, 4000)
await wait(100)
for (const f of inbox.filter(ofType('frame'))) recycle(f.buffer)
dropFrames()

// --- resize: new shape, and an old buffer is swapped out -------------------

const W2 = 20
const H2 = 12
worker.postMessage({ type: 'resize', w: W2, h: H2, params: { [PARAM_INDEX.rate]: 0 }, seed: 5 })
// A stale buffer from the old grid: must be replaced, not reused.
recycle(new ArrayBuffer(W * H * 4 * 2))
worker.postMessage({ type: 'beat', strength: 3 })
{
  const f = await next(ofType('frame'))
  assert.deepEqual([f.w, f.h], [W2, H2], 'frames after a resize must be the new shape')
  assert.equal(f.buffer.byteLength, W2 * H2 * 4 * 2)
  recycle(f.buffer)
  const g = await next(ofType('frame'))
  assert.equal(g.buffer.byteLength, W2 * H2 * 4 * 2, 'the stale buffer was reused')
  recycle(g.buffer)
}

// --- pause means pause -----------------------------------------------------

worker.postMessage({ type: 'pause', paused: true })
await wait(60)
for (const f of inbox.filter(ofType('frame'))) recycle(f.buffer)
dropFrames()
await wait(250)
assert.equal(countFrames(), 0, 'a paused worker sent frames')
worker.postMessage({ type: 'pause', paused: false })
worker.postMessage({ type: 'beat', strength: 3 })
{
  const f = await next(ofType('frame'))
  recycle(f.buffer)
}

// --- the same seed, the same tiles: reseed is deterministic ----------------
// Frames from before the message may still be in flight, so each step waits,
// takes the newest frame, and hands every buffer back.

async function lotsAfter(message) {
  worker.postMessage(message)
  await wait(150)
  const frames = inbox.filter(ofType('frame'))
  dropFrames()
  assert.ok(frames.length > 0, `no frame after ${message.type}`)
  const lots = Array.from(new Uint16Array(frames[frames.length - 1].buffer)).filter((_, i) => i % 4 === 3)
  for (const f of frames) recycle(f.buffer)
  return lots
}
worker.postMessage({ type: 'reset' })
const lotsA = await lotsAfter({ type: 'reseed', seed: 77 })
const lotsB = await lotsAfter({ type: 'reseed', seed: 78 })
const lotsC = await lotsAfter({ type: 'reseed', seed: 77 })
assert.notDeepEqual(lotsA, lotsB, 'a different seed must deal a different lottery')
assert.deepEqual(lotsA, lotsC, 'the same seed must deal the same lottery')

await worker.terminate()
console.log('worker ok')
