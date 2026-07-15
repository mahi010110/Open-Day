import { chmod } from "node:fs/promises";
import { build } from "esbuild";

const outfile = "apps/cli/dist/index.cjs";

await build({
  entryPoints: ["apps/cli/src/index.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  sourcemap: true,
  external: [
    "@anthropic-ai/sdk",
    "@anthropic-ai/sdk/*",
    "@google/genai",
    "@google/genai/*",
    "commander",
    "openai",
    "openai/*",
    "zod",
    "zod/*",
  ],
  legalComments: "eof",
});

await chmod(outfile, 0o755);
console.log(`CLI compilé : ${outfile}`);
