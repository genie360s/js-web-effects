import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// The library build, shared by every package and run from the package's own
// directory (`npm run build:lib`). The demo site keeps the package's own
// vite.config.js and builds to dist/; this builds what npm ships, to lib/.
//
// What ships is two files: index.js and style.css. The wasm travels inside
// index.js as a data URL (library mode inlines assets), and the worker has to
// travel the same way: emitted as its own file it is referenced by a path
// that only exists in this repo's build, not in the app that installs it.
const inlineWorkers = {
  name: 'inline-workers',
  enforce: 'pre',
  resolveId(source, importer, options) {
    if (source.endsWith('?worker')) {
      return this.resolve(source + '&inline', importer, { ...options, skipSelf: true })
    }
  },
}

export default defineConfig({
  plugins: [inlineWorkers, vue()],
  publicDir: false,
  worker: { format: 'es' },
  build: {
    outDir: 'lib',
    lib: { entry: 'src/index.js', formats: ['es'], fileName: 'index', cssFileName: 'style' },
    rollupOptions: { external: ['vue'] },
  },
})
