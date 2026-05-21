/**
 * Workspace + paths + config helpers for the CLI.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  DEFAULT_CONFIG,
  OsmConfigSchema,
  type OsmConfig,
} from "@osm/core";

export interface ResolvedPaths {
  /** workspace root, e.g. /root/.openclaw/workspace */
  workspaceRoot: string;
  /** memory root, e.g. /root/.openclaw/workspace/memory */
  memoryRoot: string;
  /** parent for derived index + audit, e.g. /root/.openclaw/workspace/memory/.cache */
  cacheDir: string;
  /** sqlite db path */
  dbPath: string;
  /** config json path */
  configPath: string;
  /** audit dir (logs that don't fit cleanly in audit table) */
  auditDir: string;
}

export function resolveWorkspace(rootFlag: string | undefined): ResolvedPaths {
  const workspaceRoot = rootFlag
    ? resolve(rootFlag)
    : resolve(join(homedir(), ".openclaw", "workspace"));
  const memoryRoot = join(workspaceRoot, "memory");
  const cacheDir = join(memoryRoot, ".cache");
  return {
    workspaceRoot,
    memoryRoot,
    cacheDir,
    dbPath: join(cacheDir, "index.db"),
    configPath: join(cacheDir, "config.json"),
    auditDir: join(memoryRoot, ".audit"),
  };
}

export function ensureMemoryRoot(paths: ResolvedPaths): void {
  if (!existsSync(paths.memoryRoot)) {
    throw new Error(
      `osm: memory root not found at ${paths.memoryRoot}. ` +
        `Create the directory or pass --root <workspace>.`
    );
  }
  mkdirSync(paths.cacheDir, { recursive: true });
  mkdirSync(paths.auditDir, { recursive: true });
}

export function loadOrInitConfig(paths: ResolvedPaths): OsmConfig {
  if (!existsSync(paths.configPath)) {
    return writeConfig(paths, DEFAULT_CONFIG);
  }
  const raw = readFileSync(paths.configPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `osm: failed to parse ${paths.configPath}: ${(err as Error).message}`
    );
  }
  const result = OsmConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `osm: invalid config at ${paths.configPath}\n${result.error.toString()}`
    );
  }
  return result.data;
}

export function writeConfig(
  paths: ResolvedPaths,
  config: OsmConfig
): OsmConfig {
  mkdirSync(dirname(paths.configPath), { recursive: true });
  const validated = OsmConfigSchema.parse(config);
  writeFileSync(
    paths.configPath,
    JSON.stringify(validated, null, 2) + "\n",
    "utf8"
  );
  return validated;
}
