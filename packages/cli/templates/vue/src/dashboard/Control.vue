<script setup>
import { useReplicant } from '@mooncg/sdk/vue';
import { ref } from 'vue';
import { mc } from '../client.js';

// `data` follows the replicant: its value now, and whenever anyone changes it.
const { data, error, update } = useReplicant(mc.replicant('message'));
const problem = ref('');
const change = (recipe) => {
  problem.value = '';
  update(recipe).catch((failure) => {
    problem.value = failure.message;
  });
};
</script>

<template>
  <form class="control" @submit.prevent>
    <label>
      Text
      <input
        name="text"
        :value="data?.text ?? ''"
        maxlength="200"
        @change="change((draft) => { draft.text = $event.target.value; })"
      />
    </label>
    <label class="check">
      <input
        name="visible"
        type="checkbox"
        :checked="data?.visible ?? false"
        @change="change((draft) => { draft.visible = $event.target.checked; })"
      />
      Visible
    </label>
    <p v-if="problem || error" class="problem">{{ problem || error?.message }}</p>
  </form>
</template>

<style>
body {
  margin: 0;
  font: 14px system-ui, sans-serif;
}
.control {
  display: grid;
  gap: 10px;
  padding: 12px;
}
.control input[name='text'] {
  display: block;
  width: 100%;
  box-sizing: border-box;
}
.problem {
  color: #c62828;
}
</style>
