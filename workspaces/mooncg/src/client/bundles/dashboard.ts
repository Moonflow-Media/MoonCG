import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { App } from "../dashboard-app/App";
import { injectGlobalStyles } from "../dashboard-app/styles";

function mount() {
	injectGlobalStyles();

	const container = document.getElementById("dashboard-root");
	if (!container) {
		throw new Error("Dashboard root element (#dashboard-root) not found");
	}

	createRoot(container).render(createElement(App));
}

// This bundle is loaded synchronously in <head>, so the body (and with it the
// #dashboard-root mount point) may not have been parsed yet.
if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", mount, { once: true });
} else {
	mount();
}
