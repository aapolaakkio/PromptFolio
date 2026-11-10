import { PANEL_KEY } from "./assistant-state.ts";

// Private windows and blocked storage throw; the panel then just forgets between loads.

export const readStoredPanel = (): string | null => {
  try {
    return localStorage.getItem(PANEL_KEY);
  } catch {
    return null;
  }
};

export const storePanel = (value: string): void => {
  try {
    localStorage.setItem(PANEL_KEY, value);
  } catch {
    // Nothing to keep it in; the open panel still works for this load.
  }
};

export const forgetPanel = (): void => {
  try {
    localStorage.removeItem(PANEL_KEY);
  } catch {
    // Nothing was stored.
  }
};

const WEB_SEARCH_KEY = "assistant-web-search";

/** Off unless this browser turned it on. */
export const readStoredWebSearch = (): boolean => {
  try {
    return localStorage.getItem(WEB_SEARCH_KEY) === "on";
  } catch {
    return false;
  }
};

export const storeWebSearch = (on: boolean): void => {
  try {
    localStorage.setItem(WEB_SEARCH_KEY, on ? "on" : "off");
  } catch {
    // Nothing to keep it in; the switch still applies to this load.
  }
};
