<script setup>
// Hash routing, so the whole thing is one entry and one bundle.
import { computed, onMounted, onUnmounted, ref } from 'vue'
import HeroPage from './pages/HeroPage.vue'
import DemoPage from './pages/DemoPage.vue'
import TitlesPage from './pages/TitlesPage.vue'

const PAGES = {
  text: { title: 'text', hint: 'move across the letters · the slider reveals them tile by tile' },
  login: { title: 'login card', hint: 'type in it — it stays a working form under the tiles' },
  image: { title: 'image', hint: 'move across the photograph · click to knock it' },
  video: { title: 'video', hint: 'it keeps playing under the tiles' },
  all: { title: 'everything', hint: 'text, a component, a photograph and a video' },
}

const route = ref(window.location.hash.slice(2))
const page = computed(() => PAGES[route.value] ?? null)
const onHashChange = () => { route.value = window.location.hash.slice(2) }

onMounted(() => window.addEventListener('hashchange', onHashChange))
onUnmounted(() => window.removeEventListener('hashchange', onHashChange))
</script>

<template>
  <!-- Keyed, so switching pages tears the old engine down rather than trying
       to re-point it at different content. -->
  <TitlesPage v-if="route === 'titles'" key="titles" />
  <DemoPage v-else-if="page" :key="route" :kind="route" :title="page.title" :hint="page.hint" />
  <HeroPage v-else key="hero" />
</template>
