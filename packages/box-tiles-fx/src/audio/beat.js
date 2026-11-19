// Sound into tiles.
//
// Two halves. `createOnsetDetector` is pure: feed it the energy of a band once
// a frame and it says whether a beat just landed and how hard, judged against
// a short memory of what the music has been doing. `attachAudio` is the
// browser half: a media element or a microphone, an AnalyserNode, and a loop
// that feeds the detector and kicks the engine.
//
// Copyright (c) 2026 Alex Mkwizu <alexgmkwizu@gmail.com> — MIT.

/**
 * Energy-over-average onset detection, the classic one. An onset is a frame
 * whose energy stands clear above the recent mean, with a refractory period
 * so one kick drum is one beat and not six.
 *
 * @param {object} [o]
 * @param {number} [o.window=43]       frames of memory (~0.7 s at 60Hz)
 * @param {number} [o.threshold=1.4]   how far above the mean counts
 * @param {number} [o.floor=0.02]      energy below which nothing is a beat
 * @param {number} [o.minGapMs=110]    refractory period
 */
export function createOnsetDetector({ window = 43, threshold = 1.4, floor = 0.02, minGapMs = 110 } = {}) {
  const history = new Float32Array(window)
  let filled = 0
  let head = 0
  let sum = 0
  let lastBeatAt = -Infinity
  let level = 0
  let prev = 0

  return {
    /**
     * @param {number} energy  0..1, this frame
     * @param {number} now     ms
     * @returns {{beat: boolean, strength: number, level: number}}
     */
    feed(energy, now) {
      const e = Number.isFinite(energy) ? Math.min(Math.max(energy, 0), 1) : 0
      const mean = filled ? sum / filled : 0
      // A slow follower of the energy, for things that want a level rather
      // than a hit: it rises quickly and falls slowly.
      level += (e - level) * (e > level ? 0.5 : 0.08)

      // Loud, louder than the music has been, and *getting* louder: a note
      // held for half a second is one onset, not one every refractory period.
      const clear = e > floor && e > mean * threshold + floor * 0.5
      const rising = e - prev > floor * 0.5
      const rested = now - lastBeatAt >= minGapMs
      let beat = false
      let strength = 0
      if (clear && rising && rested && filled >= window / 2) {
        beat = true
        lastBeatAt = now
        // How far past the line it went, on a scale where "twice the mean" is
        // a solid hit. Never less than a nudge, never more than 1.
        strength = Math.min(1, Math.max(0.25, (e - mean) / Math.max(mean, floor)))
      }

      sum -= history[head]
      history[head] = e
      sum += e
      head = (head + 1) % window
      if (filled < window) filled++
      prev = e

      return { beat, strength, level }
    },
    reset() {
      history.fill(0)
      filled = 0
      head = 0
      sum = 0
      lastBeatAt = -Infinity
      level = 0
      prev = 0
    },
  }
}

/** Mean of the FFT bins between two frequencies, as 0..1. */
export function bandEnergy(bins, sampleRate, fftSize, lowHz, highHz) {
  const hzPerBin = sampleRate / fftSize
  const lo = Math.max(0, Math.floor(lowHz / hzPerBin))
  const hi = Math.min(bins.length - 1, Math.ceil(highHz / hzPerBin))
  if (hi < lo) return 0
  let sum = 0
  for (let i = lo; i <= hi; i++) sum += bins[i]
  return sum / ((hi - lo + 1) * 255)
}

const sources = new WeakMap()

/**
 * Listen to a media element or a MediaStream and drive an engine from it.
 *
 * Beats become `engine.beat(strength)`; the running level becomes
 * `engine.drive(level * drive)`. The AudioContext is created suspended if the
 * page has had no gesture yet; call `resume()` from a click.
 *
 * @param {{beat: Function, drive: Function}} engine
 * @param {HTMLMediaElement|MediaStream} source
 * @param {object} [o]
 * @param {[number, number]} [o.band=[30, 150]]  Hz; the kick lives here
 * @param {number} [o.drive=0.6]  how much the level excites the grid
 * @param {number} [o.gain=1]     multiplier on beat strength
 * @param {object} [o.detector]   options for createOnsetDetector
 */
export function attachAudio(engine, source, { band = [30, 150], drive = 0.6, gain = 1, detector } = {}) {
  const AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext
  if (!AudioContextCtor) throw new Error('tiles: Web Audio is not available')
  const context = new AudioContextCtor()
  const analyser = context.createAnalyser()
  analyser.fftSize = 1024
  analyser.smoothingTimeConstant = 0.3

  let node
  if (typeof MediaStream !== 'undefined' && source instanceof MediaStream) {
    node = context.createMediaStreamSource(source)
    node.connect(analyser)
  } else {
    // An element can only ever be wrapped once per document; a second call
    // for the same element has to reuse the node, so it is remembered.
    const known = sources.get(source)
    if (known && known.context.state !== 'closed') {
      known.detach()
    }
    node = context.createMediaElementSource(source)
    node.connect(analyser)
    // Wrapping an element silences it unless the graph reaches the speakers.
    analyser.connect(context.destination)
  }

  const onsets = createOnsetDetector(detector)
  const bins = new Uint8Array(analyser.frequencyBinCount)
  let rafId = 0
  let stopped = false
  let lastLevel = -1

  function loop(now) {
    if (stopped) return
    rafId = requestAnimationFrame(loop)
    if (context.state !== 'running') return
    analyser.getByteFrequencyData(bins)
    const energy = bandEnergy(bins, context.sampleRate, analyser.fftSize, band[0], band[1])
    const { beat, strength, level } = onsets.feed(energy, now)
    if (beat) engine.beat(strength * gain)
    const driven = Math.round(level * drive * 100) / 100
    if (driven !== lastLevel) {
      engine.drive(driven)
      lastLevel = driven
    }
  }
  rafId = requestAnimationFrame(loop)

  const handle = {
    context,
    analyser,
    onsets,
    /** Call from a user gesture; browsers keep audio silent until one. */
    resume: () => context.resume(),
    detach() {
      if (stopped) return
      stopped = true
      cancelAnimationFrame(rafId)
      engine.drive(0)
      try { node.disconnect() } catch { /* already gone */ }
      try { analyser.disconnect() } catch { /* already gone */ }
      context.close().catch(() => {})
      sources.delete(source)
    },
  }
  sources.set(source, handle)
  return handle
}
