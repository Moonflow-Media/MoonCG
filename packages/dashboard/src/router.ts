import { defineComponent, h } from 'vue';
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { DEFAULT_WORKSPACE, useBundles } from './stores/bundles.js';
import { AssetsView } from './views/Assets.js';
import { BundlesView } from './views/Bundles.js';
import { GraphicsView } from './views/Graphics.js';
import { LogsView } from './views/Logs.js';
import { ModulesView } from './views/Modules.js';
import { RolesView } from './views/Roles.js';
import { SettingsView } from './views/Settings.js';
import { TokensView } from './views/Tokens.js';
import { UsersView } from './views/Users.js';
import { WorkspaceView } from './views/Workspace.js';

/** `/` goes to the first workspace there is, once the bundles are known. */
const Home = defineComponent({
  name: 'HomeView',
  setup() {
    const bundles = useBundles();
    return () => h(WorkspaceView, { workspace: bundles.workspaces[0] ?? DEFAULT_WORKSPACE });
  },
});

export const routes: RouteRecordRaw[] = [
  { path: '/', component: Home },
  { path: '/w/:workspace', component: WorkspaceView, props: true },
  { path: '/bundles', component: BundlesView },
  { path: '/graphics', component: GraphicsView },
  { path: '/assets', component: AssetsView },
  { path: '/admin/users', component: UsersView },
  { path: '/admin/roles', component: RolesView },
  { path: '/admin/tokens', component: TokensView },
  { path: '/settings', component: SettingsView },
  { path: '/modules', component: ModulesView },
  { path: '/logs', component: LogsView },
];

export const createDashboardRouter = () => createRouter({ history: createWebHistory(), routes });
