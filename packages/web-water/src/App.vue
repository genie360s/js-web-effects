<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import PondPage from './pages/PondPage.vue'
import WaterUiPage from './pages/WaterUiPage.vue'

// Two pages do not need a router. The hash is the route.
const PAGES = [
  { id: 'pond', label: 'pond', component: PondPage },
  { id: 'water-ui', label: 'water ui', component: WaterUiPage },
]

const route = ref(read())

function read() {
  const id = location.hash.replace(/^#\/?/, '')
  return PAGES.some((p) => p.id === id) ? id : 'pond'
}

function go(id) {
  location.hash = `#/${id}`
}

const current = computed(() => PAGES.find((p) => p.id === route.value).component)

function onHash() {
  route.value = read()
}

onMounted(() => window.addEventListener('hashchange', onHash))
onBeforeUnmount(() => window.removeEventListener('hashchange', onHash))
</script>

<template>
  <main class="app">
    <!-- Keyed so each page gets a clean surface, worker and bed of its own. -->
    <component :is="current" :key="route" />

    <nav class="nav">
      <button
        v-for="p in PAGES"
        :key="p.id"
        :class="{ on: route === p.id }"
        @click="go(p.id)"
      >
        {{ p.label }}
      </button>
    </nav>
  </main>
</template>

<style scoped>
.app {
  position: fixed;
  inset: 0;
  overflow: hidden;
}

.nav {
  position: absolute;
  left: clamp(1.5rem, 4vw, 3.5rem);
  bottom: clamp(1.25rem, 3vh, 2.25rem);
  display: flex;
  gap: 0.35rem;
  padding: 0.3rem;
  border-radius: 0.7rem;
  border: 1px solid rgba(226, 240, 214, 0.12);
  background: rgba(14, 22, 14, 0.4);
  backdrop-filter: blur(14px) saturate(1.1);
  -webkit-backdrop-filter: blur(14px) saturate(1.1);
}

.nav button {
  font: inherit;
  font-size: 0.75rem;
  letter-spacing: 0.08em;
  padding: 0.3rem 0.7rem;
  border: none;
  border-radius: 0.45rem;
  background: transparent;
  color: rgba(232, 242, 224, 0.6);
  cursor: pointer;
  transition: background 0.18s ease, color 0.18s ease;
}

.nav button:hover {
  color: rgba(244, 250, 238, 0.95);
}

.nav button.on {
  background: rgba(150, 214, 170, 0.18);
  color: rgba(226, 250, 232, 0.98);
}
</style>
