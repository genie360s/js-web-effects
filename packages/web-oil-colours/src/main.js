import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import { vOil } from './ui/oil'

createApp(App).directive('oil', vOil).mount('#app')
