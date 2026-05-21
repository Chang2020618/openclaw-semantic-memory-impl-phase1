/**
 * Markdown-aware chunker.
 *
 * Goals (v0.1):
 *   - respect heading boundaries (H1/H2/H3)
 *   - keep paragraph integrity when possible
 *   - target ~targetChars per chunk
 *   - apply soft overlap between adjacent chunks of the same section
 *   - preserve line ranges so citations remain accurate
 *
 * Non-goals (Phase 1):
 *   - no tokenization-aware sizing (we measure characters; embedding models
 *     happen to behave well on this scale for our corpus)
 *   - no smart sentence splitting (paragraph granularity is enough)
 *   - no AST-based parsing — we walk lines, because our memory is line-oriented
 */

export interface ChunkerOptions {
  targetChars: number;
  softOverlapChars: number;
  respectHeadings: boolean;
}

export interface RawChunk {
  text: string;
  lineStart: number;
  lineEnd: number;
  /** Section breadcrumb, e.g. "Project Context > 2026-05-21 - SSH". */
  headingPath: string[];
}

interface Section {
  headingPath: string[];
  lineStart: number;
  lineEnd: number;
  lines: string[];
}

/**
 * Split markdown into raw chunks. Input is expected to be the whole file
 * contents; lineStart/lineEnd in the output are 1-based, inclusive.
 */
export function chunkMarkdown(
  source: string,
  opts: ChunkerOptions
): RawChunk[] {
  const sections = opts.respectHeadings
    ? splitByHeadings(source)
    : [
        {
          headingPath: [],
          lineStart: 1,
          lineEnd: countLines(source),
          lines: source.split(/\r?\n/),
        },
      ];

  const chunks: RawChunk[] = [];
  for (const section of sections) {
    const sectionChunks = chunkSection(section, opts);
    chunks.push(...sectionChunks);
  }
  return chunks;
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

function countLines(source: string): number {
  if (source.length === 0) return 0;
  return source.split(/\r?\n/).length;
}

/** Split a markdown document into top-down sections by ATX headings. */
function splitByHeadings(source: string): Section[] {
  const lines = source.split(/\r?\n/);
  const headingRegex = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

  // Stack of (level, title).
  const stack: Array<{ level: number; title: string }> = [];
  let currentLines: string[] = [];
  let currentStart = 1;
  let currentPath: string[] = [];

  const sections: Section[] = [];

  const flush = (endLine: number) => {
    if (currentLines.length === 0) return;
    sections.push({
      headingPath: [...currentPath],
      lineStart: currentStart,
      lineEnd: endLine,
      lines: currentLines,
    });
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const m = headingRegex.exec(line);
    if (m) {
      // Close the previous section at the line before this heading.
      flush(i); // endLine is exclusive of this heading line, so i (1-based last) is i (0-based current) i.e. i lines total since start? we handle off-by-one carefully below.

      const level = m[1]!.length;
      const title = m[2]!.trim();

      // Pop stack until top is shallower than this heading.
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) {
        stack.pop();
      }
      stack.push({ level, title });
      currentPath = stack.map((s) => s.title);

      // Start a new section that INCLUDES the heading line itself.
      currentLines = [line];
      currentStart = i + 1; // convert 0-based -> 1-based
    } else {
      currentLines.push(line);
    }
  }
  flush(lines.length);

  return sections.filter((s) => s.lines.some((l) => l.trim().length > 0));
}

