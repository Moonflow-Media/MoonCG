import type { ChangeEvent, DragEvent } from "react";
import { useRef, useState } from "react";

import type { MoonCG } from "../../types/mooncg";
import { useReplicant } from "./hooks";
import { Icon } from "./Icon";
import { useToast } from "./toasts";

interface Collection {
	name: string;
	categories: MoonCG.Bundle.AssetCategory[];
}

export function AssetsPage() {
	const { value: collections } = useReplicant<Collection[]>(
		"collections",
		"_assets",
	);

	return (
		<div className="assets-page" data-testid="assets">
			{(collections ?? []).map((collection) => (
				<div className="ncg-card" key={collection.name}>
					<div className="card-heading">{collection.name}</div>
					{collection.categories.map((category) => (
						<AssetCategory
							key={category.name}
							collectionName={collection.name}
							category={category}
						/>
					))}
				</div>
			))}
		</div>
	);
}

function computeAcceptsMsg(allowedTypes: string[]) {
	let msg = "Accepts ";
	allowedTypes.forEach((type, index) => {
		const upper = type.toUpperCase();
		if (index === 0) {
			msg += upper;
		} else if (index === allowedTypes.length - 1) {
			msg += index === 1 ? ` and ${upper}` : `, and ${upper}`;
		} else {
			msg += `, ${upper}`;
		}
	});
	return msg;
}

interface UploadEntry {
	id: number;
	name: string;
	status: "uploading" | "success" | "error";
	error?: string;
}

