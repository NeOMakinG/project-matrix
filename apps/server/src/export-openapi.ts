import { writeFileSync } from "node:fs";
import { createServer } from "./http/app.js";
import { MemoryCore } from "./memory-core.js";

// Writes the OpenAPI document the SDK types are generated from.
const out = process.argv[2] ?? "openapi.json";
const { app } = createServer({ core: new MemoryCore() });
const response = await app.request("/openapi.json");
writeFileSync(out, `${JSON.stringify(await response.json(), null, 2)}\n`);
console.log(`wrote ${out}`);
