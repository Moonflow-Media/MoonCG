import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api } from '../api.js';
import { holds } from '../permissions.js';

interface Me {
  readonly user: { readonly id: string; readonly kind: string; readonly name: string | null };
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
}

/** Who is signed in and what they hold, as `GET /api/v1/me` tells it. */
export const useSession = defineStore('session', () => {
  const me = ref<Me>();
  const name = computed(() => me.value?.user.name ?? '');
  const roles = computed(() => me.value?.roles ?? []);
  const permissions = computed(() => me.value?.permissions ?? []);

  async function load(): Promise<void> {
    me.value = await api.request<Me>('GET', '/api/v1/me');
  }
  const can = (permission: string) => holds(permissions.value, permission);
  async function logout(): Promise<void> {
    await api.request('POST', '/api/v1/auth/logout');
    api.onUnauthenticated();
  }

  return { me, name, roles, permissions, load, can, logout };
});
