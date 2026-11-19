<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import StudioPage from './pages/StudioPage.vue'
import OilUiPage from './pages/OilUiPage.vue'
import OilMediaPage from './pages/OilMediaPage.vue'

// Two pages do not need a router. The hash is the route.
const PAGES = [
  { id: 'studio', label: 'studio', component: StudioPage },
  { id: 'oil-colour-ui', label: 'oil colour ui', component: OilUiPage },
  { id: 'oil-media', label: 'image & video', component: OilMediaPage },
]

const route = ref(read())

function read() {
  const id = location.hash.replace(/^#\/?/, '')
  return PAGES.some((p) => p.id === id) ? id : 'studio'
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
    <!-- Keyed so each page gets a clean surface and worker of its own. -->
    <component :is="current" :key="route" />

    <nav class="nav" aria-label="pages">
      <button
        v-for="p in PAGES"
        :key="p.id"
        type="button"
        :class="{ on: route === p.id }"
        :aria-current="route === p.id ? 'page' : undefined"
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
  left: 50%;
  transform: translateX(-50%);
  bottom: max(1rem, env(safe-area-inset-bottom));
  z-index: 3;
  display: flex;
  gap: 0.35rem;
  padding: 0.3rem;
  border-radius: var(--radius);
  background: rgba(26, 21, 18, 0.62);
  border: 1px solid rgba(242, 232, 218, 0.14);
  backdrop-filter: blur(10px);
}

.nav button {
  font: inherit;
  font-size: 0.75rem;
  letter-spacing: 0.12em;
  text-transform: lowercase;
  color: rgba(242, 232, 218, 0.6);
  background: none;
  border: 0;
  border-radius: var(--radius);
  padding: 0.35rem 0.85rem;
  cursor: pointer;
}

.nav button:hover {
  color: var(--ink);
}

.nav button.on {
  color: #1a1512;
  background: rgba(242, 232, 218, 0.88);
}

.nav button:focus-visible {
  outline: 2px solid rgba(242, 232, 218, 0.8);
  outline-offset: 2px;
}
</style>
