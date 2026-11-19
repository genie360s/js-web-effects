import { createApp, h } from 'vue'
import TestPage from './TestPage.vue'
import './style.css'

createApp({
  render: () => h(TestPage, {
    kind: 'distortion',
    title: 'text distortion',
    hint: 'set how far the sand bends it',
  }),
}).mount('#app')
