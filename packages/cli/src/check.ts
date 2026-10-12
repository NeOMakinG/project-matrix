import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkProject, DEFAULT_ADR_DIR, formatHuman, toReceipt } from "@matrix/rules";

export const CHECK_USAGE = `matrix check [dir] [options]   enforce the ADR rules in docs/adr on the project's sources

Options:
  --adr-dir <dir>   ADR folder relative to [dir] (default ${DEFAULT_ADR_DIR})
  --json            print the full result as JSON
  --receipt         print a loop receipt (kind adr-check) as JSON

Exit codes: 0 no errors, 1 rule violations or invalid rule blocks, 2 usage error.`;

export async function checkCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "adr-dir": { type: "string" },
      json: { type: "boolean", default: false },
      receipt: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(CHECK_USAGE);
    return 0;
  }
  if (positionals.length > 1) {
    console.error(CHECK_USAGE);
    return 2;
  }
  const root = resolve(positionals[0] ?? ".");
  const result = await checkProject(root, { adrDir: values["adr-dir"] ?? DEFAULT_ADR_DIR });
  if (values.receipt) console.log(JSON.stringify(toReceipt(result), null, 2));
  else if (values.json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatHuman(result));
  return result.ok ? 0 : 1;
}
