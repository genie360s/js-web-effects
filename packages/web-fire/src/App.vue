<script setup>
// Hash routing, so the whole thing is one entry and one bundle.
import { computed, onMounted, onUnmounted, ref } from 'vue'
import HeroPage from './pages/HeroPage.vue'
import DemoPage from './pages/DemoPage.vue'
import EternalPage from './pages/EternalPage.vue'

const PAGES = {
  text: { title: 'text', hint: 'drag across the letters — only the ink is fuel' },
  login: { title: 'login card', hint: 'type in it, then set it alight' },
  image: { title: 'image', hint: 'drag across the photograph' },
  video: { title: 'video', hint: 'it keeps playing while it burns' },
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
  <EternalPage v-if="route === 'eternal'" key="eternal" />
  <DemoPage v-else-if="page" :key="route" :kind="route" :title="page.title" :hint="page.hint" />
  <HeroPage v-else key="hero" />
</template>
