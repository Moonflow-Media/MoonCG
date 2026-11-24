import { createPinia } from 'pinia';
import { createApp } from 'vue';
import { App } from './App.js';
import { createDashboardRouter } from './router.js';
// The design tokens are the server's file: its sign-in pages are drawn with the same one.
import '../../server/public/tokens.css';
import './style.css';

createApp(App).use(createPinia()).use(createDashboardRouter()).mount('#app');
