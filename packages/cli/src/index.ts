#!/usr/bin/env node
/**
 * `osm` — OpenClaw Semantic Memory CLI.
 *
 * M2: `osm init` is now real. Other commands remain stubs.
 */

import { SCHEMA_VERSION } from "@osm/core";

import { printInitReport, runInit } from "./cmd-init.js";
import { printIndexReport, runIndex } from "./cmd-index.js";
import { runSearch } from "./cmd-search.js";
import { runExplain } from "./cmd-explain.js";
import { runDoctor } from "./cmd-doctor.js";
import { runWatch } from "./cmd-watch.js";
import { runEvalCmd } from "./cmd-eval.js";

const VERSION = "0.1.0-dev";

interface ParsedArgs {
  command: string | undefined;
  rest: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(token);
    }
  }

  return { command, rest: positional, flags };
}

function rootFlagOf(flags: Record<string, string | boolean>): string | undefined {
  const v = flags["root"];
  return typeof v === "string" ? v : undefined;
}

function printHelp(): void {
  const lines = [
    `osm ${VERSION}  (schemaVersion=${SCHEMA_VERSION})`,
    "",
    "OpenClaw Semantic Memory — Phase-1 reference implementation.",
    "",
    "Usage:",
    "  osm <command> [args] [flags]",
    "",
    "Commands:",
    "  init                  create .cache/, write default config, open DB",
    "  index                 incremental reindex of memory/",
    "  index --rebuild       full rebuild from markdown",
    "  search <query>        hybrid retrieval, top-K with citations",
    "  explain <memoryId>    dump memory + provenance + recent audit hits",
    "  watch                 file watcher, incremental reindex on changes",
    "  doctor                health check (8 signals)",
    "  eval <test-set>       run frozen test set, score against v0.1 gates",
    "  eval ... --labels <p> include human verdicts for false-memory metric",
    "  version               print version and exit",
    "  help                  print this help",
    "",
    "Flags:",
    "  --root <path>         workspace root (default: ~/.openclaw/workspace)",
    "  --rebuild             with `index`: full rebuild",
    "  --provider <id>       override embedding providerId (e.g. local-stub)",
    "  --top-k <n>           with `search`: number of results",
    "  --json                with `search`/`explain`/`doctor`: emit raw JSON",
    "  --debug               with `search`: include debug counters",
    "  --audit-limit <n>     with `explain`: max recent audit hits to show",
    "",
    "Phase-1 status: M6. See ../openclaw-semantic-memory/docs/20-phase1-reference-impl.md.",
  ];
  console.log(lines.join("\n"));
}

function notImplemented(name: string, milestone: string): never {
  console.error(`osm: '${name}' is not implemented yet (lands with ${milestone}).`);
  console.error(
    "Track milestones in ../openclaw-semantic-memory/docs/20-phase1-reference-impl.md."
  );
  process.exit(2);
}

async function main(argv: string[]): Promise<number> {
  const { command, rest, flags } = parseArgs(argv);

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return 0;

    case "version":
    case "--version":
    case "-v":
      console.log(`osm ${VERSION} (schemaVersion=${SCHEMA_VERSION})`);
      return 0;

    case "init": {
      const result = runInit({ rootFlag: rootFlagOf(flags) });
      printInitReport(result);
      return 0;
    }

    case "index": {
      const report = await runIndex({
        rootFlag: rootFlagOf(flags),
        rebuild: Boolean(flags["rebuild"]),
        providerOverride:
          typeof flags["provider"] === "string" ? flags["provider"] : undefined,
      });
      printIndexReport(report);
      return 0;
    }
    case "search": {
      if (rest.length === 0) {
        console.error("osm search: missing <query>");
        return 64;
      }
      const query = rest.join(" ");
      const topKRaw = flags["top-k"];
      const topK =
        typeof topKRaw === "string" ? Number.parseInt(topKRaw, 10) : undefined;
      return await runSearch({
        rootFlag: rootFlagOf(flags),
        query,
        topK: typeof topK === "number" && Number.isFinite(topK) ? topK : undefined,
        json: Boolean(flags["json"]),
        debug: Boolean(flags["debug"]),
        providerOverride:
          typeof flags["provider"] === "string" ? flags["provider"] : undefined,
      });
    }
    case "explain": {
      if (rest.length === 0) {
        console.error("osm explain: missing <memoryId>");
        return 64;
      }
      const auditLimitRaw = flags["audit-limit"];
      const auditLimit =
        typeof auditLimitRaw === "string"
          ? Number.parseInt(auditLimitRaw, 10)
          : 10;
      return runExplain({
        rootFlag: rootFlagOf(flags),
        memoryId: rest[0]!,
        json: Boolean(flags["json"]),
        auditLimit:
          Number.isFinite(auditLimit) && auditLimit > 0 ? auditLimit : 10,
        ...(typeof flags["provider"] === "string"
          ? { providerOverride: flags["provider"] }
          : {}),
      });
    }
    case "watch": {
      return await runWatch({
        rootFlag: rootFlagOf(flags),
        ...(typeof flags["provider"] === "string"
          ? { providerOverride: flags["provider"] }
          : {}),
      });
    }
    case "doctor": {
      return runDoctor({
        rootFlag: rootFlagOf(flags),
        json: Boolean(flags["json"]),
        ...(typeof flags["provider"] === "string"
          ? { providerOverride: flags["provider"] }
          : {}),
      });
    }
    case "eval": {
      if (rest.length === 0) {
        console.error("osm eval: missing <test-set.jsonl>");
        return 64;
      }
      const labelsFlag = flags["labels"];
      return await runEvalCmd({
        rootFlag: rootFlagOf(flags),
        testSetPath: rest[0]!,
        labelsPath: typeof labelsFlag === "string" ? labelsFlag : undefined,
        json: Boolean(flags["json"]),
        ...(typeof flags["provider"] === "string"
          ? { providerOverride: flags["provider"] }
          : {}),
      });
    }

    default:
      console.error(`osm: unknown command '${command}'`);
      console.error("Run 'osm help' for usage.");
      return 64;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error(`osm: fatal error\n${msg}`);
    process.exit(1);
  });
