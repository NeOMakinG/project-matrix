#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { parseArgs } from "node:util";
import { type Answers, defaultPacks, nextRound, recommendedFor } from "@matrix/packs";
import { runInit } from "./init";
import { interview } from "./interactive";

const USAGE = `matrix init [dir] [options]   run the init interview and generate the project
matrix init next --answers <file>   print the next interview round as JSON (for agents)

Options:
  --answers <file>   answers JSON (question id -> value); skips the interactive interview
  --yes              accept recommended answers for anything not answered
  --existing         onboard an existing repo in [dir]: infer answers, no scaffold
  --no-scaffold      only write config, ADRs, CONTEXT.md, graph and backlog
  --force            replace existing generated files (never follows symlinks)
  --json             machine-readable output`;

async function readAnswers(path: string | undefined): Promise<Answers> {
  return path ? (JSON.parse(await readFile(path, "utf8")) as Answers) : {};
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      answers: { type: "string" },
      yes: { type: "boolean", default: false },
      existing: { type: "boolean", default: false },
      "no-scaffold": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, sub, maybeDir] = positionals;
  if (values.help || command !== "init") {
    console.log(USAGE);
    return command === "init" || values.help ? 0 : 1;
  }

  if (sub === "next") {
    const answers = await readAnswers(values.answers);
    const round = nextRound(defaultPacks, answers).map((q) => ({
      id: q.id,
      pack: q.pack,
      prompt: q.prompt,
      kind: q.kind,
      options: q.options ?? [],
      recommended: recommendedFor(q, answers) ?? null,
      rationale: q.rationale ?? null,
    }));
    console.log(JSON.stringify({ done: round.length === 0, round }, null, 2));
    return 0;
  }

  const outDir = resolvePath(sub ?? maybeDir ?? ".");
  let answers = await readAnswers(values.answers);
  if (!values.answers && process.stdin.isTTY) answers = await interview(answers);

  const result = await runInit({
    answers,
    outDir,
    acceptRecommended: values.yes,
    scaffold: !values.existing && !values["no-scaffold"],
    force: values.force,
    ...(values.existing ? { existingRepo: outDir } : {}),
  });

  if (values.json) {
    const { status } = result;
    console.log(
      JSON.stringify(status === "ok" ? { ...result, config: undefined } : result, null, 2),
    );
    return status === "ok" ? 0 : 2;
  }
  switch (result.status) {
    case "missing":
      console.error(`Unanswered questions (pass them in --answers or use --yes):`);
      for (const q of result.missing) console.error(`  ${q.id}: ${q.prompt}`);
      return 2;
    case "contradictions":
      console.error("The answers contradict each other:");
      for (const c of result.contradictions)
        console.error(`  [${c.id}] ${c.message} (re-answer: ${c.questions.join(", ")})`);
      return 2;
    case "conflicts":
      console.error(
        "These files already exist. Re-run with --force to replace them, or use --existing:",
      );
      for (const f of result.files) console.error(`  ${f}`);
      return 2;
    case "invalid":
      console.error("The answers don't produce a valid matrix.config:");
      for (const i of result.issues) console.error(`  ${i.path}: ${i.message}`);
      return 2;
    case "ok":
      console.log(
        `Wrote ${result.files.length} files and ${result.tickets.length} tickets to ${outDir}`,
      );
      for (const w of [...result.warnings, ...result.contradictions.map((c) => c.message)])
        console.log(`  note: ${w}`);
      return 0;
  }
}

process.exitCode = await main(process.argv.slice(2));
