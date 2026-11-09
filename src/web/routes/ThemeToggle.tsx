import { useEffect, useState } from "react";

import {
  chooseTheme,
  followSystem,
  nextChoice,
  readChoice,
  THEME_KEY,
  type ThemeChoice,
} from "../lib/theme.ts";

const LABELS = { system: "System", light: "Light", dark: "Dark" } satisfies Record<
  ThemeChoice,
  string
>;

/** One button cycling system, light, dark. Starts as "System" on the server; the stored choice is read after mount. */
export const ThemeToggle = () => {
  const [choice, setChoice] = useState<ThemeChoice>("system");

  useEffect(() => {
    setChoice(readChoice(localStorage.getItem(THEME_KEY)));
    return followSystem();
  }, []);

  return (
    <button
      type="button"
      className="quiet-button"
      onClick={() => {
        const next = nextChoice(choice);
        setChoice(next);
        chooseTheme(next);
      }}
    >
      Theme: {LABELS[choice]}
    </button>
  );
};
