import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  checkProject,
  countEnforced,
  DEFAULT_ADR_DIR,
  formatHuman,
  loadWorktreeRules,
  RULES_MANIFEST_PATH,
  toReceipt,
} from "@matrix/rules";

export const CHECK_USAGE = `matrix check [dir] [options]   enforce the ADR rules in docs/adr on the project's sources

Options:
  --adr-dir <dir>         ADR folder relative to [dir] (default ${DEFAULT_ADR_DIR})
  --rules-from <ref>      load rules from the merge-base of HEAD and <ref> ("base" = main), so
                          the change under check cannot weaken them (use in the loop and CI)
  --allow-rule-removal    accept fewer enforced rules than the base (after human approval)
  --write-manifest        record the current enforced-rule count in ${RULES_MANIFEST_PATH}
  --json            print the full result as JSON
  --receipt         print a loop receipt (kind adr-check) as JSON

Exit codes: 0 no errors, 1 violations / invalid rules / fail-closed issues, 2 usage error.
ADR files changed relative to --rules-from are listed for human review.`;

export async function checkCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "adr-dir": { type: "string" },
      "rules-from": { type: "string" },
      "allow-rule-removal": { type: "boolean", default: false },
      "write-manifest": { type: "boolean", default: false },
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
  const adrDir = values["adr-dir"] ?? DEFAULT_ADR_DIR;
  if (values["write-manifest"]) {
    const minRules = countEnforced((await loadWorktreeRules(root, adrDir)).adrs);
    const path = join(root, RULES_MANIFEST_PATH);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({ version: 1, adrDir, minRules }, null, 2)}\n`);
    console.log(`Wrote ${RULES_MANIFEST_PATH}: ${minRules} enforced rules`);
    return 0;
  }
  let result: Awaited<ReturnType<typeof checkProject>>;
  try {
    result = await checkProject(root, {
      adrDir,
      ...(values["rules-from"] ? { rulesFrom: values["rules-from"] } : {}),
      allowRuleRemoval: values["allow-rule-removal"],
    });
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  if (process.env.GITHUB_ACTIONS === "true")
    for (const c of result.adrChanges)
      console.log(`::warning file=${c.file}::ADR ${c.change}; needs human review before merge`);
  if (values.receipt) console.log(JSON.stringify(toReceipt(result), null, 2));
  else if (values.json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatHuman(result));
  return result.ok ? 0 : 1;
}
