import { createApp, h } from 'vue'
import TestPage from './TestPage.vue'
import { untearableLayers } from './test-layers'
import './style.css'

createApp({
  render: () => h(TestPage, {
    layers: untearableLayers,
    title: 'unbreakable page',
    hint: 'pull as hard as you like - it only folds',
    here: 'untearable',
  }),
}).mount('#app')
