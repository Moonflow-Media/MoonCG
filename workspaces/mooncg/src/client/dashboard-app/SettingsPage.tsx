import { toDataURL } from "qrcode";
import type { FormEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ApiSession, TotpEnrollment } from "./auth-api";
import { authApi, formatApiError } from "./auth-api";
import { Icon } from "./Icon";
import { useToast } from "./toasts";
import { SessionRow } from "./UsersPage";

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

			<TwoFactorCard />
			<SessionsCard />

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

function TwoFactorCard() {
	const showToast = useToast();
	const [totpEnabled, setTotpEnabled] = useState<boolean | null>(null);
	const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null);
	const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
	const [token, setToken] = useState("");
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		authApi.getMe().then(
			(me) => {
				setTotpEnabled(me.totp_enabled);
			},
			(error: unknown) => {
				showToast(`Failed to load 2FA status: ${formatApiError(error)}`);
			},
		);
	}, [showToast]);

	const enroll = () => {
		setBusy(true);
		authApi
			.enrollTotp()
			.then(async (result) => {
				setEnrollment(result);
				setQrDataUrl(await toDataURL(result.otpauthUrl));
			})
			.catch((error: unknown) => {
				showToast(formatApiError(error));
			})
			.finally(() => {
				setBusy(false);
			});
	};

	const verify = (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		authApi
			.verifyTotp(token)
			.then(() => {
				showToast("Two-factor authentication enabled.");
				setTotpEnabled(true);
				setEnrollment(null);
				setQrDataUrl(null);
				setToken("");
			})
			.catch((error: unknown) => {
				showToast(formatApiError(error));
			})
			.finally(() => {
				setBusy(false);
			});
	};

	const disable = (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		authApi
			.disableTotp(token)
			.then(() => {
				showToast("Two-factor authentication disabled.");
				setTotpEnabled(false);
				setToken("");
			})
			.catch((error: unknown) => {
				showToast(formatApiError(error));
			})
			.finally(() => {
				setBusy(false);
			});
	};

	return (
		<div className="ncg-card" data-testid="settings-2fa">
			<div className="card-heading">Two-Factor Authentication</div>
			<div className="card-content">
				{totpEnabled === null && <div className="spinner" title="Loading" />}

				{totpEnabled === false && !enrollment && (
					<>
						<p style={{ marginTop: 0 }}>
							Two-factor authentication is currently <b>disabled</b>. Protect
							your account with a one-time code from an authenticator app.
						</p>
						<div className="card-actions">
							<button
								type="button"
								className="ncg-button mooncg-accept"
								data-testid="settings-2fa-enroll"
								disabled={busy}
								onClick={enroll}
							>
								<Icon name="vpnKey" />
								<span>Set Up 2FA</span>
							</button>
						</div>
					</>
				)}

				{totpEnabled === false && enrollment && (
					<form onSubmit={verify}>
						<p style={{ marginTop: 0 }}>
							Scan this QR code with your authenticator app, or enter the secret
							manually. Then enter the current code to finish setup.
						</p>
						{qrDataUrl && (
							<img
								className="totp-qr"
								data-testid="settings-2fa-qr"
								src={qrDataUrl}
								alt="QR code for authenticator app enrollment"
							/>
						)}
						<code data-testid="settings-2fa-secret">{enrollment.secret}</code>
						<label className="form-field">
							<span>Authenticator code</span>
							<input
								type="text"
								required
								autoComplete="one-time-code"
								inputMode="numeric"
								data-testid="settings-2fa-token"
								value={token}
								onChange={(event) => {
									setToken(event.target.value);
								}}
							/>
						</label>
						<div className="card-actions">
							<button
								type="submit"
								className="ncg-button mooncg-accept"
								data-testid="settings-2fa-verify"
								disabled={busy}
							>
								<Icon name="check" />
								<span>Verify &amp; Enable</span>
							</button>
						</div>
					</form>
				)}

				{totpEnabled === true && (
					<form onSubmit={disable}>
						<p style={{ marginTop: 0 }} data-testid="settings-2fa-status">
							Two-factor authentication is <b>enabled</b> for your account.
							<br />
							To disable it, enter a current authenticator code.
						</p>
						<label className="form-field">
							<span>Authenticator code</span>
							<input
								type="text"
								required
								autoComplete="one-time-code"
								inputMode="numeric"
								data-testid="settings-2fa-token"
								value={token}
								onChange={(event) => {
									setToken(event.target.value);
								}}
							/>
						</label>
						<div className="card-actions">
							<button
								type="submit"
								className="ncg-button mooncg-reject"
								data-testid="settings-2fa-disable"
								disabled={busy}
							>
								<Icon name="delete" />
								<span>Disable 2FA</span>
							</button>
						</div>
					</form>
				)}
			</div>
		</div>
	);
}

function SessionsCard() {
	const showToast = useToast();
	const [sessions, setSessions] = useState<ApiSession[] | null>(null);

	const refresh = useCallback(() => {
		authApi.listMySessions().then(setSessions, (error: unknown) => {
			showToast(`Failed to load sessions: ${formatApiError(error)}`);
		});
	}, [showToast]);

	useEffect(() => {
		refresh();
	}, [refresh]);

	const revoke = (sessionId: string) => {
		authApi
			.revokeMySession(sessionId)
			.then(() => {
				showToast("Session terminated.");
				refresh();
			})
			.catch((error: unknown) => {
				showToast(formatApiError(error));
			});
	};

	return (
		<div className="ncg-card" data-testid="settings-sessions">
			<div className="card-heading">Active Sessions</div>
			<div className="card-content">
				{sessions === null ? (
					<div className="spinner" title="Loading" />
				) : (
					<div className="session-list" data-session-count={sessions.length}>
						{sessions.map((session) => (
							<SessionRow
								key={session.id}
								session={session}
								testId="settings-session-row"
								revokeTestId="settings-session-revoke"
								onRevoke={() => {
									revoke(session.id);
								}}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
