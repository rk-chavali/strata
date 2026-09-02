import { useCallback, useEffect, useState } from "react";

/**
 * Light or dark, for the whole application including the screens you see before signing in.
 *
 * **This used to live inside `AppShell`.** The shell renders only once you are signed in, so
 * `data-theme` was never set on the way in: signing in, first-run setup and redeeming an
 * invitation were permanently light, with no way to change them, and the app then snapped to dark
 * the moment you got through. Somebody who works in dark all day met a white screen every time.
 *
 * Read once from storage rather than watched, because the value only changes when this hook
 * changes it. A `storage` listener would be for syncing across tabs, which is a different feature
 * and one nobody has asked for.
 */

const KEY = "strata.theme";

export type Theme = "light" | "dark";

export interface ThemeControl {
  theme: Theme;
  setTheme: (next: Theme) => void;
  toggle: () => void;
}

/**
 * The initial value, in priority order: what you last chose, then what your system prefers.
 *
 * Falling back to the system preference rather than to light matters on the sign-in screen,
 * which is the one place a first-time visitor has made no choice yet. Defaulting to light there
 * meant a dark-mode user's first impression of the product was a flash of white.
 */
function initial(): Theme {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // Private browsing, or storage disabled. The system preference is still a good answer.
  }

  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function useTheme(): ThemeControl {
  const [theme, setTheme] = useState<Theme>(initial);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // Not being able to remember the choice is not a reason to refuse to apply it.
    }
  }, [theme]);

  const toggle = useCallback(
    () => setTheme((current) => (current === "light" ? "dark" : "light")),
    [],
  );

  return { theme, setTheme, toggle };
}
