import { createApp, h } from 'vue'
import TestPage from './TestPage.vue'
import './style.css'

createApp({
  render: () => h(TestPage, {
    kind: 'login',
    title: 'login test',
    hint: 'type in it, then drag the stick across it',
  }),
}).mount('#app')
