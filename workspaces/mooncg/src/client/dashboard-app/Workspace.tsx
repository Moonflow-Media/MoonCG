import type { DragEndEvent } from "@dnd-kit/core";
import {
	closestCenter,
	DndContext,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	arrayMove,
	rectSortingStrategy,
	SortableContext,
	useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { CSSProperties } from "react";
import { useMemo, useState } from "react";

import type { MoonCG } from "../../types/mooncg";
import { Panel } from "./Panel";

function fullName(panel: MoonCG.Bundle.Panel) {
	return `${panel.bundleName}.${panel.name}`;
}

function workspacePanelName(workspace: MoonCG.Workspace) {
	return workspace.route === "" ? "default" : workspace.name;
}

function computePanels(workspace: MoonCG.Workspace) {
	const workspaceName = workspacePanelName(workspace);
	const panels: MoonCG.Bundle.Panel[] = [];
	for (const bundle of window.__renderData__.bundles) {
		for (const panel of bundle.dashboard.panels) {
			if (panel.dialog) {
				continue;
			}

			if (panel.fullbleed) {
				if (
					workspaceName === `__mooncg_fullbleed__${bundle.name}_${panel.name}`
				) {
					panels.push(panel);
				}

				continue;
			}

			if (panel.workspace === workspaceName) {
				panels.push(panel);
			}
		}
	}

	return panels;
}

/**
 * Merges the persisted sort order with the panels that actually exist:
 * persisted order wins, unknown panels are appended, removed panels dropped.
 */
function loadSortOrder(storageKey: string, ids: string[]) {
	let stored: string[] = [];
	try {
		const raw = localStorage.getItem(storageKey);
		if (raw) {
			const parsed: unknown = JSON.parse(raw);
			if (Array.isArray(parsed)) {
				stored = parsed.filter((entry) => typeof entry === "string");
			}
		}
	} catch {
		// Corrupt storage value; fall back to the natural panel order.
	}

	const merged = [...new Set([...stored, ...ids])];
	return merged.filter((id) => ids.includes(id));
}

export function WorkspaceView({ workspace }: { workspace: MoonCG.Workspace }) {
	const panels = useMemo(() => computePanels(workspace), [workspace]);

	if (workspace.fullbleed) {
		return (
			<div className="workspace fullbleed">
				{panels.map((panel) => (
					<div
						key={fullName(panel)}
						className="panel fullbleed"
						id={`${panel.bundleName}_${panel.name}`}
						data-testid={`panel-${panel.bundleName}-${panel.name}`}
						data-bundle={panel.bundleName}
						data-panel={panel.name}
					>
						<Panel panel={panel} fullbleed />
					</div>
				))}
			</div>
		);
	}

	return <PanelGrid workspace={workspace} panels={panels} />;
}

function PanelGrid({
	workspace,
	panels,
}: {
	workspace: MoonCG.Workspace;
	panels: MoonCG.Bundle.Panel[];
}) {
	const storageKey = `${workspacePanelName(workspace)}_workspace_panel_sort_order`;
	const ids = useMemo(() => panels.map(fullName), [panels]);
	const [order, setOrder] = useState(() => loadSortOrder(storageKey, ids));

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
	);

	const handleDragEnd = (event: DragEndEvent) => {
		const { active, over } = event;
		if (!over || active.id === over.id) {
			return;
		}

		setOrder((current) => {
			const oldIndex = current.indexOf(String(active.id));
			const newIndex = current.indexOf(String(over.id));
			if (oldIndex < 0 || newIndex < 0) {
				return current;
			}

			const next = arrayMove(current, oldIndex, newIndex);
			localStorage.setItem(storageKey, JSON.stringify(next));
			return next;
		});
	};

	return (
		<div className="workspace">
			<DndContext
				sensors={sensors}
				collisionDetection={closestCenter}
				onDragEnd={handleDragEnd}
			>
				<SortableContext items={order} strategy={rectSortingStrategy}>
					<div className="workspace-grid">
						{/*
						 * Panels are always rendered in their natural (bundle) order and
						 * are only *visually* reordered via the CSS `order` property.
						 * Reordering the actual DOM nodes would reload the panel iframes.
						 */}
						{panels.map((panel) => (
							<SortablePanel
								key={fullName(panel)}
								id={fullName(panel)}
								orderIndex={order.indexOf(fullName(panel))}
								panel={panel}
							/>
						))}
					</div>
				</SortableContext>
			</DndContext>
		</div>
	);
}

function SortablePanel({
	id,
	orderIndex,
	panel,
}: {
	id: string;
	orderIndex: number;
	panel: MoonCG.Bundle.Panel;
}) {
	const {
		attributes,
		listeners,
		setNodeRef,
		setActivatorNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id });

	const width = panel.fullbleed ? 1 : Math.min(Math.max(panel.width, 1), 10);
	const style: CSSProperties = {
		order: orderIndex,
		gridColumn: `span ${width}`,
		transform: CSS.Transform.toString(transform),
		transition,
	};

	return (
		<div
			ref={setNodeRef}
			style={style}
			className={isDragging ? "panel dragging" : "panel"}
			id={`${panel.bundleName}_${panel.name}`}
			data-testid={`panel-${panel.bundleName}-${panel.name}`}
			data-bundle={panel.bundleName}
			data-panel={panel.name}
		>
			<Panel
				panel={panel}
				fullbleed={false}
				dragHandleRef={setActivatorNodeRef}
				dragHandleAttributes={attributes}
				dragHandleListeners={listeners}
			/>
		</div>
	);
}
