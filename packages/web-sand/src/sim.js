// Loader for the sand sim we compile ourselves (wasm/src/lib.rs -> wasm32).
// There is no bindgen here: the exports are plain C ABI and the packed texels
// are read straight out of linear memory.
//
// Views must be re-taken whenever wasm memory grows, because growing swaps the
// underlying ArrayBuffer and detaches every view onto the old one.
//
// Copyright (c) 2026 Alex Mkwizu <alexgmkwizu@gmail.com> — MIT.

// Mirrors the INFO_* indices in wasm/src/lib.rs.
const INFO_ACTIVE = 4
const INFO_LEN = 5
// Half-floats per cell in the packed texels: height, disturbance, drift x, drift y.
const CHANNELS = 4

const modules = new Map()

export async function loadSand(source) {
  if (typeof source === 'string') {
    let pending = modules.get(source)
    if (!pending) {
      pending = instantiateUrl(source).catch((err) => {
        modules.delete(source)
        throw err
      })
      modules.set(source, pending)
    }
    return wrap(await pending)
  }
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    const { instance } = await WebAssembly.instantiate(source, {})
    return wrap(instance.exports)
  }
  throw new TypeError('loadSand needs a wasm URL or bytes')
}

async function instantiateUrl(url) {
  if (WebAssembly.instantiateStreaming) {
    try {
      return (await WebAssembly.instantiateStreaming(fetch(url), {})).instance.exports
    } catch {
      // hosts that serve .wasm as application/octet-stream land here
    }
  }
  const res = await fetch(url)
  if (!res.ok) throw new Error(`sand: cannot load ${url} (HTTP ${res.status})`)
  return (await WebAssembly.instantiate(await res.arrayBuffer(), {})).instance.exports
}

function wrap(w) {
  return {
    // A grid of `width` x `height` cells. Everything below is a thin call into
    // wasm; the only bookkeeping here is re-taking the memory views.
    create(width, height) {
      const ptr = w.sand_create(width, height)
      if (!ptr) throw new Error(`sand: could not allocate a ${width}x${height} field`)

      let buffer = null
      let info = null
      let texels = null
      let alive = true

      const views = () => {
        if (buffer === w.memory.buffer) return
        buffer = w.memory.buffer
        info = new Uint32Array(buffer, w.sand_info(ptr), INFO_LEN)
        texels = new Uint16Array(buffer, w.sand_texels(ptr), width * height * CHANNELS)
      }
      views()

      return {
        width,
        height,
        // half-float RGBA per cell: height in cells, disturbance, drift x, drift y
        get texels() { return alive ? (views(), texels) : null },
        // [x0, y0, x1, y1] of what changed, in cells
        get dirty() { return alive ? (views(), info) : null },
        // false once the sand has stopped moving, drying and drifting
        get active() { return alive ? (views(), info[INFO_ACTIVE] === 1) : false },

        // `push` is how fast the stick is travelling, 0..1: it throws the spoil
        // forward and leaves drift behind to stir colour along.
        stroke(x0, y0, x1, y1, radius, depth, push) {
          if (alive) w.sand_stroke(ptr, x0, y0, x1, y1, radius, depth, push)
        },
        // true when the texels changed and need re-uploading
        step(dt) {
          return alive && w.sand_step(ptr, dt) === 1
        },
        setParams({ repose, recovery, disturbDecay, driftDecay, drag, passes }) {
          if (alive) w.sand_set_params(ptr, repose, recovery, disturbDecay, driftDecay, drag, passes)
        },
        reset() {
          if (alive) w.sand_reset(ptr)
        },
        // marks every cell for re-upload, for when the GPU texture is lost
        repack() {
          if (alive) w.sand_repack(ptr)
        },
        destroy() {
          if (!alive) return
          alive = false
          info = texels = buffer = null
          w.sand_destroy(ptr)
        },
      }
    },
  }
}
