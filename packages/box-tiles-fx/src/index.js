// What `npm install box-tiles-fx` gives you.
import { createTiles as create } from './engine.js'
import wasm from './sim/tiles-core.wasm?url'
import TileWorker from './sim/tileWorker.js?worker'

export { default as TileSurface } from './components/TileSurface.vue'
export { default as TileLayer } from './components/TileLayer.vue'
export { DEFAULTS } from './engine.js'
export { attachAudio, createOnsetDetector } from './audio/beat.js'

// Without Vue: the same engine the components drive, with its wasm and worker
// already wired. Pass `wasm` or `worker` to serve them from somewhere else.
export const createTiles = (container, options) =>
  create(container, { wasm, worker: () => new TileWorker(), ...options })
