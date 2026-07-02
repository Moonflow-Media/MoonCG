import type {
	DraggableAttributes,
	DraggableSyntheticListeners,
} from "@dnd-kit/core";
import { initialize } from "@open-iframe-resizer/core";
import type { CSSProperties, Ref, RefObject } from "react";
import { useEffect, useRef, useState } from "react";

import type { MoonCG } from "../../types/mooncg";
import { Icon } from "./Icon";

const HEX_PARSE_SHORTHAND_REGEX = /^#?([a-f\d])([a-f\d])([a-f\d])$/i;
const HEX_PARSE_REGEX = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i;

function hexToRgb(hex: string) {
	const expanded = hex.replace(
		HEX_PARSE_SHORTHAND_REGEX,
		(_m, r: string, g: string, b: string) => r + r + g + g + b + b,
	);

	const result = HEX_PARSE_REGEX.exec(expanded);
	if (!result?.[1] || !result[2] || !result[3]) {
		return null;
	}

	return {
		r: parseInt(result[1], 16),
		g: parseInt(result[2], 16),
		b: parseInt(result[3], 16),
	};
}

function calcButtonsGradient(headerColor: string) {
	const rgb = hexToRgb(headerColor);
	if (!rgb) {
		return undefined;
	}

	const rgbStr = `${rgb.r}, ${rgb.g}, ${rgb.b}`;
	return `linear-gradient(to right, rgba(${rgbStr}, 0) 0px, rgba(${rgbStr}, 1) 10px)`;
}

/**
 * Wires up Sentry error forwarding and (for non-fullbleed panels) the iframe
 * auto-resizer, once the embedded document has loaded.
 */
export function useEmbeddedIframe(
	iframeRef: RefObject<HTMLIFrameElement | null>,
	{ resize }: { resize: boolean },
) {
	useEffect(() => {
		const iframe = iframeRef.current;
		if (!iframe) {
			return;
		}

		const attach = () => {
			// If Sentry is enabled, use it to report errors in panels to Sentry.io.
			if (window.ncgConfig.sentry.enabled) {
				void import("@sentry/browser").then((Sentry) => {
					iframe.contentWindow?.addEventListener("error", (event) => {
						Sentry.captureException(event.error);
					});
					iframe.contentWindow?.addEventListener(
						"unhandledrejection",
						(err) => {
							Sentry.captureException(err.reason);
						},
					);
				});
			}

			if (resize) {
				void initialize(
					{
						onIframeResize: (context) => {
							context.iframe.dispatchEvent(new CustomEvent("iframe-resized"));
						},
					},
					iframe,
				);
			}
		};

		if (iframe.contentWindow?.document.readyState === "complete") {
			attach();
			return;
		}

		iframe.addEventListener("load", attach, { once: true });
		return () => {
			iframe.removeEventListener("load", attach);
		};
	}, []);
}

const OPENED_STORAGE_SUFFIX = "opened";

export interface PanelProps {
	panel: MoonCG.Bundle.Panel;
	fullbleed: boolean;
	dragHandleRef?: Ref<HTMLButtonElement>;
	dragHandleAttributes?: DraggableAttributes;
	dragHandleListeners?: DraggableSyntheticListeners;
}

export function Panel({
	panel,
	fullbleed,
	dragHandleRef,
	dragHandleAttributes,
	dragHandleListeners,
}: PanelProps) {
	const storageKey = [panel.bundleName, panel.name, OPENED_STORAGE_SUFFIX].join(
		".",
	);

	const [opened, setOpened] = useState(() => {
		const raw = localStorage.getItem(storageKey);
		if (raw === null) {
			return true;
		}

		try {
			return Boolean(JSON.parse(raw));
		} catch {
			return true;
		}
	});

	const iframeRef = useRef<HTMLIFrameElement>(null);
	useEmbeddedIframe(iframeRef, { resize: !fullbleed });

	const toggleCollapse = () => {
		setOpened((current) => {
			const next = !current;
			localStorage.setItem(storageKey, JSON.stringify(next));
			return next;
		});
	};

	const iframeSrc = `/bundles/${panel.bundleName}/dashboard/${panel.file}`;
	const standaloneUrl = `${iframeSrc}?standalone=true`;

	const headerStyle: CSSProperties = { backgroundColor: panel.headerColor };
	const buttonsStyle: CSSProperties = {
		background: calcButtonsGradient(panel.headerColor),
	};

	return (
		<>
			<div className="panel-header" style={headerStyle}>
				<span className="panel-title">{panel.title}</span>
				<div className="panel-buttons-container">
					{!fullbleed && (
						<span className="panel-more-indicator">
							<Icon name="chevronLeft" />
						</span>
					)}
					<div className="panel-buttons" style={buttonsStyle}>
						<a
							href={standaloneUrl}
							target="_blank"
							rel="noreferrer"
							data-testid="panel-standalone"
							aria-label="Open in standalone window"
						>
							<button className="icon-button" type="button">
								<Icon name="openInNew" />
							</button>
						</a>

						{!fullbleed && (
							<button
								className="icon-button"
								type="button"
								onClick={toggleCollapse}
								data-testid="panel-collapse"
								aria-label={opened ? "Collapse panel" : "Expand panel"}
							>
								<Icon name={opened ? "unfoldLess" : "unfoldMore"} />
							</button>
						)}

						{!fullbleed && (
							<button
								ref={dragHandleRef}
								className="icon-button panel-drag-handle"
								type="button"
								data-testid="panel-drag-handle"
								aria-label="Move panel"
								{...dragHandleAttributes}
								{...dragHandleListeners}
							>
								<Icon name="openWith" />
							</button>
						)}
					</div>
				</div>
			</div>

			<div className="panel-body" hidden={!fullbleed && !opened}>
				<iframe
					ref={iframeRef}
					src={iframeSrc}
					id={`${panel.bundleName}_${panel.name}_iframe`}
					title={panel.title}
					scrolling={fullbleed ? "yes" : "no"}
					loading="lazy"
				/>
			</div>
		</>
	);
}
