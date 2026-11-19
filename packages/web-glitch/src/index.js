// What `npm install web-glitch` gives you.
import { createGlitch as create } from './engine.js'
import wasm from './sim/glitch-core.wasm?url'

export { default as GlitchSurface } from './components/GlitchSurface.vue'
export { DEFAULTS } from './engine.js'
export { STYLES } from './sim/params.js'

// Without Vue: the same engine the component drives, with its wasm already
// wired. Pass `wasm` to serve it from somewhere else.
// ponytail: the solver runs on the main thread — a step is a few thousand
// cells of integer hashing. Move it to a worker if a profile ever disagrees.
export const createGlitch = (element, options) => create(element, { wasm, ...options })
