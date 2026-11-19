import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // relative, so the build runs from a subdirectory as happily as from a root
  base: './',
  plugins: [vue()],
})
