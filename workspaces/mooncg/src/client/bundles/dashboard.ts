import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { App } from "../dashboard-app/App";
import { injectGlobalStyles } from "../dashboard-app/styles";

injectGlobalStyles();

const container = document.getElementById("dashboard-root");
if (!container) {
	throw new Error("Dashboard root element (#dashboard-root) not found");
}

createRoot(container).render(createElement(App));
