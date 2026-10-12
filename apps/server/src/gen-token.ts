import { randomBytes } from "node:crypto";

// Prints a fresh bootstrap token in the API key format, for MATRIX_BOOTSTRAP_TOKEN.
const id = randomBytes(12).toString("hex").slice(0, 12);
console.log(`mx_${id}_${randomBytes(32).toString("base64url")}`);
