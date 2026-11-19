import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  // relative, so the build runs from a subdirectory as happily as from a root
  base: './',
  plugins: [vue()],
  worker: { format: 'es' },
  assetsInclude: ['**/*.wasm'],
})
