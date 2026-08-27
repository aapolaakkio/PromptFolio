# PromptFolio
Some über mega nice stock portfolio manager

## Requirements

Bun 1.4+, plus a real Node.js on `PATH` satisfying `engines.node` in `package.json`
(`>=20.19.0 <21 || >=22.18.0`, see `.nvmrc`). This project never runs its own code on
Node — but `oxlint`'s CLI binary shebangs to `node`, and needs that floor to load
`oxlint.config.ts` (a TypeScript config file). Without it, `bun run lint` (and thus
`bun run check`) fails with "TypeScript config files require Node.js ...". CI images
need this too.
