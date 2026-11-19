<script setup>
import { ref } from 'vue'
import TearableCloth from './TearableCloth.vue'
import { layers } from './layers'

const cloth = ref(null)
const sheets = ref({ remaining: 0, total: 0, name: '' })
const hint = ref(true)
</script>

<template>
  <main class="app">
    <TearableCloth
      ref="cloth"
      :layers="layers"
      @sheets="sheets = $event"
      @firsttear="hint = false"
    />
    <div class="hud">
      <span class="badge">{{ sheets.remaining }}/{{ sheets.total }} sheets &middot; {{ sheets.name }}</span>
      <button class="badge btn" @click="cloth.reset()">reset</button>
    </div>
    <transition name="fade">
      <p v-if="hint" class="hint">grab the page and pull</p>
    </transition>
  </main>
</template>

<style scoped>
/* the cover page is paper, so its hint is ink */
.hint { color: rgba(11, 11, 11, .45); }
.fade-leave-active { transition: opacity .4s; }
.fade-leave-to { opacity: 0; }
</style>
