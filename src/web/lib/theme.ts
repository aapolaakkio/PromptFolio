export type ThemeChoice = "system" | "light" | "dark";
export type Theme = "light" | "dark";

export const THEME_KEY = "theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

export const nextChoice = (choice: ThemeChoice): ThemeChoice =>
  choice === "system" ? "light" : choice === "light" ? "dark" : "system";

export const resolveTheme = (choice: ThemeChoice, prefersDark: boolean): Theme =>
  choice === "system" ? (prefersDark ? "dark" : "light") : choice;

export const readChoice = (stored: string | null): ThemeChoice =>
  stored === "light" || stored === "dark" ? stored : "system";

/** The one part of `document` the theme touches. */
export type ThemeDocument = { documentElement: { dataset: { theme?: string } } };

/**
 * Sets `data-theme` on <html>. Also runs inline in <head> before first paint (see `THEME_SCRIPT`),
 * so it must stay self-contained: no imports, no references outside its own parameters.
 */
export const applyStoredTheme = (
  storage: { getItem: (key: string) => string | null },
  media: (query: string) => { matches: boolean },
  doc: ThemeDocument,
): void => {
  const stored = storage.getItem("theme");
  doc.documentElement.dataset.theme =
    stored === "light" || stored === "dark"
      ? stored
      : media("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
};

/** Runs before the stylesheet paints, so a dark-mode page never flashes light. */
export const THEME_SCRIPT = `(${applyStoredTheme.toString()})(localStorage, matchMedia, document)`;

/** Stores the owner's choice ("system" clears it) and applies it now. */
export const chooseTheme = (choice: ThemeChoice): void => {
  if (choice === "system") localStorage.removeItem(THEME_KEY);
  else localStorage.setItem(THEME_KEY, choice);
  document.documentElement.dataset.theme = resolveTheme(choice, matchMedia(DARK_QUERY).matches);
};

/** Keeps "system" following the OS while the page is open; returns the unsubscribe. */
export const followSystem = (): (() => void) => {
  const media = matchMedia(DARK_QUERY);
  const apply = (): void => applyStoredTheme(localStorage, matchMedia, document);
  media.addEventListener("change", apply);
  return () => media.removeEventListener("change", apply);
};
