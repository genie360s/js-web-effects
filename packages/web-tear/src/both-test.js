import { createApp, h } from 'vue'
import TestPage from './TestPage.vue'
import { bothLayers } from './test-layers'
import './style.css'

createApp({
  render: () => h(TestPage, {
    layers: bothLayers,
    title: 'image over video',
    hint: 'tear the photograph to reach the video',
    here: 'both',
  }),
}).mount('#app')
