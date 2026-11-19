import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  base: './',
  plugins: [vue()],
  build: {
    rollupOptions: {
      // the site, plus a test page each for tearing an image and a video
      input: {
        index: 'index.html',
        image: 'image.html',
        video: 'video.html',
        both: 'both.html',
        untearable: 'untearable.html',
      },
    },
  },
})
