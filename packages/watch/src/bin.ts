#!/usr/bin/env bun
import { runWatchCli } from "./cli.js";

const args = process.argv.slice(2);
process.exitCode = await runWatchCli(args[0] === "watch" ? args.slice(1) : args);
