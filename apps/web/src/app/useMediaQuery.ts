import { useCallback, useSyncExternalStore } from "react";

/**
 * Subscribe to a CSS media query.
 *
 * `useSyncExternalStore` rather than `useState` plus `useEffect`. The effect version
 * renders once with a guessed value and corrects it on the next tick, which for the
 * sidebar means a visible flash of the wide nav on every load at a narrow width.
 *
 * The server snapshot is `false` because there is no viewport to measure without a
 * window. Nothing renders this outside the browser today; it is here so that adding
 * prerendering later fails wide rather than throwing.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