function AssetCategory({
	collectionName,
	category,
}: {
	collectionName: string;
	category: MoonCG.Bundle.AssetCategory;
}) {
	const showToast = useToast();
	const { value: files } = useReplicant<MoonCG.AssetFile[]>(
		`assets:${category.name}`,
		collectionName,
	);

	const rootRef = useRef<HTMLDivElement>(null);
	const uploadDialogRef = useRef<HTMLDialogElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const uploadIdRef = useRef(0);

	const [uploads, setUploads] = useState<UploadEntry[]>([]);
	const [successfulUploads, setSuccessfulUploads] = useState(0);
	const [dragOver, setDragOver] = useState(false);

	const allowedTypes = category.allowedTypes ?? [];
	const accept = allowedTypes.map((type) => `.${type}`).join(",");

	const uploadFile = (file: File) => {
		if (allowedTypes.length > 0) {
			const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
			const allowed = allowedTypes.some(
				(type) => type.toLowerCase() === extension,
			);
			if (!allowed) {
				showToast(`${file.name} error: Incorrect File Type.`);
				return;
			}
		}

		const id = uploadIdRef.current++;
		setUploads((current) => [
			...current,
			{ id, name: file.name, status: "uploading" },
		]);

		const updateEntry = (patch: Partial<UploadEntry>) => {
			setUploads((current) =>
				current.map((entry) =>
					entry.id === id ? { ...entry, ...patch } : entry,
				),
			);
		};

		const body = new FormData();
		body.append("file", file, file.name);

		void fetch(`/assets/${collectionName}/${category.name}`, {
			method: "POST",
			credentials: "include",
			body,
		})
			.then((response) => {
				if (response.ok) {
					updateEntry({ status: "success" });
					setSuccessfulUploads((count) => count + 1);
					// Legacy-compatible signal used by the E2E tests to detect that
					// an upload has been fully processed by the server.
					rootRef.current?.dispatchEvent(
						new CustomEvent("upload-success", { bubbles: true }),
					);
				} else {
					updateEntry({ status: "error", error: `HTTP ${response.status}` });
					showToast(`${file.name} error: upload failed`);
				}
			})
			.catch((error: unknown) => {
				updateEntry({ status: "error", error: String(error) });
				showToast(`${file.name} error: upload failed`);
			});
	};

	const uploadFiles = (fileList: FileList | null) => {
		if (!fileList) {
			return;
		}

		for (const file of Array.from(fileList)) {
			uploadFile(file);
		}
	};

	const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
		uploadFiles(event.target.files);
		event.target.value = "";
	};

	const handleDrop = (event: DragEvent<HTMLElement>) => {
		event.preventDefault();
		setDragOver(false);
		uploadFiles(event.dataTransfer.files);
	};

	const openUploadDialog = () => {
		setUploads([]);
		uploadDialogRef.current?.showModal();
	};

	return (
		<div
			ref={rootRef}
			className="asset-category"
			data-testid={`asset-category-${collectionName}-${category.name}`}
			data-collection-name={collectionName}
			data-category-name={category.name}
			data-successful-uploads={successfulUploads}
		>
			<div className="asset-category-header">
				<span className="asset-category-title">{category.title}</span>
				<button
					type="button"
					className="ncg-button asset-add-button"
					data-testid="asset-add"
					onClick={openUploadDialog}
				>
					<Icon name="add" />
					Add File(s)
				</button>
			</div>

			{(files ?? []).length === 0 && (
				<div className="asset-category-empty">
					There are no assets in this category.
				</div>
			)}

			<div className="asset-files">
				{(files ?? []).map((file) => (
					<AssetFileRow
						key={file.url}
						file={file}
						onDeleted={() => {
							showToast(`Deleted ${file.base}`);
						}}
						onDeletionFailed={() => {
							showToast(`Failed to delete ${file.base}`);
						}}
					/>
				))}
			</div>

			<dialog ref={uploadDialogRef} className="confirm-dialog">
				<div className="upload-dialog-content">
					<button
						type="button"
						className={
							dragOver ? "upload-dropzone drag-over" : "upload-dropzone"
						}
						data-testid="upload-dropzone"
						onClick={() => fileInputRef.current?.click()}
						onDragOver={(event) => {
							event.preventDefault();
							setDragOver(true);
						}}
						onDragLeave={() => {
							setDragOver(false);
						}}
						onDrop={handleDrop}
					>
						<Icon name="fileUpload" />
						<span>Drop files here, or click to select files…</span>
					</button>

					<input
						ref={fileInputRef}
						type="file"
						multiple
						hidden
						accept={accept || undefined}
						data-testid="asset-file-input"
						onChange={handleInputChange}
					/>

					{allowedTypes.length > 0 && (
						<div className="upload-accepts-msg">
							{computeAcceptsMsg(allowedTypes)}
						</div>
					)}

					{uploads.length > 0 && (
						<ul className="upload-file-list">
							{uploads.map((entry) => (
								<li key={entry.id}>
									<span>{entry.name}</span>
									<span className={`upload-status-${entry.status}`}>
										{entry.status === "uploading" && "Uploading…"}
										{entry.status === "success" && "Uploaded"}
										{entry.status === "error" && (entry.error ?? "Error")}
									</span>
								</li>
							))}
						</ul>
					)}
				</div>
				<div className="buttons">
					<button
						type="button"
						className="ncg-button mooncg-benign"
						data-testid="upload-dialog-close"
						onClick={() => uploadDialogRef.current?.close()}
					>
						Close
					</button>
				</div>
			</dialog>
		</div>
	);
}

function AssetFileRow({
	file,
	onDeleted,
	onDeletionFailed,
}: {
	file: MoonCG.AssetFile;
	onDeleted: () => void;
	onDeletionFailed: () => void;
}) {
	const [deleting, setDeleting] = useState(false);

	const handleDelete = () => {
		setDeleting(true);

		void fetch(file.url, {
			method: "DELETE",
			credentials: "include",
		})
			.then((response) => {
				if (response.status === 410 || response.status === 200) {
					onDeleted();
				} else {
					onDeletionFailed();
				}
			})
			.catch(() => {
				onDeletionFailed();
			})
			.finally(() => {
				setDeleting(false);
			});
	};

	return (
		<div
			className="asset-file"
			data-testid="asset-file"
			data-file-name={file.name}
		>
			<a href={file.url} target="_blank" rel="noreferrer">
				{file.base}
			</a>
			{deleting ? (
				<div className="spinner" title="Deleting" />
			) : (
				<button
					type="button"
					className="ncg-button mooncg-reject"
					data-testid="asset-delete"
					onClick={handleDelete}
				>
					<Icon name="delete" />
					Delete
				</button>
			)}
		</div>
	);
}
