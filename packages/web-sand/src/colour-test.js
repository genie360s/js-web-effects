import { createApp, h } from 'vue'
import TestPage from './TestPage.vue'
import './style.css'

createApp({
  render: () => h(TestPage, {
    kind: 'colour',
    title: 'colour test',
    hint: 'stir through the swatches',
  }),
}).mount('#app')
