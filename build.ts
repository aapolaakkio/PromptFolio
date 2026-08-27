import tailwind from "bun-plugin-tailwind";

const result = await Bun.build({
  entrypoints: ["src/web/index.html"],
  outdir: "dist",
  minify: true,
  plugins: [tailwind],
});

if (!result.success) {
  console.error("Build failed:");
  result.logs.forEach((log) => console.error(log));
  process.exit(1);
}
