<script setup>
import { useReplicant } from '@mooncg/sdk/vue';
import { mc } from '../client.js';

const { data } = useReplicant(mc.replicant('message'));
</script>

<template>
  <div id="message" :class="{ hidden: !data?.visible }">{{ data?.text }}</div>
</template>

<style>
html,
body {
  width: 1920px;
  height: 1080px;
  margin: 0;
  overflow: hidden;
  background: transparent;
}
#message {
  position: absolute;
  left: 80px;
  bottom: 120px;
  padding: 20px 36px;
  border-radius: 12px;
  background: rgba(16, 18, 24, 0.85);
  color: #fff;
  font: 600 48px system-ui, sans-serif;
  transition: opacity 0.3s;
}
#message.hidden {
  opacity: 0;
}
</style>
