import { useEffect, useRef } from "react";

import type { MoonCG } from "../../types/mooncg";
import { useEmbeddedIframe } from "./Panel";

/**
 * The imperative handle attached to every dialog host element.
 * This is the public contract used by `dashboardApi.getDialog()` and the
 * injected `dialog_opener.js` script.
 */
export interface DashboardDialogElement extends HTMLElement {
	opened: boolean;
	open: () => void;
	close: () => void;
}

function computeDialogs(bundles: MoonCG.Bundle[]) {
	const dialogs: MoonCG.Bundle.Panel[] = [];
	for (const bundle of bundles) {
		for (const panel of bundle.dashboard.panels) {
			if (panel.dialog) {
				dialogs.push(panel);
			}
		}
	}

	return dialogs;
}

export function Dialogs({ bundles }: { bundles: MoonCG.Bundle[] }) {
	const dialogs = computeDialogs(bundles);
	return (
		<div id="dialogs">
			{dialogs.map((dialog) => (
				<DialogHost
					key={`${dialog.bundleName}_${dialog.name}`}
					dialog={dialog}
				/>
			))}
		</div>
	);
}

function calcDialogWidth(dialog: MoonCG.Bundle.Panel) {
	const columns = !dialog.fullbleed && dialog.width ? dialog.width : 4;
	const clamped = Math.min(Math.max(columns, 1), 10);
	return clamped * 128 + (clamped - 1) * 16;
}

function DialogHost({ dialog }: { dialog: MoonCG.Bundle.Panel }) {
	const hostRef = useRef<HTMLDivElement>(null);
	const dialogRef = useRef<HTMLDialogElement>(null);
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const confirmedRef = useRef(false);

	useEmbeddedIframe(iframeRef, { resize: true });

	useEffect(() => {
		const host = hostRef.current;
		const dialogEl = dialogRef.current;
		const iframe = iframeRef.current;
		if (!host || !dialogEl || !iframe) {
			return;
		}

		const dispatchToIframe = (eventName: string) => {
			iframe.contentDocument?.dispatchEvent(new CustomEvent(eventName));
		};

		// Attach the imperative `open()`/`close()`/`opened` contract to the host
		// element, so that `dashboardApi.getDialog()` consumers keep working.
		const handle: Pick<DashboardDialogElement, "open" | "close"> = {
			open: () => {
				confirmedRef.current = false;
				if (!dialogEl.open) {
					dialogEl.showModal();
				}

				dispatchToIframe("dialog-opened");
			},
			close: () => {
				dialogEl.close();
			},
		};
		Object.assign(host, handle);
		Object.defineProperty(host, "opened", {
			configurable: true,
			get: () => dialogEl.open,
		});

		const handleClose = () => {
			dispatchToIframe(
				confirmedRef.current ? "dialog-confirmed" : "dialog-dismissed",
			);
			confirmedRef.current = false;
		};

		dialogEl.addEventListener("close", handleClose);
		return () => {
			dialogEl.removeEventListener("close", handleClose);
		};
	}, []);

	const buttons = dialog.dialogButtons ?? [];

	return (
		<div
			ref={hostRef}
			id={`${dialog.bundleName}_${dialog.name}`}
			data-testid={`dialog-${dialog.bundleName}-${dialog.name}`}
			data-dialog-bundle={dialog.bundleName}
			data-dialog-name={dialog.name}
		>
			<dialog
				ref={dialogRef}
				className="ncg-dialog"
				style={{ width: calcDialogWidth(dialog) }}
			>
				<div className="dialog-inner">
					{Boolean(dialog.title) && <h2>{dialog.title}</h2>}

					<div className="dialog-content">
						<iframe
							ref={iframeRef}
							src={`/bundles/${dialog.bundleName}/dashboard/${dialog.file}`}
							id={`${dialog.bundleName}_${dialog.name}_iframe`}
							title={dialog.title}
							scrolling="no"
							loading="lazy"
						/>
					</div>

					{buttons.length > 0 && (
						<div className="buttons">
							{buttons.map((button) => (
								<DialogButton
									key={button.name}
									button={button}
									onClick={() => {
										confirmedRef.current = button.type === "confirm";
										dialogRef.current?.close();
									}}
								/>
							))}
						</div>
					)}
				</div>
			</dialog>
		</div>
	);
}

function DialogButton({
	button,
	onClick,
}: {
	button: { name: string; type: "dismiss" | "confirm" };
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			className={
				button.type === "confirm"
					? "ncg-button mooncg-accept"
					: "ncg-button mooncg-reject"
			}
			// `dialog-confirm`/`dialog-dismiss` are part of the public dialog
			// markup contract; React's typings have no notion of them, so they
			// are set via a ref callback.
			ref={(el) => {
				el?.setAttribute(
					button.type === "confirm" ? "dialog-confirm" : "dialog-dismiss",
					"",
				);
			}}
			onClick={onClick}
		>
			{button.name}
		</button>
	);
}
