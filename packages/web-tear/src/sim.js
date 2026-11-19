// Loader for the cloth sim we compile ourselves (wasm/src/lib.rs -> wasm32).
// There is no bindgen here: the exports are plain C ABI and we read the sheet
// buffers straight out of linear memory.
//
// Views must be re-taken whenever wasm memory grows, because growing swaps the
// underlying ArrayBuffer and detaches every view onto the old one.

// Mirrors the index order in set_param/get_param in wasm/src/lib.rs.
export const PARAM_NAMES = [
  'gravity', 'drag', 'stiffness', 'shear', 'bend', 'bounce', 'iterations',
  'tearBase', 'yieldStrain', 'damageRate', 'damageSpread', 'propagateEase',
  'nucleate', 'loadToAdvance', 'breakBudget', 'anchor', 'anchorMass',
  'gripFollow', 'gripSupport', 'drapePx', 'wakeStrain', 'sleepV2',
  'sleepSteps', 'dropAt',
]

export async function loadSim(source) {
  let instance
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    ;({ instance } = await WebAssembly.instantiate(source, {}))
  } else if (typeof source === 'string' && typeof fetch === 'function') {
    ;({ instance } = await WebAssembly.instantiateStreaming(fetch(source), {}))
  } else {
    throw new Error('loadSim needs a wasm URL or bytes')
  }

  const w = instance.exports
  let buffer = null
  let f32, u32

  const views = () => {
    if (buffer !== w.memory.buffer) {
      buffer = w.memory.buffer
      f32 = new Float32Array(buffer)
      u32 = new Uint32Array(buffer)
    }
  }

  // Live material tunables: read or assign them like ordinary properties, e.g.
  // sim.params.bounce = 1.3, and the running simulation picks them up.
  const params = {}
  PARAM_NAMES.forEach((name, i) => {
    Object.defineProperty(params, name, {
      enumerable: true,
      get: () => w.get_param(i),
      set: (v) => w.set_param(i, +v),
    })
  })

  return {
    exports: w,
    params,
    resetParams: () => w.reset_params(),
    dropped: (id) => w.dropped(id) !== 0,
    setTearable: (id, on) => w.set_tearable(id, on ? 1 : 0),
    intact: (id) => w.intact(id),
    clearAll: () => w.clear_all(),
    create: (width, height, spacing, seed) => w.create(width, height, spacing, seed >>> 0),
    update: (id, dt) => w.update(id, dt),
    grab: (id, x, y, r) => w.grab(id, x, y, r),
    moveGrip: (id, handle, x, y) => w.move_grip(id, handle, x, y),
    release: (id, handle) => w.release(id, handle),
    gripAttached: (id, handle) => w.grip_attached(id, handle) !== 0,
    hasMaterial: (id, x, y, r) => w.has_material(id, x, y, r) !== 0,
    coverage: (id) => w.coverage(id),
    awake: (id) => w.awake(id),
    nodeCount: (id) => w.node_count(id),
    moving: (id) => w.moving(id) !== 0,
    indexCount: (id) => w.index_count(id),
    indicesChanged: (id) => w.indices_changed(id) !== 0,
    indicesUploaded: (id) => w.indices_uploaded(id),

    // x,y,z, nx,ny,nz, edge per node
    packed(id) {
      views()
      const base = w.packed_ptr(id) >> 2
      return f32.subarray(base, base + w.packed_len(id))
    },
    uv(id) {
      views()
      const base = w.uv_ptr(id) >> 2
      return f32.subarray(base, base + w.uv_len(id))
    },
    indices(id) {
      views()
      const base = w.index_ptr(id) >> 2
      return u32.subarray(base, base + w.index_count(id))
    },
  }
}
