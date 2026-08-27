# PromptFolio
Some über mega nice stock portfolio manager

## Requirements

Bun 1.4+. No Node.js required or used — `bunfig.toml` sets `[run] bun = true` so
every `bun run <script>` executes under Bun, including `oxlint` and `oxfmt`, whose
CLI binaries ship a `#!/usr/bin/env node` shebang but run fine under Bun.
