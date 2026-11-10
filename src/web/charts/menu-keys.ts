/**
 * Which entry a key moves focus to in a menu of `count` entries, or null when the key is not a
 * menu key. `current` is -1 while focus is still on the button: down then enters at the top, up at the bottom.
 */
export const menuStep = (key: string, current: number, count: number): number | null => {
  if (count === 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowDown") return (current + 1) % count;
  if (key === "ArrowUp") return current <= 0 ? count - 1 : current - 1;
  return null;
};
