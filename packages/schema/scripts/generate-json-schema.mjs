// Writes json-schema/*.json from the Zod models. Requires a prior `tsc -b`.
// A test fails when the committed files drift from the models.
import { mkdirSync, writeFileSync } from "node:fs";
import { generateJsonSchemas } from "../dist/index.js";

const outDir = new URL("../json-schema/", import.meta.url);
mkdirSync(outDir, { recursive: true });
for (const [file, schema] of Object.entries(generateJsonSchemas())) {
  writeFileSync(new URL(file, outDir), `${JSON.stringify(schema, null, 2)}\n`);
  console.log(`wrote json-schema/${file}`);
}
