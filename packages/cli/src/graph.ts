import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  adrsGoverning,
  buildCodeGraph,
  checkGraphDrift,
  dependenciesOf,
  featuresForTicket,
  impactOfFile,
  importersOf,
  importersOfPackage,
  isSource,
  loadProductGraph,
  packageOf,
  writeGraph,
} from "@matrix/graph";
import { adrScopes, DEFAULT_ADR_DIR, loadAdrs } from "@matrix/rules";

export const GRAPH_USAGE = `matrix graph [dir]            regenerate .matrix/graph/code.json and GRAPH.md
matrix graph [dir] --check    fail (exit 1) when the committed graph is stale
matrix graph query <name> <arg> [--dir <dir>]
  who-imports <path|package>  modules importing a file or package
  deps <path>                 files a module imports
  adrs-for <path>             ADRs governing a path
  ticket-features <ticket>    product features a ticket touches
  impact <path>               dependents, features and ADRs affected by a change

Options:
  --json   machine-readable output`;

async function query(name: string, arg: string, dir: string): Promise<unknown> {
  const root = resolve(dir);
  switch (name) {
    case "who-imports": {
      const code = await buildCodeGraph(root);
      return isSource(arg) ? importersOf(code, arg) : importersOfPackage(code, packageOf(arg));
    }
    case "deps":
      return dependenciesOf(await buildCodeGraph(root), arg);
    case "adrs-for":
      return adrsGoverning(
        arg,
        adrScopes(await loadAdrs(root, DEFAULT_ADR_DIR)),
        await loadProductGraph(root),
      );
    case "ticket-features":
      return featuresForTicket(await loadProductGraph(root), arg);
    case "impact":
      return impactOfFile(arg, {
        code: await buildCodeGraph(root),
        product: await loadProductGraph(root),
        adrScopes: adrScopes(await loadAdrs(root, DEFAULT_ADR_DIR)),
      });
    default:
      throw new Error(`unknown query "${name}"`);
  }
}

export async function graphCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      check: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      dir: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(GRAPH_USAGE);
    return 0;
  }

  if (positionals[0] === "query") {
    const [, name, rawArg] = positionals;
    const arg = rawArg?.replace(/^\.\//, "");
    if (!name || !arg) {
      console.error(GRAPH_USAGE);
      return 2;
    }
    try {
      console.log(JSON.stringify(await query(name, arg, values.dir ?? "."), null, 2));
      return 0;
    } catch (e) {
      console.error((e as Error).message);
      return 2;
    }
  }

  const root = resolve(positionals[0] ?? ".");
  try {
    await loadProductGraph(root);
  } catch (error) {
    console.error(`invalid product knowledge: ${(error as Error).message}`);
    return 1;
  }
  if (values.check) {
    const drift = await checkGraphDrift(root);
    if (values.json) console.log(JSON.stringify(drift, null, 2));
    else if (drift.ok) console.log("ok: code graph is up to date");
    else
      console.error(
        `stale: ${drift.stale.join(", ")}\nRun \`matrix graph\` and commit the result.`,
      );
    return drift.ok ? 0 : 1;
  }
  const { graph } = await writeGraph(root);
  const summary = {
    modules: graph.modules.length,
    packages: graph.packages.length,
    cycles: graph.cycles.length,
  };
  if (values.json) console.log(JSON.stringify(summary, null, 2));
  else
    console.log(
      `Wrote .matrix/graph/code.json and GRAPH.md: ${summary.modules} modules, ${summary.packages} packages, ${summary.cycles} cycles`,
    );
  return 0;
}
