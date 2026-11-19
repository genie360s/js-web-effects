import { createApp, h } from 'vue'
import TestPage from './TestPage.vue'
import { videoLayers } from './test-layers'
import './style.css'

createApp({
  render: () => h(TestPage, {
    layers: videoLayers,
    title: 'video tear test',
    hint: 'pull hard through the playing video',
    here: 'video',
  }),
}).mount('#app')
