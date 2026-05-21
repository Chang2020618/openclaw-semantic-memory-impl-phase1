/**
 * `osm init` — create .cache/, write default config, open the DB so vec0 +
 * FTS5 tables are materialized, and log a baseline audit row.
 *
 * No reindex yet — that lands with M3.
 */

import { existsSync } from "node:fs";

import { OsmStore } from "@osm/store";

import {
  ensureMemoryRoot,
  loadOrInitConfig,
  resolveWorkspace,
  type ResolvedPaths,
} from "./workspace.js";

export interface InitArgs {
  rootFlag: string | undefined;
}

export interface InitResult {
  paths: ResolvedPaths;
  fresh: boolean;
}

export function runInit(args: InitArgs): InitResult {
  const paths = resolveWorkspace(args.rootFlag);
  ensureMemoryRoot(paths);

  const fresh = !existsSync(paths.dbPath);
  const config = loadOrInitConfig(paths);

  const store = new OsmStore({
    dbPath: paths.dbPath,
    embedding: {
      providerId: config.embedding.providerId,
      modelId: config.embedding.modelId,
      dim: config.embedding.dim,
    },
    createDirs: true,
  });

  store.appendAudit("rebuild", {
    op: "init",
    fresh,
    embedding: config.embedding,
    chunking: config.chunking,
  });
  store.close();

  return { paths, fresh };
}

export function printInitReport(result: InitResult): void {
  const { paths, fresh } = result;
  const lines = [
    `osm: ${fresh ? "initialized" : "verified"} at ${paths.cacheDir}`,
    `  workspace = ${paths.workspaceRoot}`,
    `  memory    = ${paths.memoryRoot}`,
    `  db        = ${paths.dbPath}`,
    `  config    = ${paths.configPath}`,
    `  audit     = ${paths.auditDir}`,
    "",
    fresh
      ? "Next: run `osm index` once embed + capture pipelines land (M3-M5)."
      : "Cache already present; init was a no-op.",
  ];
  console.log(lines.join("\n"));
}
