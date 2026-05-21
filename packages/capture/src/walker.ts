/**
 * Walk the workspace `memory/` tree and yield markdown files. Skips:
 *   - hidden dirs (.cache, .audit, .git, ...)
 *   - non-.md files
 *   - symlinks pointing outside the memory root
 *
 * Walker returns paths RELATIVE to `memoryRoot` so they round-trip into
 * provenance.path consistently.
 */

import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export interface WalkedFile {
  /** Absolute path on disk. */
  absPath: string;
  /** Path relative to memory root, using forward slashes. */
  relPath: string;
  /** mtime ms, useful as a fallback timestamp. */
  mtimeMs: number;
  /** byte size on disk. */
  size: number;
}

export interface WalkOptions {
  memoryRoot: string;
  /** Extra dir names to skip (besides defaults). */
  extraSkip?: string[];
  /** Include MEMORY.md sibling at workspaceRoot? */
  includeWorkspaceMemoryMd?: { workspaceRoot: string };
}

const DEFAULT_SKIP = new Set([
  ".cache",
  ".audit",
  ".git",
  ".dreams",
  "node_modules",
]);

export function walkMarkdown(opts: WalkOptions): WalkedFile[] {
  const skip = new Set(DEFAULT_SKIP);
  for (const s of opts.extraSkip ?? []) skip.add(s);

  const root = resolve(opts.memoryRoot);
  const out: WalkedFile[] = [];

  // Optional: pull workspace-root MEMORY.md into the corpus too. This lets us
  // index `~/.openclaw/workspace/MEMORY.md` even though it lives one level
  // above `memory/`. We tag it with a `../MEMORY.md` relative path so it is
  // unambiguous from a `MEMORY.md` file that lives directly under memory/.
  if (opts.includeWorkspaceMemoryMd) {
    const candidate = join(opts.includeWorkspaceMemoryMd.workspaceRoot, "MEMORY.md");
    pushIfFile(candidate, opts.includeWorkspaceMemoryMd.workspaceRoot, out, "../MEMORY.md");
  }

  walk(root, root, skip, out);

  // Stable ordering: shorter paths first, then alphabetic.
  out.sort((a, b) =>
    a.relPath.length - b.relPath.length || a.relPath.localeCompare(b.relPath)
  );
  return out;
}

function walk(
  root: string,
  dir: string,
  skip: Set<string>,
  out: WalkedFile[]
): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const name = String(entry.name);
    if (skip.has(name)) continue;
    if (name.startsWith(".")) continue;

    const abs = join(dir, name);

    if (entry.isDirectory()) {
      walk(root, abs, skip, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!name.toLowerCase().endsWith(".md")) continue;

    pushIfFile(abs, root, out);
  }
}

function pushIfFile(
  abs: string,
  root: string,
  out: WalkedFile[],
  relOverride?: string
): void {
  let st;
  try {
    st = statSync(abs);
  } catch {
    return;
  }
  if (!st.isFile()) return;

  const rel =
    relOverride ?? relative(root, abs).split(sep).join("/");
  out.push({
    absPath: abs,
    relPath: rel,
    mtimeMs: st.mtimeMs,
    size: st.size,
  });
}
