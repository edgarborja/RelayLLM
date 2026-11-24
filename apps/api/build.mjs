// Bundles the library and the CLI, each with all dependencies, plus type declarations.
import { build } from "esbuild";
import { chmodSync, copyFileSync, rmSync, writeFileSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
const cjsShim = "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);";
for (const [entry, outfile, banner] of [
  ["src/index.ts", "dist/index.mjs", cjsShim],
  ["src/cli.ts", "dist/cli.mjs", `#!/usr/bin/env node\n${cjsShim}`],
]) {
  await build({ entryPoints: [entry], outfile, bundle: true, platform: "node", target: "node22", format: "esm", banner: { js: banner }, legalComments: "none", logLevel: "info" });
}
// types.ts is import-free and type-only, so it is its own declaration file.
copyFileSync("src/types.ts", "dist/types.d.mts");
writeFileSync(
  "dist/index.d.mts",
  `export * from "./types.mjs";
import type { Connect, ErrorCode } from "./types.mjs";
export declare const connect: Connect;
export declare class RelayLLMError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string);
}
`,
);
chmodSync("dist/cli.mjs", 0o755);
