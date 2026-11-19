import { createApp, h } from 'vue'
import TestPage from './TestPage.vue'
import './style.css'

createApp({
  render: () => h(TestPage, { kind: 'text', title: 'text test' }),
}).mount('#app')
