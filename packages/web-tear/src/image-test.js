import { createApp, h } from 'vue'
import TestPage from './TestPage.vue'
import { imageLayers } from './test-layers'
import './style.css'

createApp({
  render: () => h(TestPage, {
    layers: imageLayers,
    title: 'image tear test',
    hint: 'pull hard through the photograph',
    here: 'image',
  }),
}).mount('#app')
