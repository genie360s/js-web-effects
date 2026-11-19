import { createApp, h } from 'vue'
import TestPage from './TestPage.vue'
import './style.css'

createApp({
  render: () => h(TestPage, { kind: 'video', title: 'video test' }),
}).mount('#app')
