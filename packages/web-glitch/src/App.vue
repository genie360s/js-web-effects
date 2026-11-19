<script setup>
// Hash routing, so the whole thing is one entry and one bundle.
import { computed, onMounted, onUnmounted, ref } from 'vue'
import HeroPage from './pages/HeroPage.vue'
import DemoPage from './pages/DemoPage.vue'

const PAGES = {
  image: { title: 'image', hint: 'move across it · click for a burst' },
  video: { title: 'video', hint: 'it keeps playing in the blocks' },
  text: { title: 'text', hint: 'real text, in the page, arriving in blocks' },
  styles: { title: 'styles', hint: 'one picture, the five renderings' },
  login: { title: 'login card', hint: 'type in it — it stays a working form' },
}

const route = ref(window.location.hash.slice(2))
const page = computed(() => PAGES[route.value] ?? null)
const onHashChange = () => { route.value = window.location.hash.slice(2) }

onMounted(() => window.addEventListener('hashchange', onHashChange))
onUnmounted(() => window.removeEventListener('hashchange', onHashChange))
</script>

<template>
  <!-- Keyed, so switching pages tears the old engines down rather than trying
       to re-point them at different content. -->
  <DemoPage v-if="page" :key="route" :kind="route" :title="page.title" :hint="page.hint" />
  <HeroPage v-else key="hero" />
</template>
