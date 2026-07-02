import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import type { ClientReplicant } from "../api/replicant";

function subscribeHash(callback: () => void) {
	window.addEventListener("hashchange", callback);
	return () => {
		window.removeEventListener("hashchange", callback);
	};
}

function getHashRoute() {
	return window.location.hash.replace(/^#/, "");
}

/**
 * The current hash route (without the leading `#`).
 */
export function useHashRoute() {
	return useSyncExternalStore(subscribeHash, getHashRoute);
}

export function useMediaQuery(query: string) {
	const [matches, setMatches] = useState(
		() => window.matchMedia(query).matches,
	);

	useEffect(() => {
		const mql = window.matchMedia(query);
		const listener = () => {
			setMatches(mql.matches);
		};

		listener();
		mql.addEventListener("change", listener);
		return () => {
			mql.removeEventListener("change", listener);
		};
	}, [query]);

	return matches;
}

/**
 * Subscribes to a Replicant (via the global MoonCG API created by api.js) and
 * re-renders whenever it changes.
 *
 * Replicant values are mutated in place by the replicant system, so the value
 * is wrapped in a fresh object on every change event to guarantee re-renders.
 */
export function useReplicant<T>(
	name: string,
	namespace: string,
): { value: T | undefined; replicant: ClientReplicant<T> } {
	const replicant = useMemo(() => {
		const rep = window.MoonCG.Replicant<T>(name, namespace);
		// Replicant instances are cached and shared; many components may listen
		// to the same one (e.g. every sound cue row listens to `assets:sounds`).
		rep.setMaxListeners(99);
		return rep;
	}, [name, namespace]);

	const [state, setState] = useState<{ value: T | undefined }>({
		value: replicant.status === "declared" ? replicant.value : undefined,
	});

	useEffect(() => {
		const handler = (newValue?: T) => {
			setState({ value: newValue });
		};

		replicant.on("change", handler);
		if (replicant.status === "declared") {
			handler(replicant.value);
		}

		return () => {
			replicant.off("change", handler);
		};
	}, [replicant]);

	return { value: state.value, replicant };
}
