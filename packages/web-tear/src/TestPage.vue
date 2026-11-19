<script setup>
import { ref } from 'vue'
import TearableCloth from './TearableCloth.vue'
import { FLOOR_COLOR } from './test-layers'

defineProps({
  layers: { type: Array, required: true },
  title: { type: String, required: true },
  hint: { type: String, default: 'grab it and pull' },
  here: { type: String, required: true }, // which test this is
})

const tests = [
  { id: 'image', href: './image.html', label: 'image' },
  { id: 'video', href: './video.html', label: 'video' },
  { id: 'both', href: './both.html', label: 'both' },
  { id: 'untearable', href: './untearable.html', label: 'unbreakable' },
]

const cloth = ref(null)
</script>

<template>
  <main class="app">
    <TearableCloth ref="cloth" :layers="layers" :floor="FLOOR_COLOR" />
    <div class="hud">
      <span class="badge">{{ title }}</span>
      <a
        v-for="test in tests.filter((t) => t.id !== here)"
        :key="test.id"
        class="badge btn"
        :href="test.href"
      >{{ test.label }} test</a>
      <button class="badge btn" @click="cloth.reset()">reset</button>
    </div>
    <p class="hint">{{ hint }}</p>
  </main>
</template>

<style scoped>
/* the test pages sit on ink, so their hint is paper */
.hint { color: rgba(242, 242, 240, .6); }
</style>
