// Bundles the worker CLI and all its dependencies into one file.
import { build } from "esbuild";
import { chmodSync } from "node:fs";

await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/relayllm.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  legalComments: "none",
  logLevel: "info",
});
chmodSync("dist/relayllm.mjs", 0o755);
