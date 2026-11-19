import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  base: './',
  plugins: [vue()],
  build: {
    rollupOptions: {
      // the hero, plus a page each for text, a login card, colour, an image
      // and a video — one screen of beach per page
      input: {
        index: 'index.html',
        text: 'text.html',
        distortion: 'text-distortion.html',
        login: 'login.html',
        colour: 'colour.html',
        image: 'image.html',
        video: 'video.html',
      },
    },
  },
})
