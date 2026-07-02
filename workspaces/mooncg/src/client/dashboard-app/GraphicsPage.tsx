import type { DragEvent } from "react";
import { useEffect, useRef, useState } from "react";

import type { MoonCG } from "../../types/mooncg";
import { useMediaQuery, useReplicant } from "./hooks";
import { Icon } from "./Icon";
import { useToast } from "./toasts";

export function GraphicsPage() {
	const bundlesWithGraphics = window.__renderData__.bundles.filter(
		(bundle) => bundle.graphics && bundle.graphics.length > 0,
	);

	const { value: instances } = useReplicant<MoonCG.GraphicsInstance[]>(
		"graphics:instances",
		"mooncg",
	);

	return (
		<div className="graphics-page" data-testid="graphics">
			{bundlesWithGraphics.map((bundle) => (
				<GraphicsBundle
					key={bundle.name}
					bundle={bundle}
					instances={instances ?? []}
				/>
			))}
		</div>
	);
}

function GraphicsBundle({
	bundle,
	instances,
}: {
	bundle: MoonCG.Bundle;
	instances: MoonCG.GraphicsInstance[];
}) {
	const confirmDialogRef = useRef<HTMLDialogElement>(null);
	const [reloading, setReloading] = useState(false);

	const reloadAll = () => {
		confirmDialogRef.current?.close();
		setReloading(true);
		window.socket.emit("graphic:requestBundleRefresh", bundle.name, () => {
			setReloading(false);
		});
	};

	return (
		<div
			className="graphics-bundle"
			data-testid={`graphics-bundle-${bundle.name}`}
		>
			<div className="graphics-bundle-title-bar">
				<div className="graphics-bundle-name">{bundle.name}</div>
				<button
					type="button"
					className="ncg-button mooncg-execute"
					data-testid="bundle-reload-all"
					disabled={reloading}
					onClick={() => confirmDialogRef.current?.showModal()}
				>
					<Icon name="refresh" />
					<span>Reload All</span>
				</button>
			</div>

			{bundle.graphics.map((graphic) => (
				<Graphic
					key={graphic.url}
					graphic={graphic}
					instances={instances.filter(
						(instance) =>
							instance.bundleName === bundle.name &&
							instance.pathName === graphic.url,
					)}
				/>
			))}

			<dialog ref={confirmDialogRef} className="confirm-dialog">
				<h2>Confirm Reload</h2>
				<div className="confirm-dialog-body">
					<p>
						Are you sure you want to reload all open instances of{" "}
						<b>{bundle.name}</b> graphics?
					</p>
				</div>
				<div className="buttons">
					<button
						type="button"
						className="ncg-button mooncg-reject"
						data-testid="bundle-reload-all-cancel"
						onClick={() => confirmDialogRef.current?.close()}
					>
						No, Cancel
					</button>
					<button
						type="button"
						className="ncg-button mooncg-accept"
						data-testid="bundle-reload-all-confirm"
						autoFocus
						onClick={reloadAll}
					>
						Yes, Reload
					</button>
				</div>
			</dialog>
		</div>
	);
}

function computeWorstStatus(instances: MoonCG.GraphicsInstance[]) {
	const openInstances = instances.filter((instance) => instance.open);
	if (openInstances.length <= 0) {
		return "none";
	}

	const outOfDateInstance = openInstances.find(
		(instance) => instance.potentiallyOutOfDate,
	);
	return outOfDateInstance ? "out-of-date" : "nominal";
}

function computeFullGraphicUrl(url: string) {
	const absUrl = new URL(url, window.location.href).href;
	if (window.ncgConfig.login?.enabled && window.token) {
		return `${absUrl}?key=${window.token}`;
	}

	return absUrl;
}

function calcShortUrl(graphicUrl: string) {
	return graphicUrl.split("/").slice(4).join("/");
}

