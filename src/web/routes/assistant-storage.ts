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
