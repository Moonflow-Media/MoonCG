import type { FormEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ApiRole, ApiSession, ApiUser } from "./auth-api";
import { authApi, formatApiError } from "./auth-api";
import { Icon } from "./Icon";
import { useToast } from "./toasts";

type DialogState =
	| { type: "create" }
	| { type: "edit"; user: ApiUser }
	| { type: "delete"; user: ApiUser }
	| { type: "reset2fa"; user: ApiUser }
	| { type: "sessions"; user: ApiUser };

export function UsersPage() {
	const showToast = useToast();
	const [users, setUsers] = useState<ApiUser[] | null>(null);
	const [roles, setRoles] = useState<ApiRole[]>([]);
	const [dialog, setDialog] = useState<DialogState | null>(null);

	const refresh = useCallback(() => {
		authApi.listUsers().then(setUsers, (error: unknown) => {
			showToast(`Failed to load users: ${formatApiError(error)}`);
		});
	}, [showToast]);

	useEffect(() => {
		refresh();
		authApi.listRoles().then(setRoles, (error: unknown) => {
			showToast(`Failed to load roles: ${formatApiError(error)}`);
		});
	}, [refresh, showToast]);

	const closeDialog = () => {
		setDialog(null);
	};

	const closeAndRefresh = () => {
		setDialog(null);
		refresh();
	};

	return (
		<div className="users-page" data-testid="users">
			<div className="ncg-card">
				<div className="card-heading">Users</div>
				<div className="card-content">
					<div className="card-actions" style={{ paddingTop: 0 }}>
						<button
							type="button"
							className="ncg-button mooncg-accept"
							data-testid="users-add"
							onClick={() => setDialog({ type: "create" })}
						>
							<Icon name="add" />
							<span>Add User</span>
						</button>
					</div>

					{users === null ? (
						<div className="spinner" title="Loading" />
					) : (
						<table className="users-table" data-testid="users-table">
							<thead>
								<tr>
									<th>Name</th>
									<th>Roles</th>
									<th>Status</th>
									<th>2FA</th>
									<th>Actions</th>
								</tr>
							</thead>
							<tbody>
								{users.map((user) => (
									<tr
										key={user.id}
										data-testid="user-row"
										data-user-name={user.name}
									>
										<td className="user-name">{user.name}</td>
										<td className="user-roles">{user.roles.join(", ")}</td>
										<td
											className={
												user.enabled ? "user-status" : "user-status disabled"
											}
										>
											{user.enabled ? "Enabled" : "Disabled"}
										</td>
										<td className="user-totp">
											{user.totp_enabled ? "On" : "Off"}
										</td>
										<td className="user-actions">
											<button
												type="button"
												className="ncg-button mooncg-configure"
												data-testid="user-edit"
												title="Edit"
												onClick={() => setDialog({ type: "edit", user })}
											>
												<Icon name="edit" size={18} />
											</button>
											<button
												type="button"
												className="ncg-button mooncg-benign"
												data-testid="user-sessions"
												title="Sessions"
												onClick={() => setDialog({ type: "sessions", user })}
											>
												<Icon name="accessTime" size={18} />
											</button>
											<button
												type="button"
												className="ncg-button mooncg-danger"
												data-testid="user-reset-2fa"
												title="Reset 2FA"
												disabled={!user.totp_enabled}
												onClick={() => setDialog({ type: "reset2fa", user })}
											>
												<Icon name="vpnKey" size={18} />
											</button>
											<button
												type="button"
												className="ncg-button mooncg-reject"
												data-testid="user-delete"
												title="Delete"
												onClick={() => setDialog({ type: "delete", user })}
											>
												<Icon name="delete" size={18} />
											</button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</div>
			</div>

			{dialog?.type === "create" && (
				<UserEditorDialog
					roles={roles}
					onClose={closeDialog}
					onSaved={closeAndRefresh}
				/>
			)}
			{dialog?.type === "edit" && (
				<UserEditorDialog
					roles={roles}
					user={dialog.user}
					onClose={closeDialog}
					onSaved={closeAndRefresh}
				/>
			)}
			{dialog?.type === "delete" && (
				<DeleteUserDialog
					user={dialog.user}
					onClose={closeDialog}
					onDeleted={closeAndRefresh}
				/>
			)}
			{dialog?.type === "reset2fa" && (
				<ResetTotpDialog
					user={dialog.user}
					onClose={closeDialog}
					onReset={closeAndRefresh}
				/>
			)}
			{dialog?.type === "sessions" && (
				<UserSessionsDialog user={dialog.user} onClose={closeDialog} />
			)}
		</div>
	);
}

/**
 * Opens the native <dialog> as a modal when it mounts.
 */
function useModal(onClose: () => void) {
	const dialogRef = useRef<HTMLDialogElement>(null);

	useEffect(() => {
		const dialogEl = dialogRef.current;
		if (!dialogEl) {
			return;
		}

		if (!dialogEl.open) {
			dialogEl.showModal();
		}

		dialogEl.addEventListener("close", onClose);
		return () => {
			dialogEl.removeEventListener("close", onClose);
		};
	}, [onClose]);

	return dialogRef;
}

function RolesFieldset({
	roles,
	selected,
	onToggle,
}: {
	roles: ApiRole[];
	selected: string[];
	onToggle: (roleName: string, checked: boolean) => void;
}) {
	return (
		<fieldset className="form-field roles-fieldset">
			<legend>Roles</legend>
			{roles.map((role) => (
				<label key={role.id} className="role-option">
					<input
						type="checkbox"
						data-testid={`user-role-option-${role.name}`}
						checked={selected.includes(role.name)}
						onChange={(event) => {
							onToggle(role.name, event.target.checked);
						}}
					/>
					<span>{role.name}</span>
				</label>
			))}
		</fieldset>
	);
}

function UserEditorDialog({
	roles,
	user,
	onClose,
	onSaved,
}: {
	roles: ApiRole[];
	user?: ApiUser;
	onClose: () => void;
	onSaved: () => void;
}) {
	const showToast = useToast();
	const dialogRef = useModal(onClose);
	const [name, setName] = useState(user?.name ?? "");
	const [password, setPassword] = useState("");
	const [enabled, setEnabled] = useState(user?.enabled ?? true);
	const [selectedRoles, setSelectedRoles] = useState<string[]>(
		user?.roles ?? [],
	);
	const [saving, setSaving] = useState(false);

	const toggleRole = (roleName: string, checked: boolean) => {
		setSelectedRoles((current) =>
			checked
				? [...current, roleName]
				: current.filter((existing) => existing !== roleName),
		);
	};

	const handleSubmit = (event: FormEvent) => {
		event.preventDefault();
		setSaving(true);

		const savePromise = user
			? authApi.updateUser(user.id, {
					...(name !== user.name ? { name } : {}),
					...(password ? { password } : {}),
					roles: selectedRoles,
					enabled,
				})
			: authApi.createUser({
					name,
					password,
					roles: selectedRoles,
					enabled,
				});

		savePromise
			.then((saved) => {
				showToast(
					user ? `Updated user ${saved.name}.` : `Created user ${saved.name}.`,
				);
				onSaved();
			})
			.catch((error: unknown) => {
				showToast(formatApiError(error));
				setSaving(false);
			});
	};

	return (
		<dialog
			ref={dialogRef}
			className="confirm-dialog user-editor-dialog"
			data-testid="user-editor-dialog"
		>
			<h2>{user ? `Edit User: ${user.name}` : "Add User"}</h2>
			<form onSubmit={handleSubmit}>
				<div className="confirm-dialog-body">
					<label className="form-field">
						<span>Name</span>
						<input
							type="text"
							required
							data-testid="user-editor-name"
							value={name}
							onChange={(event) => {
								setName(event.target.value);
							}}
						/>
					</label>
					<label className="form-field">
						<span>
							{user ? "New Password (leave empty to keep)" : "Password"}
						</span>
						<input
							type="password"
							required={!user}
							autoComplete="new-password"
							data-testid="user-editor-password"
							value={password}
							onChange={(event) => {
								setPassword(event.target.value);
							}}
						/>
					</label>
					<RolesFieldset
						roles={roles}
						selected={selectedRoles}
						onToggle={toggleRole}
					/>
					<label className="form-field checkbox-field">
						<input
							type="checkbox"
							data-testid="user-editor-enabled"
							checked={enabled}
							onChange={(event) => {
								setEnabled(event.target.checked);
							}}
						/>
						<span>Enabled</span>
					</label>
				</div>
				<div className="buttons">
					<button
						type="button"
						className="ncg-button mooncg-benign"
						data-testid="user-editor-cancel"
						onClick={() => dialogRef.current?.close()}
					>
						Cancel
					</button>
					<button
						type="submit"
						className="ncg-button mooncg-accept"
						data-testid="user-editor-save"
						disabled={saving}
					>
						{user ? "Save" : "Create"}
					</button>
				</div>
			</form>
		</dialog>
	);
}

function DeleteUserDialog({
	user,
	onClose,
	onDeleted,
}: {
	user: ApiUser;
	onClose: () => void;
	onDeleted: () => void;
}) {
	const showToast = useToast();
	const dialogRef = useModal(onClose);
	const [deleting, setDeleting] = useState(false);

	const handleDelete = () => {
		setDeleting(true);
		authApi
			.deleteUser(user.id)
			.then(() => {
				showToast(`Deleted user ${user.name}.`);
				onDeleted();
			})
			.catch((error: unknown) => {
				showToast(formatApiError(error));
				setDeleting(false);
			});
	};

	return (
		<dialog
			ref={dialogRef}
			className="confirm-dialog"
			data-testid="user-delete-dialog"
		>
			<h2>Delete User</h2>
			<div className="confirm-dialog-body">
				<p className="text-warning">
					Are you sure you wish to delete the user <b>{user.name}</b>?
					<br />
					This will also terminate all of their active sessions.
				</p>
			</div>
			<div className="buttons">
				<button
					type="button"
					className="ncg-button mooncg-benign"
					onClick={() => dialogRef.current?.close()}
				>
					No, Cancel
				</button>
				<button
					type="button"
					className="ncg-button mooncg-reject"
					data-testid="user-delete-confirm"
					disabled={deleting}
					onClick={handleDelete}
				>
					Yes, delete
				</button>
			</div>
		</dialog>
	);
}

function ResetTotpDialog({
	user,
	onClose,
	onReset,
}: {
	user: ApiUser;
	onClose: () => void;
	onReset: () => void;
}) {
	const showToast = useToast();
	const dialogRef = useModal(onClose);
	const [resetting, setResetting] = useState(false);

	const handleReset = () => {
		setResetting(true);
		authApi
			.resetUserTotp(user.id)
			.then(() => {
				showToast(`Reset 2FA for user ${user.name}.`);
				onReset();
			})
			.catch((error: unknown) => {
				showToast(formatApiError(error));
				setResetting(false);
			});
	};

	return (
		<dialog
			ref={dialogRef}
			className="confirm-dialog"
			data-testid="user-reset-2fa-dialog"
		>
			<h2>Reset Two-Factor Authentication</h2>
			<div className="confirm-dialog-body">
				<p className="text-warning">
					Are you sure you wish to reset 2FA for <b>{user.name}</b>?
					<br />
					They will be able to log in with just their password again.
				</p>
			</div>
			<div className="buttons">
				<button
					type="button"
					className="ncg-button mooncg-benign"
					onClick={() => dialogRef.current?.close()}
				>
					No, Cancel
				</button>
				<button
					type="button"
					className="ncg-button mooncg-danger"
					data-testid="user-reset-2fa-confirm"
					disabled={resetting}
					onClick={handleReset}
				>
					Yes, reset 2FA
				</button>
			</div>
		</dialog>
	);
}

function UserSessionsDialog({
	user,
	onClose,
}: {
	user: ApiUser;
	onClose: () => void;
}) {
	const showToast = useToast();
	const dialogRef = useModal(onClose);
	const [sessions, setSessions] = useState<ApiSession[] | null>(null);

	const refresh = useCallback(() => {
		authApi.listUserSessions(user.id).then(setSessions, (error: unknown) => {
			showToast(`Failed to load sessions: ${formatApiError(error)}`);
		});
	}, [user.id, showToast]);

	useEffect(() => {
		refresh();
	}, [refresh]);

	const revoke = (sessionId: string) => {
		authApi
			.revokeUserSession(user.id, sessionId)
			.then(() => {
				showToast("Session terminated.");
				refresh();
			})
			.catch((error: unknown) => {
				showToast(formatApiError(error));
			});
	};

	return (
		<dialog
			ref={dialogRef}
			className="confirm-dialog sessions-dialog"
			data-testid="user-sessions-dialog"
		>
			<h2>Sessions: {user.name}</h2>
			<div className="confirm-dialog-body">
				{sessions === null ? (
					<div className="spinner" title="Loading" />
				) : sessions.length === 0 ? (
					<p>This user has no active sessions.</p>
				) : (
					<div className="session-list" data-session-count={sessions.length}>
						{sessions.map((session) => (
							<SessionRow
								key={session.id}
								session={session}
								testId="user-session-row"
								onRevoke={() => {
									revoke(session.id);
								}}
								revokeTestId="user-session-revoke"
							/>
						))}
					</div>
				)}
			</div>
			<div className="buttons">
				<button
					type="button"
					className="ncg-button mooncg-benign"
					data-testid="user-sessions-close"
					onClick={() => dialogRef.current?.close()}
				>
					Close
				</button>
			</div>
		</dialog>
	);
}

export function SessionRow({
	session,
	testId,
	revokeTestId,
	onRevoke,
}: {
	session: ApiSession;
	testId: string;
	revokeTestId: string;
	onRevoke?: () => void;
}) {
	return (
		<div
			className="session-row"
			data-testid={testId}
			data-session-id={session.id}
			data-current={session.current ? "true" : "false"}
		>
			<div className="session-details">
				<span className="session-device">
					{session.userAgent ?? "Unknown device"}
					{session.current && (
						<span className="session-current-badge"> (current)</span>
					)}
				</span>
				<span className="session-meta">
					{session.ip ?? "Unknown IP"}
					{session.createdAt !== undefined &&
						` — signed in ${new Date(session.createdAt).toLocaleString()}`}
				</span>
			</div>
			{onRevoke &&
				(session.current ? (
					<button
						type="button"
						className="ncg-button"
						data-testid={revokeTestId}
						title="This is your current session"
						disabled
					>
						<Icon name="close" size={18} />
						<span>Current</span>
					</button>
				) : (
					<button
						type="button"
						className="ncg-button mooncg-reject"
						data-testid={revokeTestId}
						onClick={onRevoke}
					>
						<Icon name="close" size={18} />
						<span>End</span>
					</button>
				))}
		</div>
	);
}
