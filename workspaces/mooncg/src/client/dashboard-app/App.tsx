import { useEffect, useMemo, useState } from "react";

import { AssetsPage } from "./AssetsPage";
import { authApi } from "./auth-api";
import { Dialogs } from "./Dialogs";
import { GraphicsPage } from "./GraphicsPage";
import { useHashRoute, useMediaQuery } from "./hooks";
import type { IconName } from "./Icon";
import { Icon } from "./Icon";
import { MixerPage } from "./MixerPage";
import { SettingsPage } from "./SettingsPage";
import { ToastProvider, ToastViewport, useToastState } from "./toasts";
import { UsersPage } from "./UsersPage";
import { WorkspaceView } from "./Workspace";

interface PageDef {
	name: string;
	route: string;
	icon: IconName;
}

function getPages(canManageUsers: boolean): PageDef[] {
	const pages: PageDef[] = [
		{ name: "Graphics", route: "graphics", icon: "visibility" },
		{ name: "Mixer", route: "mixer", icon: "volumeUp" },
		{ name: "Assets", route: "assets", icon: "fileUpload" },
	];

	// User management is only available with login security enabled and
	// requires WRITE permission on "users:*" (superuser/admin).
	if (window.ncgConfig.login?.enabled && canManageUsers) {
		pages.push({ name: "Users", route: "users", icon: "people" });
	}

	// For the time being, the "Settings" button is only relevant
	// when login security is enabled.
	if (window.ncgConfig.login?.enabled) {
		pages.push({ name: "Settings", route: "settings", icon: "settings" });
	}

	return pages;
}

/**
 * Fetches the logged-in user's permission to manage users (from
 * GET /api/v1/me). Resolves to `false` while loading and when login
 * security is disabled; `loaded` flips to true once the answer is known.
 */
function useCanManageUsers() {
	const loginEnabled = Boolean(window.ncgConfig.login?.enabled);
	const [state, setState] = useState({
		canManageUsers: false,
		loaded: !loginEnabled,
	});

	useEffect(() => {
		if (!loginEnabled) {
			return;
		}

		authApi.getMe().then(
			(me) => {
				setState({ canManageUsers: me.canManageUsers, loaded: true });
			},
			(error: unknown) => {
				console.error("Failed to fetch the current user:", error);
				setState({ canManageUsers: false, loaded: true });
			},
		);
	}, [loginEnabled]);

	return state;
}

function getImageDataUri(url: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => {
			const canvas = document.createElement("canvas");
			canvas.width = img.width;
			canvas.height = img.height;
			const ctx = canvas.getContext("2d");
			if (!ctx) {
				reject(new Error("Could not create canvas context"));
				return;
			}

			ctx.drawImage(img, 0, 0);
			try {
				resolve(canvas.toDataURL());
			} catch (error) {
				reject(error instanceof Error ? error : new Error(String(error)));
			} finally {
				canvas.remove();
			}
		};
		img.onerror = () => {
			reject(new Error(`Failed to load image: ${url}`));
		};
		img.src = url;
	});
}

function notify(
	title: string,
	options: { body?: string; icon?: string; tag?: string } = {},
) {
	if (!("Notification" in window)) {
		return;
	}

	// Chrome does not implement the permission static property,
	// so we have to check for NOT 'denied' instead of 'default'.
	if (window.Notification.permission === "granted") {
		const notification = new window.Notification(title, options);
		setTimeout(() => {
			notification.close();
		}, 5000);
	} else if (window.Notification.permission !== "denied") {
		void window.Notification.requestPermission((permission) => {
			if (permission === "granted") {
				const notification = new window.Notification(title, options);
				setTimeout(() => {
					notification.close();
				}, 5000);
			}
		});
	}
}

/**
 * Tracks how often each bundle has requested a client refresh via the
 * `dashboard:bundleRefresh` socket event. The counters are used as React
 * keys on panel/dialog iframes, so bumping a counter reloads all iframes of
 * that bundle (collapse state and sort order survive, they live in
 * localStorage).
 */
function useBundleRefreshCounts() {
	const [counts, setCounts] = useState<Record<string, number>>({});

	useEffect(() => {
		const handler = (bundleName: string) => {
			setCounts((current) => ({
				...current,
				[bundleName]: (current[bundleName] ?? 0) + 1,
			}));
		};

		window.socket.on("dashboard:bundleRefresh", handler);
		return () => {
			window.socket.off("dashboard:bundleRefresh", handler);
		};
	}, []);

	return counts;
}

