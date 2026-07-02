(function () {
	"use strict";

	const { mooncg } = globalThis;
	const timestamp = Date.now();
	let { pathname } = globalThis.location;

	// If the pathname ends with /bundleName/ then we must be on index.html.
	if (pathname.endsWith(`/${mooncg.bundleName}/graphics/`)) {
		pathname += "index.html";
	}

	/* istanbul ignore next: cant cover navigates page */
	globalThis.socket.on("graphic:kill", (instance) => {
		if (!instance) {
			return;
		}

		if (instance.socketId === globalThis.socket.id) {
			/* istanbul ignore next: cant cover navigates page */
			globalThis.location.href = "/instance/killed.html?pathname=" + pathname;
		}
	});

	/* istanbul ignore next: cant cover navigates page */
	globalThis.socket.on("graphic:refresh", (instance) => {
		if (!instance) {
			return;
		}

		if (instance.socketId === globalThis.socket.id) {
			/* istanbul ignore next: cant cover navigates page */
			globalThis.location.reload();
		}
	});

	/* istanbul ignore next: cant cover navigates page */
	globalThis.socket.on("graphic:refreshAll", (graphic) => {
		if (!graphic) {
			return;
		}

		if (graphic.url === pathname) {
			/* istanbul ignore next: cant cover navigates page */
			globalThis.location.reload();
		}
	});

	/* istanbul ignore next: cant cover navigates page */
	globalThis.socket.on("graphic:bundleRefresh", (bundleName) => {
		if (!bundleName) {
			return;
		}

		if (bundleName === mooncg.bundleName) {
			/* istanbul ignore next: cant cover navigates page */
			globalThis.location.reload();
		}
	});

	// On page load, register this socket with its URL pathname, so that the server can keep track of it.
	// In single-instance graphics, this registration will be rejected if the graphic is already open elsewhere.
	register();
	/* istanbul ignore next: hard to test reconnection stuff right now */
	globalThis.socket.io.on("reconnect", () => {
		register();
	});

	function register(): void {
		globalThis.socket.emit(
			"graphic:registerSocket",
			{
				timestamp,
				pathName: pathname,
				bundleName: mooncg.bundleName,
				bundleVersion: mooncg.bundleVersion,
				bundleGit: mooncg.bundleGit,
			},
			(_error, accepted) => {
				/* istanbul ignore if: cant cover navigates page */
				if (accepted) {
					// This event and window boolean are ONLY used for tests.
					// Kinda gross, sorry.
					window.dispatchEvent(new CustomEvent("mooncg-registration-accepted"));
					(window as any).__mooncgRegistrationAccepted__ = true;
				} else {
					/* istanbul ignore next: cant cover navigates page */
					globalThis.location.href = "/instance/busy.html?pathname=" + pathname;
				}
			},
		);
	}
})();
