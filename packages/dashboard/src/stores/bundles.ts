import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api, messageOf } from '../api.js';
import type { DialogInfo } from '../dialogs.js';

export interface PanelInfo {
  readonly id: string;
  readonly title: string;
  readonly width?: number | undefined;
  readonly workspace?: string | undefined;
  readonly url: string;
}

export interface GraphicInfo {
  readonly id: string;
  readonly title?: string | undefined;
  readonly width: number;
  readonly height: number;
  /** Whether the server lets only one page show this graphic at a time. */
  readonly singleInstance?: boolean | undefined;
  readonly url: string;
}

/** An asset category of a bundle, as far as the signed-in user may see it. */
export interface AssetCategoryInfo {
  readonly id: string;
  readonly title?: string | undefined;
  /** What may be uploaded: extensions and media types, as the manifest says. */
  readonly accept?: readonly string[] | undefined;
  /** Whether the user may upload and delete. */
  readonly canWrite: boolean;
}

export interface BundleInfo {
  readonly name: string;
  readonly title?: string | undefined;
  readonly state: string;
  readonly version?: string | undefined;
  readonly errors: readonly string[];
  readonly lastError?: string | undefined;
  readonly panels: readonly PanelInfo[];
  /** The dialogs the bundle's panels may open. */
  readonly dialogs?: readonly DialogInfo[] | undefined;
  readonly graphics: readonly GraphicInfo[];
  readonly assets?: readonly AssetCategoryInfo[] | undefined;
}

/** A panel as a workspace shows it: its id is unique across bundles. */
export interface WorkspacePanel extends PanelInfo {
  readonly bundle: string;
}

/** Panels whose manifest names no workspace are shown in this one. */
export const DEFAULT_WORKSPACE = 'Main';

export type BundleAction = 'enable' | 'disable' | 'reload';

/** The bundles the signed-in user may use, as `GET /api/v1/bundles` lists them. */
export const useBundles = defineStore('bundles', () => {
  const list = ref<readonly BundleInfo[]>([]);
  const canManage = ref(false);
  const loaded = ref(false);
  /** Why the last change was refused; empty when it was not. */
  const problem = ref('');

  const panels = computed<WorkspacePanel[]>(() =>
    list.value.flatMap((bundle) =>
      bundle.panels.map((panel) => ({
        ...panel,
        id: `${bundle.name}:${panel.id}`,
        bundle: bundle.name,
      })),
    ),
  );
  const workspaces = computed(() =>
    [...new Set(panels.value.map((panel) => panel.workspace ?? DEFAULT_WORKSPACE))].sort(),
  );
  const panelsOf = (workspace: string) =>
    panels.value.filter((panel) => (panel.workspace ?? DEFAULT_WORKSPACE) === workspace);

  async function refresh(): Promise<void> {
    const answer = await api.request<{ bundles: BundleInfo[]; canManage: boolean }>(
      'GET',
      '/api/v1/bundles',
    );
    list.value = answer.bundles;
    canManage.value = answer.canManage;
    loaded.value = true;
  }

  async function change(name: string, action: BundleAction): Promise<void> {
    problem.value = '';
    try {
      await api.request('POST', `/api/v1/bundles/${encodeURIComponent(name)}/${action}`);
    } catch (error) {
      problem.value = `Could not ${action} "${name}": ${messageOf(error)}`;
    }
    await refresh().catch(() => {});
  }

  return { list, canManage, loaded, problem, panels, workspaces, panelsOf, refresh, change };
});