function Graphic({
	graphic,
	instances,
}: {
	graphic: MoonCG.Bundle.Graphic;
	instances: MoonCG.GraphicsInstance[];
}) {
	const showToast = useToast();
	const [collapseOpened, setCollapseOpened] = useState(false);
	const [reloading, setReloading] = useState(false);

	const worstStatus = computeWorstStatus(instances);
	const fullUrl = computeFullGraphicUrl(graphic.url);
	const count = graphic.singleInstance
		? "S"
		: instances.filter((instance) => instance.open).length;

	const copyUrl = () => {
		void navigator.clipboard.writeText(fullUrl).then(
			() => {
				showToast("Graphic URL copied to clipboard.");
			},
			() => {
				showToast("Failed to copy graphic URL to clipboard!");
			},
		);
	};

	const reloadAll = () => {
		setReloading(true);
		window.socket.emit("graphic:requestRefreshAll", graphic, () => {
			setReloading(false);
		});
	};

	const handleDragStart = (event: DragEvent<HTMLAnchorElement>) => {
		if (!event.dataTransfer) {
			return;
		}

		const separator =
			window.ncgConfig.login?.enabled && window.token ? "&" : "?";
		const obsUrl =
			`${event.currentTarget.href}${separator}` +
			`layer-name=${graphic.file.replace(".html", "")}` +
			`&layer-height=${graphic.height}&layer-width=${graphic.width}`;
		event.dataTransfer.setData("text/uri-list", obsUrl);
	};

	return (
		<div
			className="graphic"
			data-testid="graphic"
			data-graphic-url={graphic.url}
		>
			<div className="graphic-details">
				<div className={`graphic-indicator ${worstStatus}`} />

				<div className="graphic-counter" data-testid="graphic-count">
					{count}
				</div>

				<div className="graphic-url-and-resolution">
					<a
						className="graphic-url"
						data-testid="graphic-url"
						href={fullUrl}
						target="_blank"
						rel="noreferrer"
						title={calcShortUrl(graphic.url)}
						onDragStart={handleDragStart}
					>
						{calcShortUrl(graphic.url)}
					</a>
					<div className="graphic-resolution">
						{graphic.width}x{graphic.height}
					</div>
				</div>

				<button
					type="button"
					className="ncg-button graphic-copy-button"
					data-testid="graphic-copy-url"
					onClick={copyUrl}
				>
					<Icon name="contentCopy" />
					<span className="button-text">Copy URL</span>
				</button>

				<button
					type="button"
					className="ncg-button graphic-reload-button"
					data-testid="graphic-reload"
					disabled={reloading || instances.length <= 0}
					onClick={reloadAll}
				>
					<Icon name="refresh" />
					<span className="button-text">Reload</span>
				</button>

				<button
					type="button"
					className="ncg-button graphic-collapse-button"
					data-testid="graphic-collapse"
					onClick={() => setCollapseOpened((open) => !open)}
				>
					<Icon name={collapseOpened ? "unfoldLess" : "unfoldMore"} />
				</button>
			</div>

			<div hidden={!collapseOpened}>
				{instances.map((instance) => (
					<GraphicInstance
						key={instance.socketId}
						graphic={graphic}
						instance={instance}
					/>
				))}
			</div>
		</div>
	);
}

function computeInstanceStatus(instance: MoonCG.GraphicsInstance) {
	if (!instance.open) {
		return "closed";
	}

	return instance.potentiallyOutOfDate ? "out-of-date" : "nominal";
}

function calcIndicatorIcon(status: string) {
	switch (status) {
		case "nominal":
			return "check" as const;
		case "out-of-date":
			return "warning" as const;
		default:
			return "close" as const;
	}
}

function calcStatusMessage(status: string, wide: boolean) {
	switch (status) {
		case "nominal":
			return "Latest";
		case "out-of-date":
			return wide ? "Potentially Out of Date" : "Out of Date";
		case "closed":
			return "Closed";
		default:
			return "Error";
	}
}

function timeSince(date: number) {
	const seconds = Math.floor(new Date().getTime() / 1000 - date / 1000);
	let interval = Math.floor(seconds / 31536000);

	if (interval > 1) {
		return `${interval} year`;
	}

	interval = Math.floor(seconds / 2592000);
	if (interval > 1) {
		return `${interval} month`;
	}

	interval = Math.floor(seconds / 86400);
	if (interval >= 1) {
		return `${interval} day`;
	}

	interval = Math.floor(seconds / 3600);
	if (interval >= 1) {
		return `${interval} hour`;
	}

	interval = Math.floor(seconds / 60);
	if (interval > 1) {
		return `${interval} min`;
	}

	return `${Math.floor(seconds)} sec`;
}

