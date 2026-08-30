import path from "node:path";

const relative = (filenames: string[]): string =>
  filenames.map((file) => path.relative(process.cwd(), file)).join(" ");

// The whole project, not the staged files: a type error is rarely in the file
// that caused it, and `tsc` has no useful single-file mode under `paths`.
const typecheck = () => "tsc --noEmit";

const lint = (filenames: string[]) => `oxlint --fix --fix-suggestions ${relative(filenames)}`;

const format = (filenames: string[]) =>
  `oxfmt --no-error-on-unmatched-pattern ${relative(filenames)}`;

export default {
  "**/*.ts?(x)": typecheck,
  "**/*.{js,jsx,ts,tsx}": [lint],
  "**/*.{js,jsx,ts,tsx,json,css,md}": [format],
};
