/**
 * Global styles for the React dashboard.
 *
 * The dashboard is shipped as a single IIFE bundle (dashboard.js), so instead
 * of emitting a separate .css asset we inject a <style> tag at startup.
 * The color system carries over the CSS variables of the old Polymer theme
 * (see the previous dashboard/css/mooncg-theme.ts).
 */

const css = /* css */ `
:root {
	--mooncg-brand-blue: #00bebe;
	--mooncg-brand-blue-dark: #004949;

	--mooncg-accept-color: #32784A;
	--mooncg-benign-color: #525F78;
	--mooncg-configure-color: #6155BD;
	--mooncg-danger-color: #CF7E44;
	--mooncg-disabled-color: #8D8E91;
	--mooncg-execute-color: #FFC700;
	--mooncg-reject-color: #A33B3B;
	--mooncg-selected-color: #5280D9;

	--mooncg-bg: #232C3D;
	--mooncg-surface: #2F3A4F;
	--mooncg-surface-raised: #525F78;
	--mooncg-divider: #6F7D99;

	--mooncg-status-nominal: #00A651;
	--mooncg-status-out-of-date: #FFC700;
	--mooncg-status-none: #CACACA;
}

* {
	box-sizing: border-box;
}

html, body {
	height: 100%;
}

body {
	color: white;
	font-family: Roboto, Noto, "Segoe UI", sans-serif;
	-webkit-tap-highlight-color: rgba(0, 0, 0, 0);
}

.dashboard-app {
	display: flex;
	flex-direction: column;
	height: 100vh;
	overflow: hidden;
}

.dashboard-app a {
	color: white;
	font-weight: 500;
	letter-spacing: 0.018em;
	text-decoration: underline;
}

button {
	font: inherit;
}

/* Generic flat buttons, carried over from the old paper-button theme. */
.ncg-button {
	align-items: center;
	background: var(--mooncg-benign-color);
	border: none;
	border-radius: 0;
	color: white;
	cursor: pointer;
	display: inline-flex;
	font-size: 16px;
	font-weight: 300;
	gap: 0.4em;
	justify-content: center;
	padding: 8px 16px;
	user-select: none;
}

.ncg-button:disabled {
	background: var(--mooncg-disabled-color);
	color: #54575C;
	cursor: default;
}

.ncg-button.mooncg-accept { background: var(--mooncg-accept-color); }
.ncg-button.mooncg-benign { background: var(--mooncg-benign-color); }
.ncg-button.mooncg-configure { background: var(--mooncg-configure-color); }
.ncg-button.mooncg-danger { background: var(--mooncg-danger-color); }
.ncg-button.mooncg-execute { background: var(--mooncg-execute-color); color: black; }
.ncg-button.mooncg-reject { background: var(--mooncg-reject-color); }
.ncg-button.mooncg-selected { background: var(--mooncg-selected-color); }

.icon-button {
	align-items: center;
	background: none;
	border: none;
	border-radius: 50%;
	color: white;
	cursor: pointer;
	display: inline-flex;
	height: 40px;
	justify-content: center;
	padding: 8px;
	width: 40px;
}

.icon-button:hover {
	background: rgba(255, 255, 255, 0.12);
}

.ncg-icon {
	fill: currentColor;
	flex: none;
	height: 24px;
	width: 24px;
}

/* ---------- Header / navigation ---------- */

.app-header {
	align-items: center;
	background-color: var(--mooncg-surface);
	box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35);
	display: flex;
	flex: none;
	height: 64px;
	padding: 0 8px;
	z-index: 10;
}

.app-header .main-logo {
	height: 48px;
	width: 48px;
}

.app-header .tabs {
	align-items: stretch;
	display: flex;
	height: 100%;
	min-width: 0;
	overflow-x: auto;
	scrollbar-width: thin;
}

.app-header .tabs.workspace-tabs {
	flex: 1;
}

.app-header .tab {
	align-items: center;
	background: none;
	border: none;
	border-bottom: 5px solid transparent;
	border-top: 5px solid transparent;
	color: white;
	cursor: pointer;
	display: flex;
	flex: none;
	flex-direction: column;
	font-size: 12px;
	font-weight: 500;
	gap: 2px;
	justify-content: center;
	padding: 0 16px;
	text-transform: uppercase;
	user-select: none;
	white-space: nowrap;
}

.app-header .tab.workspace-tab {
	font-size: 16px;
}

.app-header .tab:hover {
	background: rgba(255, 255, 255, 0.06);
}

.app-header .tab.active {
	border-bottom-color: var(--mooncg-brand-blue);
	color: var(--mooncg-brand-blue);
}

/* ---------- Drawer (small screens) ---------- */

.drawer-backdrop {
	background: rgba(0, 0, 0, 0.5);
	inset: 0;
	position: fixed;
	z-index: 19;
}

.drawer {
	background-color: var(--mooncg-surface);
	bottom: 0;
	box-shadow: 2px 0 12px rgba(0, 0, 0, 0.5);
	display: flex;
	flex-direction: column;
	left: 0;
	position: fixed;
	top: 0;
	width: 288px;
	z-index: 20;
}

.drawer-toolbar {
	align-items: center;
	display: flex;
	flex: none;
	height: 64px;
	padding: 0 8px;
}

.drawer-toolbar img {
	height: 28px;
	padding-left: 16px;
	width: 83px;
}

.drawer-list {
	margin: 0 20px;
	overflow-y: auto;
}

.drawer-list a {
	align-items: center;
	color: white;
	display: flex;
	gap: 16px;
	line-height: 40px;
	padding: 4px 12px;
	text-decoration: none;
	text-transform: uppercase;
}

.drawer-list a.active {
	background-color: var(--mooncg-surface-raised);
	font-weight: bold;
}

.hamburger {
	display: none;
}

/* ---------- Pages ---------- */

#pages {
	display: flex;
	flex: 1;
	flex-direction: column;
	min-height: 0;
	overflow: auto;
}

#pages > section {
	box-sizing: border-box;
	flex: 1;
}

#pages > section:not(.section-workspace) {
	align-items: center;
	display: flex;
	flex-direction: column;
	padding: 32px;
}

#pages > section.section-workspace {
	display: flex;
	flex-direction: column;
	min-height: 0;
}

#pages > section[hidden] {
	display: none;
}

/* ---------- Workspace / panels ---------- */

.workspace {
	flex: 1;
	min-height: 0;
	padding: 32px;
	width: 100%;
}

.workspace.fullbleed {
	display: flex;
	flex-direction: column;
	padding: 0;
}

.workspace-grid {
	align-items: start;
	display: grid;
	gap: 16px;
	grid-auto-flow: row dense;
	grid-template-columns: repeat(auto-fill, 128px);
	padding-bottom: 32px;
}

.panel {
	background-color: var(--mooncg-surface);
	box-shadow:
		0 2px 2px 0 rgba(0, 0, 0, 0.14),
		0 1px 5px 0 rgba(0, 0, 0, 0.12),
		0 3px 1px -2px rgba(0, 0, 0, 0.2);
	display: flex;
	flex-direction: column;
	min-width: 0;
}

.panel.dragging {
	opacity: 0.85;
	z-index: 5;
}

.panel.fullbleed {
	box-shadow: none;
	flex: 1;
	height: 100%;
	min-height: 0;
	width: 100%;
}

.panel-header {
	align-items: center;
	color: #F5F5F5;
	display: flex;
	flex: none;
	font-size: 20px;
	font-weight: 500;
	justify-content: flex-end;
	min-height: 44px;
	overflow: hidden;
	position: relative;
}

.panel-title {
	left: 15px;
	overflow: hidden;
	position: absolute;
	text-overflow: ellipsis;
	top: 8px;
	white-space: nowrap;
}

.panel-buttons-container {
	z-index: 1;
}

.panel-more-indicator {
	position: absolute;
	right: 10px;
	top: 10px;
}

.panel-buttons {
	align-items: center;
	display: flex;
	padding-left: 8px;
	transform: translateX(100%);
	transition: transform 200ms ease;
}

.panel-header:hover .panel-buttons,
.panel.fullbleed .panel-buttons {
	transform: translateX(0%);
}

.panel-header a {
	color: inherit;
}

.panel-drag-handle {
	cursor: grab;
	touch-action: none;
}

.panel-drag-handle:active {
	cursor: grabbing;
}

.panel-body {
	background-color: #f5f5f5;
	min-height: 1px;
	padding: 0;
}

.panel.fullbleed .panel-body {
	display: flex;
	flex: 1;
	flex-direction: column;
	min-height: 0;
}

.panel-body iframe {
	border: none;
	display: block;
	width: 100%;
}

.panel.fullbleed .panel-body iframe {
	flex: 1;
	height: 100%;
}

/* ---------- Dialogs ---------- */

dialog.ncg-dialog {
	background-color: var(--mooncg-surface);
	border: none;
	color: white;
	margin: auto;
	max-height: calc(100vh - 64px);
	max-width: 100%;
	overflow: hidden;
	padding: 0;
	box-shadow:
		0 16px 24px 2px rgba(0, 0, 0, 0.14),
		0 6px 30px 5px rgba(0, 0, 0, 0.12),
		0 8px 10px -5px rgba(0, 0, 0, 0.4);
}

dialog.ncg-dialog::backdrop {
	background: rgba(0, 0, 0, 0.6);
}

dialog.ncg-dialog .dialog-inner {
	display: flex;
	flex-direction: column;
	max-height: calc(100vh - 64px);
}

dialog.ncg-dialog h2 {
	flex: none;
	font-size: 20px;
	font-weight: 500;
	margin: 0;
	padding: 24px 24px 0;
}

dialog.ncg-dialog .dialog-content {
	flex: 1;
	margin: 12px 0;
	overflow-y: auto;
	padding: 0 24px;
}

dialog.ncg-dialog iframe {
	border: none;
	display: block;
	margin: 0;
	padding: 0;
	width: 100%;
}

dialog.ncg-dialog .buttons,
dialog.confirm-dialog .buttons {
	display: flex;
	flex: none;
	gap: 8px;
	justify-content: flex-end;
	padding: 8px 16px 16px;
}

dialog.confirm-dialog {
	background-color: var(--mooncg-surface);
	border: none;
	color: white;
	margin: auto;
	padding: 0;
	box-shadow:
		0 16px 24px 2px rgba(0, 0, 0, 0.14),
		0 6px 30px 5px rgba(0, 0, 0, 0.12),
		0 8px 10px -5px rgba(0, 0, 0, 0.4);
}

dialog.confirm-dialog::backdrop {
	background: rgba(0, 0, 0, 0.6);
}

dialog.confirm-dialog h2 {
	font-size: 20px;
	font-weight: 500;
	margin: 0;
	padding: 24px 24px 0;
}

dialog.confirm-dialog .confirm-dialog-body {
	padding: 8px 24px;
}

/* ---------- Cards (mixer, assets, settings) ---------- */

.ncg-card {
	background-color: var(--mooncg-surface);
	box-shadow:
		0 2px 2px 0 rgba(0, 0, 0, 0.14),
		0 1px 5px 0 rgba(0, 0, 0, 0.12),
		0 3px 1px -2px rgba(0, 0, 0, 0.2);
	margin-bottom: 16px;
	width: 100%;
}

.ncg-card > .card-heading {
	background-color: var(--mooncg-surface-raised);
	border-bottom: 5px solid var(--mooncg-brand-blue);
	font-size: 24px;
	font-weight: bold;
	padding: 12px 16px;
}

/* ---------- Graphics page ---------- */

.graphics-page {
	display: flex;
	flex-direction: column;
	max-width: 800px;
	width: 100%;
}

.graphics-bundle {
	background: var(--mooncg-surface);
	box-shadow:
		0 2px 2px 0 rgba(0, 0, 0, 0.14),
		0 1px 5px 0 rgba(0, 0, 0, 0.12),
		0 3px 1px -2px rgba(0, 0, 0, 0.2);
	color: white;
	display: flex;
	flex-direction: column;
	margin-bottom: 20px;
	padding-bottom: 13px;
}

.graphics-bundle-title-bar {
	background-color: var(--mooncg-surface-raised);
	border-bottom: 5px solid var(--mooncg-brand-blue);
	display: flex;
	margin-bottom: 13px;
}

.graphics-bundle-name {
	flex: 1;
	font-size: 24px;
	padding: 6px 17px;
}

.graphics-bundle-title-bar .ncg-button {
	border-radius: 0;
	font-size: 14px;
	font-weight: 500;
	width: 160px;
}

.graphic {
	display: flex;
	flex-direction: column;
	margin: 0 8px;
	white-space: nowrap;
}

.graphic:not(:last-child) {
	margin-bottom: 20px;
}

.graphic-details {
	display: flex;
	height: 60px;
}

.graphic-indicator {
	background-color: var(--mooncg-status-none);
	flex: none;
	width: 9px;
}

.graphic-indicator.nominal { background-color: var(--mooncg-status-nominal); }
.graphic-indicator.out-of-date { background-color: var(--mooncg-status-out-of-date); }

.graphic-counter {
	align-items: center;
	background-color: var(--mooncg-surface-raised);
	color: white;
	display: flex;
	flex: none;
	font-size: 24px;
	font-weight: 500;
	justify-content: center;
	padding-right: 8px;
	width: 38px;
}

.graphic-url-and-resolution {
	align-items: center;
	background-color: var(--mooncg-surface-raised);
	display: flex;
	flex: 1;
	margin-right: 1px;
	min-width: 0;
}

.graphic-url {
	color: white;
	font-size: 16px;
	font-weight: 500;
	max-width: 100%;
	min-width: 0;
	overflow: hidden;
	text-decoration: underline;
	text-overflow: ellipsis;
	text-transform: uppercase;
}

.graphic-resolution {
	flex: none;
	font-size: 14px;
	font-weight: 500;
	margin-left: auto;
	overflow: hidden;
	padding: 0 4px;
	text-align: center;
	text-overflow: ellipsis;
	width: 90px;
}

.graphic-details .ncg-button {
	flex: none;
	font-size: 14px;
	font-weight: 500;
	margin: 0 1px;
	min-width: 0;
	padding: 0;
	width: 60px;
}

.graphic-details .ncg-button:last-child {
	margin-right: 0;
}

.graphic-details .graphic-copy-button,
.graphic-details .graphic-reload-button {
	background: var(--mooncg-configure-color);
	width: 115px;
}

.graphic-details .graphic-collapse-button {
	background: var(--mooncg-surface-raised);
}

.graphic-details .ncg-button:disabled {
	background: var(--mooncg-disabled-color);
	color: #54575C;
}

.graphic-instance {
	display: flex;
	font-size: 18px;
	font-weight: 500;
	height: 35px;
	margin: 0 8px 5px;
	position: relative;
	white-space: nowrap;
}

.graphic-instance:first-child {
	margin-top: 5px;
}

.graphic-instance.closed {
	opacity: 0;
	transition: opacity 0.9s ease-out;
}

.graphic-instance-indicator {
	background-color: var(--mooncg-status-none);
	flex: none;
	width: 8px;
}

.graphic-instance.nominal .graphic-instance-indicator { background-color: var(--mooncg-status-nominal); }
.graphic-instance.out-of-date .graphic-instance-indicator { background-color: var(--mooncg-status-out-of-date); }

.graphic-instance-icon {
	align-items: center;
	background: var(--mooncg-surface-raised);
	border-right: 1px solid var(--mooncg-divider);
	display: flex;
	flex: none;
	justify-content: center;
	width: 38px;
}

.graphic-instance.nominal .graphic-instance-icon { color: var(--mooncg-status-nominal); }
.graphic-instance.out-of-date .graphic-instance-icon,
.graphic-instance.out-of-date .graphic-instance-status { color: var(--mooncg-status-out-of-date); }

.graphic-instance.out-of-date .graphic-instance-status {
	cursor: help;
}

.graphic-instance-ip,
.graphic-instance-status,
.graphic-instance-duration {
	align-items: center;
	background: var(--mooncg-surface-raised);
	display: flex;
	padding: 0 16px;
}

.graphic-instance-ip {
	border-right: 1px solid var(--mooncg-divider);
	flex: 1;
	min-width: 0;
}

.graphic-instance-ip span {
	overflow: hidden;
	text-overflow: ellipsis;
}

.graphic-instance-status {
	border-right: 1px solid var(--mooncg-divider);
	flex: none;
	width: 187px;
}

.graphic-instance-duration {
	flex: none;
	gap: 6px;
	margin-right: 1px;
	width: 130px;
}

.graphic-instance .ncg-button {
	flex: none;
	margin: 0 1px;
	min-width: 0;
	padding: 0;
	width: 40px;
}

.graphic-instance .ncg-button:last-child {
	margin-right: 0;
}

.graphic-instance .instance-reload-button {
	background: var(--mooncg-configure-color);
}

.graphic-instance .instance-kill-button {
	background: #FF7575;
}

.graphic-instance-diff {
	align-items: center;
	background: #212121;
	display: flex;
	font-family: "Courier New", Courier, monospace;
	font-size: 12px;
	left: 40px;
	max-width: 100%;
	padding: 0.5em 1em 0.5em 0;
	position: absolute;
	top: 38px;
	white-space: normal;
	z-index: 1;
}

.graphic-instance-diff .orange { color: #F4C008; font-weight: bold; }
.graphic-instance-diff .green { color: var(--mooncg-status-nominal); font-weight: bold; }

/* ---------- Mixer ---------- */

.mixer-page {
	display: flex;
	flex-direction: column;
	max-width: 600px;
	white-space: nowrap;
	width: 100%;
}

.mixer-master-card {
	background-color: var(--mooncg-surface-raised);
	border-bottom: 5px solid var(--mooncg-brand-blue);
	margin-bottom: 16px;
}

.fader-row {
	align-items: center;
	display: flex;
	gap: 12px;
	padding: 12px 16px;
}

.fader-row > .fader-label {
	flex: 1 0 auto;
	font-size: 20px;
	font-weight: 500;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
}

.mixer-master-card .fader-label {
	font-size: 28px;
}

.fader {
	align-items: center;
	display: flex;
	flex-shrink: 1;
	gap: 8px;
}

.fader input[type="range"] {
	accent-color: white;
	width: 160px;
}

.fader input[type="number"] {
	background: rgba(0, 0, 0, 0.2);
	border: none;
	border-bottom: 1px solid white;
	color: white;
	padding: 2px 4px;
	width: 56px;
}

.sound-cues {
	background-color: var(--mooncg-surface);
	padding-bottom: 8px;
}

.sound-cue {
	align-items: center;
	display: flex;
	gap: 8px;
	padding: 4px 16px;
}

.sound-cue .sound-cue-name {
	flex: 1;
	font-size: 20px;
	font-weight: 500;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
}

.sound-cue select {
	background: var(--mooncg-surface-raised);
	border: 1px solid var(--mooncg-divider);
	color: white;
	flex: none;
	padding: 4px;
	width: 150px;
}

/* ---------- Assets ---------- */

.assets-page {
	display: flex;
	flex-direction: column;
	max-width: 600px;
	width: 100%;
}

.asset-category {
	background-color: var(--mooncg-surface-raised);
	display: block;
	width: 100%;
}

.asset-category:not(:last-child) {
	border-bottom: 1px solid var(--mooncg-surface);
}

.asset-category-header {
	align-items: center;
	display: flex;
	justify-content: space-between;
	padding: 12px 16px;
}

.asset-category-title {
	font-size: 24px;
}

.asset-category-empty {
	padding: 0 16px 12px;
}

.asset-add-button {
	background: var(--mooncg-status-nominal);
}

.asset-files {
	background-color: var(--mooncg-surface);
	max-height: 400px;
	overflow-y: auto;
	padding-left: 16px;
}

.asset-file {
	align-items: center;
	display: flex;
	justify-content: space-between;
	margin: 4px 0;
}

.asset-file a {
	line-height: 24px;
	overflow: hidden;
	text-overflow: ellipsis;
	text-transform: none;
}

.asset-file .ncg-button {
	flex: none;
	margin-right: 21px;
}

.upload-dialog-content {
	padding: 16px;
	width: 432px;
}

.upload-dropzone {
	align-items: center;
	border: 2px dashed var(--mooncg-divider);
	color: white;
	cursor: pointer;
	display: flex;
	flex-direction: column;
	gap: 8px;
	justify-content: center;
	padding: 32px 16px;
	text-align: center;
	width: 100%;
	background: none;
	font-size: 16px;
}

.upload-dropzone.drag-over {
	border-color: var(--mooncg-brand-blue);
	color: var(--mooncg-brand-blue);
}

.upload-accepts-msg {
	margin-top: 8px;
	text-align: center;
}

.upload-file-list {
	list-style: none;
	margin: 8px 0 0;
	max-height: 200px;
	overflow-y: auto;
	padding: 0;
}

.upload-file-list li {
	align-items: center;
	display: flex;
	gap: 8px;
	justify-content: space-between;
	padding: 4px 0;
}

.upload-file-list .upload-status-uploading { color: var(--mooncg-execute-color); }
.upload-file-list .upload-status-success { color: var(--mooncg-brand-blue); }
.upload-file-list .upload-status-error { color: var(--mooncg-reject-color); }

/* ---------- Settings ---------- */

.settings-page {
	display: flex;
	flex-direction: column;
	max-width: 600px;
	width: 100%;
}

.settings-page .card-content {
	padding: 16px;
}

.settings-page .card-actions {
	display: flex;
	gap: 8px;
	justify-content: flex-end;
	padding-top: 8px;
}

.settings-page code {
	background: rgba(0, 0, 0, 0.3);
	display: block;
	font-family: "Courier New", Courier, monospace;
	overflow-wrap: anywhere;
	padding: 8px;
}

.text-warning {
	color: var(--mooncg-status-out-of-date);
}

.settings-page .totp-qr {
	background: white;
	display: block;
	height: 196px;
	margin-bottom: 8px;
	padding: 4px;
	width: 196px;
}

/* ---------- Users ---------- */

.users-page {
	display: flex;
	flex-direction: column;
	max-width: 800px;
	width: 100%;
}

.users-page .card-content {
	padding: 16px;
}

.users-page .card-actions {
	display: flex;
	gap: 8px;
	justify-content: flex-end;
	padding-top: 8px;
}

.users-table {
	border-collapse: collapse;
	margin-top: 8px;
	width: 100%;
}

.users-table th {
	border-bottom: 2px solid var(--mooncg-divider);
	font-size: 14px;
	font-weight: 500;
	padding: 8px;
	text-align: left;
	text-transform: uppercase;
}

.users-table td {
	border-bottom: 1px solid var(--mooncg-divider);
	padding: 8px;
}

.users-table .user-name {
	font-weight: 500;
	overflow-wrap: anywhere;
}

.users-table .user-status.disabled {
	color: var(--mooncg-danger-color);
}

.users-table .user-actions {
	display: flex;
	gap: 4px;
	justify-content: flex-end;
}

.users-table .user-actions .ncg-button {
	padding: 6px;
}

/* ---------- Forms (user editor, 2FA) ---------- */

.form-field {
	display: flex;
	flex-direction: column;
	gap: 4px;
	margin: 12px 0;
}

.form-field > span {
	font-size: 14px;
}

.form-field input[type="text"],
.form-field input[type="password"] {
	background: rgba(0, 0, 0, 0.2);
	border: none;
	border-bottom: 1px solid white;
	color: white;
	font: inherit;
	padding: 6px 8px;
}

.form-field.checkbox-field,
.role-option {
	align-items: center;
	cursor: pointer;
	flex-direction: row;
	gap: 8px;
}

.role-option {
	display: flex;
	padding: 2px 0;
}

fieldset.roles-fieldset {
	border: 1px solid var(--mooncg-divider);
	margin: 12px 0;
	padding: 8px 12px;
}

fieldset.roles-fieldset legend {
	font-size: 14px;
	padding: 0 4px;
}

dialog.user-editor-dialog,
dialog.sessions-dialog {
	min-width: 360px;
}

/* ---------- Sessions ---------- */

.session-list {
	display: flex;
	flex-direction: column;
}

.session-row {
	align-items: center;
	border-bottom: 1px solid var(--mooncg-divider);
	display: flex;
	gap: 12px;
	justify-content: space-between;
	padding: 8px 0;
}

.session-row:last-child {
	border-bottom: none;
}

.session-details {
	display: flex;
	flex-direction: column;
	gap: 2px;
	min-width: 0;
}

.session-device {
	font-weight: 500;
	overflow-wrap: anywhere;
}

.session-current-badge {
	color: var(--mooncg-brand-blue);
}

.session-meta {
	font-size: 13px;
	opacity: 0.8;
}

/* ---------- Toasts ---------- */

.toast-container {
	bottom: 12px;
	display: flex;
	flex-direction: column;
	gap: 8px;
	left: 12px;
	position: fixed;
	z-index: 100;
}

.toast {
	align-items: center;
	background: #323232;
	border-radius: 2px;
	box-shadow: 0 2px 5px 0 rgba(0, 0, 0, 0.26);
	color: #f1f1f1;
	display: flex;
	font-size: 14px;
	gap: 12px;
	min-height: 48px;
	min-width: 288px;
	padding: 12px 24px;
}

.spinner {
	animation: spinner-rotate 1s linear infinite;
	border: 3px solid rgba(255, 255, 255, 0.25);
	border-radius: 50%;
	border-top-color: var(--mooncg-brand-blue);
	height: 22px;
	width: 22px;
}

@keyframes spinner-rotate {
	to { transform: rotate(360deg); }
}

.workspace-loading-spinner {
	height: 68px;
	left: 50%;
	position: fixed;
	top: 50%;
	transform: translate(-50%, -50%);
	width: 68px;
}

[hidden] {
	display: none !important;
}

/* ---------- Phone ---------- */

@media (max-width: 640px) {
	.app-header .tabs {
		display: none;
	}

	.hamburger {
		display: inline-flex;
	}

	#pages > section:not(.section-workspace) {
		padding: 8px;
	}

	.workspace:not(.fullbleed) {
		padding: 6px;
	}

	.graphic-instance-status {
		width: 94px;
	}

	.graphic-instance-duration {
		width: 100px;
	}

	.graphic-resolution {
		width: auto;
	}
}

@media (max-width: 520px) {
	.graphic-instance-status,
	.graphic-instance-duration .ncg-icon {
		display: none;
	}

	.graphic-instance-duration {
		width: 80px;
	}

	.graphic-details .graphic-copy-button,
	.graphic-details .graphic-reload-button {
		width: 60px;
	}

	.graphic-details .graphic-copy-button .button-text,
	.graphic-details .graphic-reload-button .button-text {
		display: none;
	}

	.graphic-instance-diff {
		left: 0;
	}
}
`;

export function injectGlobalStyles(): void {
	const style = document.createElement("style");
	style.id = "mooncg-dashboard-styles";
	style.textContent = css;
	document.head.appendChild(style);
}
