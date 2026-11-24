import { createPinia } from 'pinia';
import { createApp } from 'vue';
import { App } from './App.js';
import { createDashboardRouter } from './router.js';
import './style.css';

createApp(App).use(createPinia()).use(createDashboardRouter()).mount('#app');
