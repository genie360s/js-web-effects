// What `npm install web-fire` gives you.
import { createFire as create } from './engine.js'
import wasm from './sim/fire-core.wasm?url'
import FireWorker from './sim/fireWorker.js?worker'

export { default as FireSurface } from './components/FireSurface.vue'
export { default as FireLayer } from './components/FireLayer.vue'
export { DEFAULTS } from './engine.js'

// Without Vue: the same engine the components drive, with its wasm and worker
// already wired. Pass `wasm` or `worker` to serve them from somewhere else.
export const createFire = (container, options) =>
  create(container, { wasm, worker: () => new FireWorker(), ...options })