/**
 * Wires up the socket lifecycle: connection toasts, desktop notifications,
 * and the auth-error redirect.
 */
function useSocketStatus(showToast: (text: string) => void) {
	const [reconnecting, setReconnecting] = useState(false);

	useEffect(() => {
		// Images are stored as data URIs so that they can be displayed
		// even with no connection to the server.
		let failUri: string | undefined;
		let successUri: string | undefined;
		let notified = false;

		void getImageDataUri("img/notifications/standard/fail.png").then(
			(uri) => (failUri = uri),
			(error: unknown) => {
				console.error(error);
			},
		);
		void getImageDataUri("img/notifications/standard/success.png").then(
			(uri) => (successUri = uri),
			(error: unknown) => {
				console.error(error);
			},
		);

		window.socket.on("protocol_error", (err) => {
			if (err.type === "UnauthorizedError") {
				window.location.href = `/authError?code=${err.code}&message=${err.message}`;
			} else {
				console.error("Unhandled socket error:", err);
				showToast("Unhandled socket error!");
			}
		});

		window.socket.on("disconnect", () => {
			showToast("Lost connection to MoonCG server!");
			notified = false;
		});

		window.socket.io.on("reconnect_attempt", (attempts) => {
			setReconnecting(true);

			if (attempts >= 3 && !notified) {
				notified = true;
				notify("Disconnected", {
					body: "The dashboard has lost connection with MoonCG.",
					icon: failUri,
					tag: "disconnect",
				});
			}
		});

		window.socket.io.on("reconnect", (attempts) => {
			showToast("Reconnected to MoonCG server!");
			setReconnecting(false);

			if (attempts >= 3) {
				notify("Reconnected", {
					body: `Successfully reconnected on attempt # ${attempts}`,
					icon: successUri,
					tag: "reconnect",
				});
			}
		});

		window.socket.io.on("reconnect_failed", () => {
			showToast("Failed to reconnect to MoonCG server!");

			notify("Reconnection Failed", {
				body: "Could not reconnect to MoonCG after the maximum number of attempts.",
				icon: failUri,
				tag: "reconnect_failed",
			});
		});
		// The socket is a global singleton and the App never unmounts,
		// so no cleanup is necessary.
	}, [showToast]);

	return reconnecting;
}