function GraphicInstance({
	graphic,
	instance,
}: {
	graphic: MoonCG.Bundle.Graphic;
	instance: MoonCG.GraphicsInstance;
}) {
	const wide = useMediaQuery("(min-width: 641px)");
	const status = computeInstanceStatus(instance);
	const [reloading, setReloading] = useState(false);
	const [killing, setKilling] = useState(false);
	const [diffVisible, setDiffVisible] = useState(false);
	const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);

	// Re-render every second so the "time since" column stays current.
	const [, setPulse] = useState(0);
	useEffect(() => {
		const interval = setInterval(() => {
			setPulse((count) => count + 1);
		}, 1000);
		return () => {
			clearInterval(interval);
		};
	}, []);

	const showDiff = () => {
		clearTimeout(hideTimeoutRef.current);
		hideTimeoutRef.current = undefined;
		setDiffVisible(true);
	};

	const hideDiff = (immediate: boolean) => {
		if (immediate) {
			clearTimeout(hideTimeoutRef.current);
			hideTimeoutRef.current = undefined;
			setDiffVisible(false);
		} else if (hideTimeoutRef.current === undefined) {
			hideTimeoutRef.current = setTimeout(() => {
				hideTimeoutRef.current = undefined;
				setDiffVisible(false);
			}, 250);
		}
	};

	const reload = () => {
		setReloading(true);
		window.socket.emit("graphic:requestRefresh", instance, () => {
			setReloading(false);
		});
	};

	const kill = () => {
		setKilling(true);
		window.socket.emit("graphic:requestKill", instance, () => {
			setKilling(false);
		});
	};

	return (
		<div
			className={`graphic-instance ${status}`}
			data-testid="graphic-instance"
			data-status={status}
		>
			<div className="graphic-instance-indicator" />

			<div className="graphic-instance-icon">
				<Icon name={calcIndicatorIcon(status)} />
			</div>

			<div className="graphic-instance-ip">
				<span title={instance.ipv4}>{instance.ipv4}</span>
			</div>

			<div
				className="graphic-instance-status"
				onMouseEnter={showDiff}
				onMouseLeave={() => hideDiff(false)}
			>
				{calcStatusMessage(status, wide)}
			</div>

			<div className="graphic-instance-duration">
				<Icon name="accessTime" size={18} />
				<span>{timeSince(instance.timestamp)}</span>
			</div>

			<button
				type="button"
				className="ncg-button instance-reload-button"
				data-testid="instance-reload"
				disabled={reloading}
				onClick={reload}
			>
				<Icon name="refresh" />
			</button>

			{graphic.singleInstance && (
				<button
					type="button"
					className="ncg-button instance-kill-button"
					data-testid="instance-kill"
					disabled={killing}
					onClick={kill}
				>
					<Icon name="close" />
				</button>
			)}

			{status === "out-of-date" && diffVisible && (
				<GraphicInstanceDiff
					instance={instance}
					onMouseEnter={showDiff}
					onMouseLeave={() => hideDiff(false)}
					onClose={() => hideDiff(true)}
				/>
			)}
		</div>
	);
}

function formatCommitMessage(message: string | undefined) {
	if (!message) {
		return "[No commit message.]";
	}

	const truncated = message.length > 50 ? `${message.slice(0, 50)}…` : message;
	return `[${truncated}]`;
}

function GraphicInstanceDiff({
	instance,
	onMouseEnter,
	onMouseLeave,
	onClose,
}: {
	instance: MoonCG.GraphicsInstance;
	onMouseEnter: () => void;
	onMouseLeave: () => void;
	onClose: () => void;
}) {
	const { value: bundles } = useReplicant<MoonCG.Bundle[]>("bundles", "mooncg");
	const bundle = bundles?.find((b) => b.name === instance.bundleName);

	const instanceGit = instance.bundleGit;
	const bundleGit = bundle?.git;

	return (
		<div
			className="graphic-instance-diff"
			data-testid="graphic-instance-diff"
			onMouseEnter={onMouseEnter}
			onMouseLeave={onMouseLeave}
		>
			<button
				type="button"
				className="icon-button"
				aria-label="Close"
				onClick={onClose}
			>
				<Icon name="close" />
			</button>
			<div>
				<div style={{ marginBottom: 4 }}>
					<span className="orange">Current:</span>{" "}
					<span>
						{instance.bundleVersion} - {instanceGit?.shortHash}{" "}
						{formatCommitMessage(
							instanceGit && "message" in instanceGit
								? instanceGit.message
								: undefined,
						)}
					</span>
				</div>
				<div style={{ marginTop: 4 }}>
					<span className="green">Latest:&nbsp;</span>{" "}
					<span>
						{bundle?.version} - {bundleGit?.shortHash}{" "}
						{formatCommitMessage(
							bundleGit && "message" in bundleGit
								? bundleGit.message
								: undefined,
						)}
					</span>
				</div>
			</div>
		</div>
	);
}