/** Chunk one section, respecting paragraph boundaries and target size. */
function chunkSection(section: Section, opts: ChunkerOptions): RawChunk[] {
  const paragraphs = splitParagraphs(section.lines, section.lineStart);

  const chunks: RawChunk[] = [];
  let buf: Array<{ text: string; lineStart: number; lineEnd: number }> = [];
  let bufLen = 0;

  const flush = () => {
    if (buf.length === 0) return;
    const text = buf.map((p) => p.text).join("\n\n").trim();
    if (text.length === 0) {
      buf = [];
      bufLen = 0;
      return;
    }
    const lineStart = buf[0]!.lineStart;
    const lineEnd = buf[buf.length - 1]!.lineEnd;
    chunks.push({
      text,
      lineStart,
      lineEnd,
      headingPath: section.headingPath,
    });
    buf = [];
    bufLen = 0;
  };

  for (const para of paragraphs) {
    const paraLen = para.text.length;

    // A single paragraph that exceeds target: try to split on bullet
    // boundaries before falling back to one giant chunk.
    if (paraLen >= opts.targetChars) {
      flush();
      const subChunks = splitOversizedParagraph(para, opts.targetChars);
      for (const sub of subChunks) {
        chunks.push({
          text: sub.text,
          lineStart: sub.lineStart,
          lineEnd: sub.lineEnd,
          headingPath: section.headingPath,
        });
      }
      continue;
    }

    if (bufLen + paraLen + 2 > opts.targetChars && buf.length > 0) {
      flush();
    }
    buf.push(para);
    bufLen += paraLen + 2;
  }
  flush();

  // Apply soft overlap between adjacent chunks of the same section. The
  // overlap is taken from the tail of the previous chunk.
  if (opts.softOverlapChars > 0 && chunks.length > 1) {
    for (let i = 1; i < chunks.length; i += 1) {
      const prev = chunks[i - 1]!;
      const tail = prev.text.slice(-opts.softOverlapChars);
      chunks[i] = {
        ...chunks[i]!,
        text: `${tail.trim()}\n\n${chunks[i]!.text}`.trim(),
      };
    }
  }

  return chunks;
}

interface Paragraph {
  text: string;
  lineStart: number;
  lineEnd: number;
}

/**
 * Split an oversized paragraph (typically a long bullet list with no blank
 * lines) on top-level bullet boundaries. Lines starting with `- `, `* `,
 * `+ `, or `1. ` style markers are treated as list-item starts.
 */
function splitOversizedParagraph(
  para: Paragraph,
  targetChars: number
): Paragraph[] {
  const lines = para.text.split(/\r?\n/);
  const itemRe = /^\s{0,3}(?:[-*+]|\d+\.)\s/;

  const items: Array<{ text: string; lineOffset: number; lineCount: number }> =
    [];
  let cur: { text: string; lineOffset: number; lineCount: number } | null =
    null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const isItem = itemRe.test(line);
    if (isItem) {
      if (cur) items.push(cur);
      cur = { text: line, lineOffset: i, lineCount: 1 };
    } else if (cur) {
      cur.text += `\n${line}`;
      cur.lineCount += 1;
    } else {
      cur = { text: line, lineOffset: i, lineCount: 1 };
    }
  }
  if (cur) items.push(cur);

  if (items.length <= 1) {
    return [para];
  }

  const out: Paragraph[] = [];
  let buf: string[] = [];
  let bufStart = para.lineStart;
  let bufEnd = para.lineStart;
  let bufLen = 0;

  const flushBuf = (): void => {
    if (buf.length === 0) return;
    out.push({
      text: buf.join("\n"),
      lineStart: bufStart,
      lineEnd: bufEnd,
    });
    buf = [];
    bufLen = 0;
  };

  for (const it of items) {
    const itLen = it.text.length;
    if (bufLen > 0 && bufLen + itLen + 1 > targetChars) {
      flushBuf();
    }
    if (buf.length === 0) {
      bufStart = para.lineStart + it.lineOffset;
    }
    buf.push(it.text);
    bufEnd = para.lineStart + it.lineOffset + it.lineCount - 1;
    bufLen += itLen + 1;
  }
  flushBuf();

  return out;
}

function splitParagraphs(lines: string[], lineStart: number): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let buf: string[] = [];
  let bufStart = lineStart;

  const flush = (endLine: number) => {
    const text = buf.join("\n").trim();
    if (text.length > 0) {
      paragraphs.push({
        text,
        lineStart: bufStart,
        lineEnd: endLine,
      });
    }
    buf = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const isBlank = line.trim().length === 0;

    if (isBlank) {
      if (buf.length > 0) {
        flush(lineStart + i - 1);
      }
      bufStart = lineStart + i + 1;
      continue;
    }
    if (buf.length === 0) {
      bufStart = lineStart + i;
    }
    buf.push(line);
  }
  flush(lineStart + lines.length - 1);

  return paragraphs;
}