export function App() {
	const { workspaces, bundles } = window.__renderData__;
	const { canManageUsers, loaded: permissionsLoaded } = useCanManageUsers();
	const pages = useMemo(() => getPages(canManageUsers), [canManageUsers]);
	const route = useHashRoute();
	const smallScreen = useMediaQuery("(max-width: 640px)");
	const [drawerOpen, setDrawerOpen] = useState(false);
	const { toasts, showToast } = useToastState();
	const reconnecting = useSocketStatus(showToast);
	const bundleRefreshCounts = useBundleRefreshCounts();
	const loginEnabled = Boolean(window.ncgConfig.login?.enabled);

	// If the current hash points to a route that doesn't exist (such as after
	// a refresh which removed a workspace, or when the default workspace is
	// hidden because it has no panels), fall back to the first workspace.
	// Waits for the permission check so that a direct navigation to #users
	// isn't redirected away while the page list is still incomplete.
	useEffect(() => {
		if (!permissionsLoaded) {
			return;
		}

		const knownRoutes = [
			...workspaces.map((workspace) => workspace.route),
			...pages.map((page) => page.route),
		];
		if (!knownRoutes.includes(route)) {
			window.location.hash = workspaces[0]?.route ?? "";
		}
	}, [route, workspaces, pages, permissionsLoaded]);

	// Close the drawer when the screen grows past the phone breakpoint.
	useEffect(() => {
		if (!smallScreen) {
			setDrawerOpen(false);
		}
	}, [smallScreen]);

	const selectRoute = (newRoute: string) => {
		window.location.hash = newRoute;
		setDrawerOpen(false);
	};

	return (
		<ToastProvider showToast={showToast}>
			<div className="dashboard-app" data-testid="dashboard-app">
				<header className="app-header">
					<button
						type="button"
						className="icon-button hamburger"
						aria-label="Toggle navigation menu"
						data-testid="drawer-toggle"
						onClick={() => setDrawerOpen((open) => !open)}
					>
						<Icon name="menu" />
					</button>

					<img
						className="main-logo"
						src="/dashboard/img/square-logo.png"
						alt="MoonCG"
					/>

					<nav className="tabs workspace-tabs">
						{workspaces.map((workspace) => (
							<button
								key={workspace.route}
								type="button"
								className={
									route === workspace.route
										? "tab workspace-tab active"
										: "tab workspace-tab"
								}
								data-route={workspace.route}
								data-testid={`tab-workspace-${workspace.name}`}
								aria-label={workspace.name}
								onClick={() => selectRoute(workspace.route)}
							>
								{workspace.label}
							</button>
						))}
					</nav>

					<nav className="tabs">
						{pages.map((page) => (
							<button
								key={page.route}
								type="button"
								className={route === page.route ? "tab active" : "tab"}
								data-route={page.route}
								data-testid={`tab-${page.route}`}
								aria-label={page.name}
								onClick={() => selectRoute(page.route)}
							>
								<Icon name={page.icon} />
								{page.name}
							</button>
						))}

						{loginEnabled && (
							<button
								type="button"
								className="tab"
								data-testid="tab-sign-out"
								aria-label="Sign Out"
								onClick={() => {
									window.location.href = "/logout";
								}}
							>
								<Icon name="exitToApp" />
								Sign Out
							</button>
						)}
					</nav>
				</header>

				{drawerOpen && (
					<>
						<div
							className="drawer-backdrop"
							onClick={() => setDrawerOpen(false)}
						/>
						<div className="drawer" data-testid="drawer">
							<div className="drawer-toolbar">
								<button
									type="button"
									className="icon-button"
									aria-label="Close"
									onClick={() => setDrawerOpen(false)}
								>
									<Icon name="close" />
								</button>
								<img src="/dashboard/img/horiz-logo-2x.png" alt="MoonCG" />
							</div>

							<div className="drawer-list">
								{workspaces.map((workspace) => (
									<a
										key={workspace.route}
										href={`#${workspace.route}`}
										className={route === workspace.route ? "active" : undefined}
										aria-label={workspace.name}
										onClick={() => setDrawerOpen(false)}
									>
										<Icon name="dashboard" />
										<span>{workspace.label}</span>
									</a>
								))}

								{pages.map((page) => (
									<a
										key={page.route}
										href={`#${page.route}`}
										className={route === page.route ? "active" : undefined}
										aria-label={page.name}
										onClick={() => setDrawerOpen(false)}
									>
										<Icon name={page.icon} />
										<span>{page.name}</span>
									</a>
								))}

								{loginEnabled && (
									<a href="/logout" aria-label="Sign Out">
										<Icon name="exitToApp" />
										<span>Sign Out</span>
									</a>
								)}
							</div>
						</div>
					</>
				)}

				<main id="pages">
					{/*
					 * All pages stay mounted and are merely hidden, mirroring the old
					 * iron-pages behavior. This keeps panel iframes alive across tab
					 * switches and keeps background pages (e.g. the mixer) reactive.
					 */}
					{workspaces.map((workspace) => (
						<section
							key={workspace.route}
							className="section-workspace"
							data-testid={`workspace-${workspace.name}`}
							hidden={route !== workspace.route}
						>
							<WorkspaceView
								workspace={workspace}
								bundleRefreshCounts={bundleRefreshCounts}
							/>
						</section>
					))}

					<section data-testid="page-graphics" hidden={route !== "graphics"}>
						<GraphicsPage />
					</section>

					<section data-testid="page-mixer" hidden={route !== "mixer"}>
						<MixerPage />
					</section>

					<section data-testid="page-assets" hidden={route !== "assets"}>
						<AssetsPage />
					</section>

					{loginEnabled && canManageUsers && (
						<section data-testid="page-users" hidden={route !== "users"}>
							<UsersPage />
						</section>
					)}

					{loginEnabled && (
						<section data-testid="page-settings" hidden={route !== "settings"}>
							<SettingsPage />
						</section>
					)}
				</main>

				<Dialogs bundles={bundles} bundleRefreshCounts={bundleRefreshCounts} />

				<ToastViewport toasts={toasts} reconnecting={reconnecting} />
			</div>
		</ToastProvider>
	);
}
