import { useRef } from "react";

import { Icon } from "./Icon";
import { useToast } from "./toasts";

export function SettingsPage() {
	const showToast = useToast();
	const showKeyDialogRef = useRef<HTMLDialogElement>(null);
	const resetKeyDialogRef = useRef<HTMLDialogElement>(null);

	const token =
		window.ncgConfig.login?.enabled && window.token ? window.token : "";

	const copyKey = () => {
		void navigator.clipboard.writeText(token).then(
			() => {
				showToast("Key copied to clipboard.");
			},
			() => {
				showToast("Failed to copy key to clipboard!");
			},
		);
	};

	const resetKey = () => {
		resetKeyDialogRef.current?.close();
		window.socket.emit("regenerateToken", (err) => {
			if (err) {
				console.error(err);
				return;
			}

			document.location.reload();
		});
	};

	return (
		<div className="settings-page" data-testid="settings">
			<div className="ncg-card">
				<div className="card-heading">Your Key</div>
				<div className="card-content">
					<p style={{ marginTop: 0 }}>
						Resetting your key will disrupt all current sessions using it.
						<br />
						When you reset your key, the dashboard will be refreshed so that a
						new key can be obtained.
					</p>
					<div className="card-actions">
						<button
							type="button"
							className="ncg-button mooncg-benign"
							data-testid="settings-copy-key"
							onClick={copyKey}
						>
							<Icon name="contentCopy" />
							<span>Copy Key</span>
						</button>
						<button
							type="button"
							className="ncg-button mooncg-configure"
							data-testid="settings-show-key"
							title="Show Key"
							onClick={() => showKeyDialogRef.current?.showModal()}
						>
							<Icon name="vpnKey" />
							<span>Show Key</span>
						</button>
						<button
							type="button"
							className="ncg-button mooncg-reject"
							data-testid="settings-reset-key"
							onClick={() => resetKeyDialogRef.current?.showModal()}
						>
							<Icon name="refresh" />
							<span>Reset Key</span>
						</button>
					</div>
				</div>
			</div>

			<dialog ref={showKeyDialogRef} className="confirm-dialog">
				<h2>MoonCG Key</h2>
				<div className="confirm-dialog-body">
					<code data-testid="settings-key">{token}</code>
					<p className="text-warning">
						<b>Do not</b> give this key to anyone or show it on stream!
						<br />
						If you accidentally reveal it, <b>reset it immediately!</b>
					</p>
				</div>
				<div className="buttons">
					<button
						type="button"
						className="ncg-button mooncg-benign"
						onClick={() => showKeyDialogRef.current?.close()}
					>
						Close
					</button>
				</div>
			</dialog>

			<dialog ref={resetKeyDialogRef} className="confirm-dialog">
				<h2>Reset MoonCG Key</h2>
				<div className="confirm-dialog-body">
					<p className="text-warning">
						Are you sure you wish to reset your <b>MoonCG key</b>?
						<br />
						Doing so will invalidate all URLs currently loaded into your
						streaming software!
					</p>
				</div>
				<div className="buttons">
					<button
						type="button"
						className="ncg-button mooncg-benign"
						onClick={() => resetKeyDialogRef.current?.close()}
					>
						No, Cancel
					</button>
					<button
						type="button"
						className="ncg-button mooncg-reject"
						data-testid="settings-reset-confirm"
						onClick={resetKey}
					>
						Yes, reset
					</button>
				</div>
			</dialog>
		</div>
	);
}
