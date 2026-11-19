// What `npm install web-sand` gives you.
import { createSand as create } from './engine.js'
import wasm from './sand.wasm?url'

export { default as SandSurface } from './SandSurface.vue'
export { default as SandDistort } from './SandDistort.vue'
export { DEFAULTS } from './engine.js'

// Without Vue: the same engine the components drive, with its wasm already
// wired. Pass `wasm` (a URL or bytes) to serve it from somewhere else.
export const createSand = (container, options) => create(container, { wasm, ...options })
