import type { ReactNode } from "react";
import {
	createContext,
	useCallback,
	useContext,
	useRef,
	useState,
} from "react";

export interface ToastEntry {
	id: number;
	text: string;
}

const ToastContext = createContext<(text: string) => void>(() => undefined);

export function useToast() {
	return useContext(ToastContext);
}

const TOAST_DURATION = 3000;

export function useToastState() {
	const [toasts, setToasts] = useState<ToastEntry[]>([]);
	const nextId = useRef(0);

	const showToast = useCallback((text: string) => {
		const id = nextId.current++;
		setToasts((current) => [...current, { id, text }]);
		setTimeout(() => {
			setToasts((current) => current.filter((toast) => toast.id !== id));
		}, TOAST_DURATION);
	}, []);

	return { toasts, showToast };
}

export function ToastProvider({
	showToast,
	children,
}: {
	showToast: (text: string) => void;
	children: ReactNode;
}) {
	return (
		<ToastContext.Provider value={showToast}>{children}</ToastContext.Provider>
	);
}

export function ToastViewport({
	toasts,
	reconnecting,
}: {
	toasts: ToastEntry[];
	reconnecting: boolean;
}) {
	return (
		<div className="toast-container" data-testid="toast-container">
			{reconnecting && (
				<div className="toast" data-testid="reconnect-toast">
					<span>Attempting to reconnect to MoonCG server...</span>
					<div className="spinner" />
				</div>
			)}
			{toasts.map((toast) => (
				<div className="toast" key={toast.id} data-testid="toast">
					{toast.text}
				</div>
			))}
		</div>
	);
}
