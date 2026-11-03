#!/usr/bin/env bun
/**
 * Review Guide helper. Run from inside the repository.
 *
 *   bun guide.ts files <base> <head>             changed files, auto-flagged Low-signal Files
 *   bun guide.ts render <guide.json> <out.html>  render a Review Guide, then check it in headless Chrome
 *                [--no-check]
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname } from "node:path";

const CATEGORIES = [
  "intent-mismatch",
  "contract",
  "data-migration",
  "concurrency",
  "security",
  "error-handling",
  "performance",
  "test-coverage",
  "other",
] as const;
type Category = (typeof CATEGORIES)[number];
type Side = "new" | "old";

interface Ref {
  file: string;
  line: number;
  endLine?: number;
  side?: Side;
  note?: string;
}

interface Hotspot extends Ref {
  id: string;
  title: string;
  category: Category;
  why: string;
  evidence?: Ref[];
  nodes?: string[];
}

interface ReadingGroup {
  title: string;
  note?: string;
  files: { file: string; note?: string }[];
}

interface Takeaway {
  title: string;
  text: string;
}

interface LowSignalGroup {
  title: string;
  text?: string;
  files: string[];
}

interface Guide {
  title: string;
  base: string;
  head: string;
  pr?: { url: string };
  intent: { text: string; inferred: boolean };
  scope?: string;
  changeMaps: { title: string; description?: string; mermaid: string; takeaways?: Takeaway[] }[];
  hotspots: Hotspot[];
  readingOrder: ReadingGroup[];
  lowSignal?: LowSignalGroup[];
  behaviorDiagrams?: { title: string; description?: string; before?: string; after: string }[];
}

interface ChangedFile {
  path: string;
  oldPath?: string;
  status: string;
  added: number | null;
  deleted: number | null;
  lowSignal?: string;
}

interface DiffLine {
  kind: " " | "+" | "-";
  text: string;
  // Counter positions on each side; for +/- lines the opposite side holds the next line number.
  oPos: number;
  nPos: number;
}

function git(...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
}

function tryGit(...args: string[]): string | null {
  try {
    return git(...args);
  } catch {
    return null;
  }
}

const LOCKFILES = new Set([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
  "go.sum",
  "Gemfile.lock",
  "composer.lock",
  "Pipfile.lock",
  "flake.lock",
]);

function lowSignalReason(f: ChangedFile, head: string): string | undefined {
  if (f.status === "R100") return "pure rename";
  if (LOCKFILES.has(basename(f.path))) return "lockfile";
  if (f.added === null) return "binary";
  if (/\.min\.(js|css)$|\.map$/.test(f.path)) return "generated";
  if (f.status === "D") return undefined;
  const top = tryGit("show", `${head}:${f.path}`)?.split("\n", 3).join("\n") ?? "";
  if (/@generated|DO NOT EDIT|auto-?generated/i.test(top)) return "generated";
}

function changedFiles(mergeBase: string, head: string): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>();
  const ns = git("diff", "-M", "--name-status", "-z", mergeBase, head).split("\0");
  for (let i = 0; i < ns.length - 1; ) {
    const status = ns[i++];
    if (/^[RC]/.test(status)) {
      const oldPath = ns[i++];
      const path = ns[i++];
      byPath.set(path, { path, oldPath, status, added: 0, deleted: 0 });
    } else {
      const path = ns[i++];
      byPath.set(path, { path, status, added: 0, deleted: 0 });
    }
  }
  const num = git("diff", "-M", "--numstat", "-z", mergeBase, head).split("\0");
  for (let i = 0; i < num.length - 1; ) {
    const [a, d, p] = num[i++].split("\t");
    const path = p === "" ? (i++, num[i++]) : p;
    const f = byPath.get(path);
    if (!f) continue;
    f.added = a === "-" ? null : Number(a);
    f.deleted = d === "-" ? null : Number(d);
  }
  const files = [...byPath.values()];
  for (const f of files) f.lowSignal = lowSignalReason(f, head);
  return files;
}

function fileHunks(mergeBase: string, head: string, f: { path: string; oldPath?: string }): DiffLine[][] {
  const paths = f.oldPath ? [f.oldPath, f.path] : [f.path];
  const out = git("diff", "-M", "--no-color", "-U3", mergeBase, head, "--", ...paths);
  const hunks: DiffLine[][] = [];
  let cur: DiffLine[] | null = null;
  let o = 0;
  let n = 0;
  for (const raw of out.split("\n")) {
    const m = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (m) {
      cur = [];
      hunks.push(cur);
      o = Number(m[1]);
      n = Number(m[2]);
      continue;
    }
    if (!cur) continue;
    const kind = raw[0];
    if (kind === " ") cur.push({ kind, text: raw.slice(1), oPos: o++, nPos: n++ });
    else if (kind === "+") cur.push({ kind, text: raw.slice(1), oPos: o, nPos: n++ });
    else if (kind === "-") cur.push({ kind, text: raw.slice(1), oPos: o++, nPos: n });
  }
  return hunks;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function prose(s: string): string {
  return s
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")}</p>`)
    .join("");
}

function inline(s: string): string {
  return prose(s).replace(/^<p>|<\/p>$/g, "");
}

const hash = (algo: "sha1" | "sha256", s: string) => createHash(algo).update(s).digest("hex");

function langOf(file: string): string {
  return (extname(file).slice(1) || basename(file)).toLowerCase();
}

function validate(g: Guide): string[] {
  const errs: string[] = [];
  const str = (v: unknown, at: string) => {
    if (typeof v !== "string" || !v.trim()) errs.push(`${at}: expected non-empty string`);
  };
  const arr = (v: unknown, at: string) => {
    if (!Array.isArray(v)) errs.push(`${at}: expected array`);
    return Array.isArray(v) ? v : [];
  };
  const ref = (r: Ref, at: string) => {
    str(r?.file, `${at}.file`);
    if (!Number.isInteger(r?.line) || r.line < 1) errs.push(`${at}.line: expected positive integer`);
    if (r?.endLine !== undefined && (!Number.isInteger(r.endLine) || r.endLine < r.line))
      errs.push(`${at}.endLine: expected integer >= line`);
    if (r?.side !== undefined && r.side !== "new" && r.side !== "old") errs.push(`${at}.side: expected "new" or "old"`);
  };
  str(g.title, "title");
  str(g.base, "base");
  str(g.head, "head");
  if (g.pr !== undefined) str(g.pr.url, "pr.url");
  str(g.intent?.text, "intent.text");
  if (typeof g.intent?.inferred !== "boolean") errs.push("intent.inferred: expected boolean");
  if (g.scope !== undefined) str(g.scope, "scope");
  arr(g.changeMaps, "changeMaps").forEach((m, i) => {
    str(m.title, `changeMaps[${i}].title`);
    str(m.mermaid, `changeMaps[${i}].mermaid`);
    if (/%%\{\s*init/.test(m.mermaid ?? "")) errs.push(`changeMaps[${i}].mermaid: remove the %%{init}%% directive, theme and layout are set globally`);
    (m.takeaways ?? []).forEach((t: Takeaway, j: number) => {
      str(t.title, `changeMaps[${i}].takeaways[${j}].title`);
      str(t.text, `changeMaps[${i}].takeaways[${j}].text`);
    });
  });
  const ids = new Set<string>();
  arr(g.hotspots, "hotspots").forEach((h: Hotspot, i) => {
    const at = `hotspots[${i}]`;
    if (typeof h.id !== "string" || !/^[a-z0-9-]+$/.test(h.id)) errs.push(`${at}.id: expected kebab-case`);
    else if (ids.has(h.id)) errs.push(`${at}.id: duplicate '${h.id}'`);
    ids.add(h.id);
    str(h.title, `${at}.title`);
    str(h.why, `${at}.why`);
    if (!CATEGORIES.includes(h.category)) errs.push(`${at}.category: expected one of ${CATEGORIES.join(", ")}`);
    ref(h, at);
    (h.evidence ?? []).forEach((e, j) => ref(e, `${at}.evidence[${j}]`));
  });
  arr(g.readingOrder, "readingOrder").forEach((grp, i) => {
    str(grp.title, `readingOrder[${i}].title`);
    arr(grp.files, `readingOrder[${i}].files`).forEach((r, j) => str(r.file, `readingOrder[${i}].files[${j}].file`));
  });
  (g.lowSignal ?? []).forEach((l, i) => {
    str(l.title, `lowSignal[${i}].title`);
    arr(l.files, `lowSignal[${i}].files`).forEach((f, j) => str(f, `lowSignal[${i}].files[${j}]`));
  });
  (g.behaviorDiagrams ?? []).forEach((b, i) => {
    str(b.title, `behaviorDiagrams[${i}].title`);
    str(b.after, `behaviorDiagrams[${i}].after`);
  });
  return errs;
}

function render(g: Guide): string {
  const mergeBase = git("merge-base", g.base, g.head).trim();
  const head = git("rev-parse", g.head).trim();
  const files = changedFiles(mergeBase, head);
  const fileByPath = new Map(files.map((f) => [f.path, f]));
  const hunkCache = new Map<string, DiffLine[][]>();
  const hunksOf = (path: string) => {
    if (!hunkCache.has(path)) {
      const f = fileByPath.get(path) ?? files.find((x) => x.oldPath === path);
      hunkCache.set(path, f ? fileHunks(mergeBase, head, f) : []);
    }
    return hunkCache.get(path)!;
  };

  const prUrl = g.pr?.url.replace(/\/+$/, "");
  const host = prUrl?.includes("/-/merge_requests/") ? "gitlab" : prUrl ? "github" : null;
  const webUrl = prUrl?.replace(/\/(-\/merge_requests|pull)\/\d+.*$/, "");

  const sideOf = (r: Ref): Side => r.side ?? "new";
  const pos = (l: DiffLine, side: Side) => (side === "new" ? l.nPos : l.oPos);
  const onSide = (l: DiffLine, side: Side) => l.kind !== (side === "new" ? "-" : "+");

  // First diff line that is the referenced line itself, or undefined when outside every hunk.
  const locate = (r: Ref) => {
    const side = sideOf(r);
    const end = r.endLine ?? r.line;
    for (const hunk of hunksOf(r.file))
      for (const l of hunk) if (onSide(l, side) && pos(l, side) >= r.line && pos(l, side) <= end) return l;
  };

  const link = (r: Ref): string | null => {
    if (!prUrl) return null;
    const side = sideOf(r);
    const hit = locate(r);
    if (hit) {
      if (host === "gitlab") return `${prUrl}/diffs#${hash("sha1", r.file)}_${hit.oPos}_${hit.nPos}`;
      const p = side === "new" ? "R" : "L";
      return `${prUrl}/files#diff-${hash("sha256", r.file)}${p}${r.line}${r.endLine ? `-${p}${r.endLine}` : ""}`;
    }
    const sha = side === "new" ? head : mergeBase;
    const path = encodeURI(r.file);
    if (host === "gitlab") return `${webUrl}/-/blob/${sha}/${path}#L${r.line}${r.endLine ? `-${r.endLine}` : ""}`;
    return `${webUrl}/blob/${sha}/${path}#L${r.line}${r.endLine ? `-L${r.endLine}` : ""}`;
  };

  const fileLink = (path: string): string | null => {
    if (!prUrl) return null;
    return host === "gitlab" ? `${prUrl}/diffs#${hash("sha1", path)}` : `${prUrl}/files#diff-${hash("sha256", path)}`;
  };

  const loc = (r: Ref) => {
    const label = `${r.file}:${r.line}${r.endLine ? `-${r.endLine}` : ""}${sideOf(r) === "old" ? " (before)" : ""}`;
    const href = link(r);
    return href ? `<a href="${esc(href)}"><code>${esc(label)}</code></a>` : `<code>${esc(label)}</code>`;
  };

  const GAP = `<tr class="gap"><td colspan="4">⋯</td></tr>`;
  const row = (lang: string, cls: string, o: string | number, n: string | number, sign: string, text: string, key = "") =>
    `<tr class="${cls}"${key ? ` data-k="${key}"` : ""}><td class="ln">${o}</td><td class="ln">${n}</td><td class="sign">${sign}</td><td class="code" data-lang="${lang}">${esc(text)}</td></tr>`;
  const diffRow = (lang: string, l: DiffLine) =>
    row(
      lang,
      l.kind === "+" ? "add" : l.kind === "-" ? "del" : "ctx",
      l.kind === "+" ? "" : l.oPos,
      l.kind === "-" ? "" : l.nPos,
      l.kind === " " ? "" : l.kind,
      l.text,
      // Comment anchor: the line's own side and number.
      l.kind === "-" ? `o${l.oPos}` : `n${l.nPos}`,
    );

  const excerpt = (r: Ref): string => {
    const side = sideOf(r);
    const lang = esc(langOf(r.file));
    const lo = r.line - 3;
    const hi = (r.endLine ?? r.line) + 3;
    let rows: string[] = [];
    if (locate(r)) {
      for (const hunk of hunksOf(r.file)) {
        const picked = hunk.filter((l) => pos(l, side) >= lo && pos(l, side) <= hi);
        if (!picked.length) continue;
        if (rows.length) rows.push(GAP);
        rows.push(...picked.map((l) => diffRow(lang, l)));
      }
    } else {
      const blob = tryGit("show", `${side === "new" ? head : mergeBase}:${r.file}`);
      if (blob === null) return "";
      const lines = blob.split("\n");
      for (let i = Math.max(1, lo); i <= Math.min(lines.length, hi); i++)
        rows.push(row(lang, "ctx", side === "old" ? i : "", side === "new" ? i : "", "", lines[i - 1]));
    }
    rows = rows.slice(0, 80);
    return rows.length ? `<table class="diff">${rows.join("")}</table>` : "";
  };

  const MAX_FILE_DIFF_ROWS = 600;
  const fileDiff = (path: string): string => {
    const f = fileByPath.get(path);
    if (!f) return `<p class="muted">Not changed in this pull request.</p>`;
    if (f.added === null) return `<p class="muted">Binary file.</p>`;
    const lang = esc(langOf(path));
    const rows: string[] = [];
    for (const hunk of hunksOf(path)) {
      if (rows.length) rows.push(GAP);
      rows.push(...hunk.map((l) => diffRow(lang, l)));
    }
    if (!rows.length) return `<p class="muted">No content change.</p>`;
    const more = rows.length - MAX_FILE_DIFF_ROWS;
    return `<table class="diff">${rows.slice(0, MAX_FILE_DIFF_ROWS).join("")}</table>${more > 0 ? `<p class="muted">${more} more lines not shown.</p>` : ""}`;
  };

  const CLASSDEFS = [
    "classDef new fill:#dcf3e4,stroke:#1e8a4a,color:#0d3a20,stroke-width:1.6px",
    "classDef changed fill:#fdf0d2,stroke:#b07d0c,color:#4a3405,stroke-width:1.6px",
    "classDef removed fill:#fbe3e3,stroke:#c0392b,color:#5c1a13,stroke-width:1.6px,stroke-dasharray:5 3",
    "classDef context fill:#eef1f5,stroke:#8a94a6,color:#2a3140",
    "classDef external fill:#e0eafb,stroke:#2a5db0,color:#0f2a57",
  ];
  const changeMapSource = (src: string) => {
    if (!/^\s*(flowchart|graph)\b/.test(src)) return src;
    const byNode = new Map<string, Hotspot[]>();
    for (const h of g.hotspots)
      for (const node of h.nodes ?? [])
        if (new RegExp(`(^|\\W)${node.replace(/\W/g, "\\$&")}(\\W|$)`, "m").test(src)) byNode.set(node, [...(byNode.get(node) ?? []), h]);
    const clicks = [...byNode].map(([node, hs]) => {
      const tip = hs.map((h) => `${g.hotspots.indexOf(h) + 1}. ${h.title}`).join(" · ").replace(/[^\w\s.,:()\/·-]/g, "");
      return `click ${node} href "#hotspot-${hs[0].id}" "${tip}" _self`;
    });
    return `${src.trimEnd()}\n${[...CLASSDEFS, ...clicks].map((l) => `  ${l}`).join("\n")}`;
  };
  const board = (src: string, legend = false) => `<div class="board"${legend ? " data-legend" : ""}>
  <div class="tools" role="toolbar" aria-label="Diagram view">
    <button type="button" data-act="out" aria-label="Zoom out">−</button><output class="zl">100%</output><button type="button" data-act="in" aria-label="Zoom in">+</button>
    <button type="button" data-act="fit">Fit</button><button type="button" data-act="actual">100%</button>
    <span class="hint">Drag to pan · ⌘/Ctrl + scroll to zoom</span>
    ${legend ? `<button type="button" data-act="legend" aria-pressed="false">Legend</button>` : ""}<button type="button" data-act="expand" class="primary">Expand</button>
  </div>
  <div class="viewport"><pre class="diagram">${esc(src)}</pre></div>
</div>`;
  const takeaways = (ts?: Takeaway[]) =>
    ts?.length ? `<div class="takeaways">${ts.map((t) => `<div><b>${inline(t.title)}</b>${prose(t.text)}</div>`).join("")}</div>` : "";

  const AUTO_GROUPS: Record<string, [string, string]> = {
    lockfile: ["Lockfiles", "Dependency lockfiles."],
    generated: ["Generated files", "Marked as generated, or minified/source-map output."],
    binary: ["Binary files", "No textual diff."],
    "pure rename": ["Pure renames", "Moved without content changes."],
  };
  const claimed = new Set((g.lowSignal ?? []).flatMap((l) => l.files));
  const autoGroups = new Map<string, LowSignalGroup>();
  for (const f of files) {
    if (!f.lowSignal || claimed.has(f.path)) continue;
    const [title, text] = AUTO_GROUPS[f.lowSignal];
    if (!autoGroups.has(title)) autoGroups.set(title, { title, text, files: [] });
    autoGroups.get(title)!.files.push(f.path);
  }
  const lowSignalGroups = [...(g.lowSignal ?? []), ...autoGroups.values()];
  const lowSignalFiles = new Set(lowSignalGroups.flatMap((l) => l.files));

  const ordered = new Set(g.readingOrder.flatMap((grp) => grp.files.map((r) => r.file)));
  const missing = files.filter((f) => !lowSignalFiles.has(f.path) && !ordered.has(f.path));
  if (missing.length) console.error(`warning: not in readingOrder or lowSignal: ${missing.map((f) => f.path).join(", ")}`);

  // Reading number per file, assigned in Reading Order sequence; also the file's anchor in the Files tab.
  const fileNum = new Map<string, number>();
  for (const grp of g.readingOrder) for (const r of grp.files) if (!fileNum.has(r.file)) fileNum.set(r.file, fileNum.size + 1);
  const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "group";
  const groupIds = new Map<string, number>();
  const groupId = (prefix: string, title: string) => {
    const base = `${prefix}-${slug(title)}`;
    const n = (groupIds.get(base) ?? 0) + 1;
    groupIds.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  };

  const counts = (f?: ChangedFile) =>
    f ? (f.added === null ? `<span class="muted">binary</span>` : `<span class="plus">+${f.added}</span> <span class="minus">−${f.deleted}</span>`) : "";
  const fileItem = (file: string, note?: string) => {
    const num = fileNum.get(file);
    const href = fileLink(file);
    const slash = file.lastIndexOf("/") + 1;
    const badges = g.hotspots
      .map((h, i) => (h.file === file ? ` <a class="hs-badge" href="#hotspot-${h.id}" title="${esc(h.title.replace(/`/g, ""))}">Hotspot ${i + 1}</a>` : ""))
      .join("");
    const f = fileByPath.get(file);
    const lines = (f?.added ?? 0) + (f?.deleted ?? 0);
    const checkbox = num ? `<input type="checkbox" class="read" aria-label="Mark as read">` : "";
    const foot = `<div class="file-foot"><button type="button" class="c-add-file">Comment on file</button>${num ? `<button type="button" class="mark-read">Mark as read</button>` : ""}</div>`;
    return `<li class="file"${num ? ` id="file-${num}"` : ""} data-path="${esc(file)}" data-lines="${lines}"><details><summary>${checkbox}${num ? `<span class="num">${num}.</span>` : ""}<code class="path"><span class="dir">${esc(file.slice(0, slash))}</span>${esc(file.slice(slash))}</code><button type="button" class="copy-path" title="Copy path">Copy</button> ${counts(fileByPath.get(file))}${badges}<span class="c-count"></span>${href ? ` <a class="ext" href="${esc(href)}">PR ↗</a>` : ""}${note ? `<div class="note">${inline(note)}</div>` : ""}</summary><div class="c-file"></div>${fileDiff(file)}${foot}</details></li>`;
  };

  const totalAdded = files.reduce((s, f) => s + (f.added ?? 0), 0);
  const totalDeleted = files.reduce((s, f) => s + (f.deleted ?? 0), 0);
  const commits = Number(git("rev-list", "--count", `${mergeBase}..${head}`).trim());
  const stats: [string, string][] = [
    [String(commits), commits === 1 ? "commit" : "commits"],
    [String(files.length), files.length === 1 ? "file" : "files"],
    [`<span class="plus">+${totalAdded}</span> / <span class="minus">−${totalDeleted}</span>`, "lines"],
    [String(files.filter((f) => f.status === "A").length), "new files"],
    [String(files.filter((f) => f.status === "D").length), "deleted files"],
  ];

  // Hidden on the page; each change map clones it behind its Legend button.
  const LEGEND = `<div class="legend" hidden>
  <div class="lg"><span><i class="sw new"></i>New</span><span><i class="sw changed"></i>Changed</span><span><i class="sw removed"></i>Removed</span><span><i class="sw context"></i>Unchanged, for context</span><span><i class="sw external"></i>External</span></div>
  <div class="lg">
    <span><svg width="26" height="16" viewBox="0 0 26 16"><rect x="1" y="2" width="24" height="12" rx="1"/></svg>Module / component</span>
    <span><svg width="26" height="16" viewBox="0 0 26 16"><rect x="1" y="2" width="24" height="12" rx="6"/></svg>Service</span>
    <span><svg width="26" height="16" viewBox="0 0 26 16"><rect x="1" y="2" width="24" height="12"/><line x1="4" y1="2" x2="4" y2="14"/><line x1="22" y1="2" x2="22" y2="14"/></svg>Entry point</span>
    <span><svg width="26" height="16" viewBox="0 0 26 16"><path d="M5 2h20l-4 12H1z"/></svg>Data / types / utils</span>
    <span><svg width="26" height="18" viewBox="0 0 26 18"><ellipse cx="13" cy="4" rx="10" ry="3"/><path d="M3 4v10c0 1.7 4.5 3 10 3s10-1.3 10-3V4"/></svg>Storage / endpoint</span>
  </div>
  <div class="lg">
    <span><svg width="34" height="10" viewBox="0 0 34 10"><line x1="1" y1="5" x2="27" y2="5" stroke-width="3"/><path d="M26 1l6 4-6 4"/></svg>Owns / renders</span>
    <span><svg width="34" height="10" viewBox="0 0 34 10"><line x1="1" y1="5" x2="27" y2="5"/><path d="M26 1l6 4-6 4"/></svg>Depends on / calls</span>
    <span><svg width="34" height="10" viewBox="0 0 34 10"><line x1="1" y1="5" x2="27" y2="5" stroke-dasharray="3 3"/><path d="M26 1l6 4-6 4"/></svg>Remote: HTTP, events</span>
  </div>
  <span class="muted">Click a node to jump to its Hotspot.</span>
</div>`;

  const hotspotList = g.hotspots.length
    ? `<ul class="rail" role="tablist" aria-orientation="vertical">${g.hotspots
        .map(
          (h, i) =>
            `<li><button type="button" role="tab" data-hotspot="${h.id}"><span class="rank">${i + 1}</span><span class="t">${inline(h.title)}</span><span class="m"><span class="cat cat-${h.category}">${h.category}</span><span class="f">${esc(basename(h.file))}:${h.line}${h.endLine ? `-${h.endLine}` : ""}</span></span></button></li>`,
        )
        .join("")}</ul>
<div class="pane hs-detail">${g.hotspots
        .map(
          (h) => `<article class="hotspot" id="hotspot-${h.id}">
  <header><span class="rank">${g.hotspots.indexOf(h) + 1}</span><h3>${inline(h.title)}</h3><span class="cat cat-${h.category}">${h.category}</span></header>
  <div class="loc">${loc(h)}${fileNum.has(h.file) ? ` · <a class="to-file" href="#file-${fileNum.get(h.file)}">open in Files</a>` : ""}</div>
  <div class="why">${prose(h.why)}</div>
  ${excerpt(h)}
  ${h.evidence?.length ? `<ul class="evidence">${h.evidence.map((e) => `<li>${loc(e)}${e.note ? ` ${inline(e.note)}` : ""}</li>`).join("")}</ul>` : ""}
</article>`,
        )
        .join("")}<div class="hs-nav"><button type="button" data-step="-1">← Previous</button><button type="button" data-step="1">Next hotspot →</button></div></div>`
    : `<p class="muted">Nothing stands out.</p>`;

  const readingGroups = g.readingOrder.map((grp) => ({ ...grp, id: groupId("group", grp.title) }));
  const lowGroups = lowSignalGroups.map((l) => ({ ...l, id: groupId("low", l.title) }));
  const railItem = (id: string, title: string, k: string, cls = "") =>
    `<li${cls ? ` class="${cls}"` : ""}><button type="button" role="tab" data-group="${id}"><span class="t">${title}</span><span class="k">${k}</span></button></li>`;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const groupRail = `<ul class="rail" role="tablist" aria-orientation="vertical"><li id="all-files"><button type="button" role="tab" data-group="all"><span class="t">All files</span><span class="k">${plural(fileNum.size, "file")}</span></button></li>${readingGroups
    .map((grp) => railItem(grp.id, inline(grp.title), `<span class="group-k"></span><span class="match-k"></span>`))
    .join("")}${lowGroups.map((l) => railItem(l.id, inline(l.title), `<span class="group-k">${plural(l.files.length, "file")} · low-signal</span><span class="match-k"></span>`, "low")).join("")}</ul>`;
  const readingTools = `<div class="reading-tools"><span class="view-toggle"><button data-view="list">List</button><button data-view="tree">Tree</button></span><button type="button" class="wrap-toggle" aria-pressed="false" title="Wrap long lines in diffs">Wrap</button><span class="progress"><span class="bar"><span></span></span><span class="pct"></span></span><span class="filter"><input type="search" placeholder="Filter files…" aria-label="Filter files"><span class="matches"></span></span><span class="bulk all"><button type="button" data-bulk="read">Mark all read</button><button type="button" data-bulk="open">Expand all</button></span><span class="c-tools"><span class="c-total"></span><button type="button" data-export="copy">Copy Markdown</button><button type="button" data-export="download">Download .md</button></span><span class="hint">Low-signal files count as read. Bulk actions apply to the files shown. Click or drag line numbers to comment; shift-click extends.</span></div>`;
  const groupBlocks = readingGroups
    .map(
      (grp) =>
        `<div class="group" id="${grp.id}"><h3>${inline(grp.title)} <span class="count group-progress"></span><span class="bulk"><button type="button" data-bulk="read">Mark read</button><button type="button" data-bulk="open">Expand</button></span></h3>${grp.note ? prose(grp.note) : ""}<ul class="files">${grp.files
          .map((r) => fileItem(r.file, r.note))
          .join("")}</ul><div class="tree" hidden></div></div>`,
    )
    .join("");
  const lowBlocks = lowGroups.length
    ? `<h2 id="low-signal" class="low-divider">Low-signal Files <span class="count">${lowSignalFiles.size}</span></h2>${lowGroups
        .map(
          (l) =>
            `<div class="group low" id="${l.id}"><h3>${inline(l.title)} <span class="count">${plural(l.files.length, "file")}</span><span class="bulk"><button type="button" data-bulk="open">Expand</button></span></h3>${l.text ? prose(l.text) : ""}<ul class="files">${l.files.map((f) => fileItem(f)).join("")}</ul><div class="tree" hidden></div></div>`,
        )
        .join("")}`
    : "";
  const groupNav = `<div class="group-nav"><button type="button" data-step="-1">← Previous group</button><button type="button" data-step="1">Next group →</button></div>`;
  const filesBody = `${groupRail}<div class="pane">${readingTools}${groupBlocks}${lowBlocks}${groupNav}</div>`;

  // A section without a title relies on the tab bar or its own toolbar as heading.
  const section = (id: string, body: string, title?: string) => `<section id="${id}"${/class="rail"/.test(body) ? ' class="split"' : ""}>${title ? `<h2>${title}</h2>` : ""}${body}</section>`;
  const readingFiles = g.readingOrder.reduce((n, grp) => n + grp.files.length, 0);
  interface Panel {
    id: string;
    label: string;
    count?: number;
    sections: string[];
  }
  const panels: Panel[] = [
    {
      id: "overview",
      label: "Overview",
      sections: [
        section("intent", `${g.intent.inferred ? `<p class="badge inferred">inferred: no description or linked issue</p>` : ""}${prose(g.intent.text)}`),
        section(
          "change-map",
          LEGEND +
            g.changeMaps
              .map(
                (m) =>
                  `<figure><figcaption><h3>${inline(m.title)}</h3>${m.description ? `<div class="lede">${prose(m.description)}</div>` : ""}</figcaption>${board(changeMapSource(m.mermaid), true)}${takeaways(m.takeaways)}</figure>`,
              )
              .join(""),
          "Change Map",
        ),
      ],
    },
    { id: "hotspots", label: "Hotspots", count: g.hotspots.length, sections: [section("hotspots", hotspotList)] },
    ...(g.behaviorDiagrams?.length
      ? [
          {
            id: "behavior",
            label: "Behavior",
            sections: [
              section(
                "behavior",
                g.behaviorDiagrams
                  .map(
                    (b) =>
                      `<figure><figcaption><h3>${inline(b.title)}</h3>${b.description ? `<div class="lede">${prose(b.description)}</div>` : ""}</figcaption>${b.before ? `<h4>Before</h4>${board(b.before)}<h4>After</h4>` : ""}${board(b.after)}</figure>`,
                  )
                  .join(""),
                "Behavior Diagrams",
              ),
            ],
          },
        ]
      : []),
    {
      id: "files",
      label: "Files",
      count: readingFiles,
      sections: [section("reading-order", filesBody)],
    },
  ];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<script>
window.__guideErrors = [];
addEventListener("error", (e) => __guideErrors.push(e.message || "failed to load " + (e.target?.src || e.target?.href)), true);
addEventListener("unhandledrejection", (e) => __guideErrors.push(String(e.reason?.message ?? e.reason)));
</script>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review Guide: ${esc(g.title)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11/styles/github.min.css" media="(prefers-color-scheme: light)">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11/styles/github-dark.min.css" media="(prefers-color-scheme: dark)">
<style>${CSS}</style>
</head>
<body data-range="${mergeBase}..${head}" data-title="${esc(g.title)}"${prUrl ? ` data-pr="${esc(prUrl)}"` : ""} data-total-lines="${files.reduce((s, f) => s + (f.added ?? 0) + (f.deleted ?? 0), 0)}" data-low-lines="${files
    .filter((f) => lowSignalFiles.has(f.path))
    .reduce((s, f) => s + (f.added ?? 0) + (f.deleted ?? 0), 0)}">
<header class="top">
  <p class="kicker">Review Guide</p>
  <h1>${inline(g.title)}</h1>
  <p class="meta">${prUrl ? `<a href="${esc(prUrl)}">${esc(prUrl)}</a> · ` : ""}<code>${mergeBase.slice(0, 8)}..${head.slice(0, 8)}</code> · generated ${new Date().toISOString().slice(0, 10)}</p>
  <div class="stats">${stats.map(([v, l]) => `<div><b>${v}</b><span class="l">${l}</span></div>`).join("")}</div>
  ${g.scope ? `<div class="scope">${prose(g.scope)}</div>` : ""}
</header>
<div class="tabs" role="tablist">${panels.map((p) => `<button type="button" role="tab" data-panel="${p.id}">${p.label}${p.count !== undefined ? `<span class="count">${p.count}</span>` : ""}</button>`).join("")}</div>
<main>
${panels.map((p) => `<div class="panel" data-panel="${p.id}" hidden>${p.sections.join("\n")}</div>`).join("\n")}
</main>
<script src="https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11/highlight.min.js"></script>
<script>
// Collapsed diffs are highlighted on first open.
const highlight = (root) => {
  if (!window.hljs) return;
  for (const el of root.querySelectorAll("td.code[data-lang]:not(.hl)")) {
    if (el.closest("details:not([open])")) continue;
    el.classList.add("hl");
    const language = el.dataset.lang;
    if (hljs.getLanguage(language)) el.innerHTML = hljs.highlight(el.textContent, { language, ignoreIllegals: true }).value;
  }
};
highlight(document);
document.addEventListener("toggle", (e) => e.target.open && highlight(e.target), true);

// Panels: one shown at a time. The URL hash names the view (a section or Hotspot id), so links and reloads land on the right panel.
const panels = [...document.querySelectorAll(".panel")];
const tabs = [...document.querySelectorAll(".tabs button")];
const hotspots = [...document.querySelectorAll(".hotspot")];
const hotspotButtons = [...document.querySelectorAll("#hotspots .rail button")];
const hotspotNav = document.querySelector(".hs-nav");
const showPanel = (key) => {
  for (const p of panels) p.hidden = p.dataset.panel !== key;
  for (const t of tabs) t.setAttribute("aria-selected", t.dataset.panel === key);
  for (const b of document.querySelectorAll(".panel:not([hidden]) .board")) b.refit?.();
};
const selectHotspot = (id) => {
  const i = Math.max(0, hotspots.findIndex((h) => h.id === id));
  hotspots.forEach((h, j) => h.classList.toggle("on", i === j));
  hotspotButtons.forEach((b, j) => b.setAttribute("aria-selected", i === j));
  if (hotspotNav) {
    hotspotNav.children[0].disabled = i === 0;
    hotspotNav.children[1].disabled = i === hotspots.length - 1;
  }
};
const setHash = (id) => history.replaceState(null, "", "#" + id);
const route = () => {
  const id = location.hash.slice(1);
  const target = id ? document.getElementById(id) : null;
  showPanel(target?.closest(".panel")?.dataset.panel ?? panels[0].dataset.panel);
  if (id.startsWith("hotspot-")) {
    selectHotspot(id);
    document.getElementById("hotspots").scrollIntoView();
  } else if (target?.closest("#reading-order")) {
    // A group focuses itself; a file focuses its group and opens; "all-files" is the All view; the bare section keeps the current focus.
    const group = target.closest(".group");
    if (group) focusGroup(group.id);
    else if (target !== section) focusGroup("all");
    if (target.matches("li.file")) target.querySelector("details").open = true;
    target.scrollIntoView();
  } else if (target) target.scrollIntoView();
};
// Scroll up to the panel top when switching tabs, never down.
const mainTop = () => document.querySelector("main").offsetTop - document.querySelector(".tabs").offsetHeight;
for (const t of tabs)
  t.addEventListener("click", () => {
    const panel = panels.find((p) => p.dataset.panel === t.dataset.panel);
    setHash(t.dataset.panel === "files" ? filesHash() : panel.querySelector("section").id);
    showPanel(t.dataset.panel);
    scrollTo(0, Math.min(scrollY, mainTop()));
  });
for (const b of hotspotButtons)
  b.addEventListener("click", () => {
    setHash("hotspot-" + b.dataset.hotspot);
    selectHotspot("hotspot-" + b.dataset.hotspot);
  });
hotspotNav?.addEventListener("click", (e) => {
  const step = Number(e.target.closest("button[data-step]")?.dataset.step);
  if (!step) return;
  const next = hotspots[hotspots.findIndex((h) => h.classList.contains("on")) + step];
  if (!next) return;
  setHash(next.id);
  selectHotspot(next.id);
  document.getElementById("hotspots").scrollIntoView();
});
addEventListener("hashchange", route);
if (hotspots.length) selectHotspot(hotspots[0].id);

// Tree view regroups each group's files by directory, keeping first-appearance order.
const groups = [...document.querySelectorAll(".group")].map((g) => ({
  el: g,
  low: g.classList.contains("low"),
  list: g.querySelector("ul.files"),
  tree: g.querySelector("div.tree"),
  items: [...g.querySelectorAll("ul.files > li")],
}));
const buildTree = (items) => {
  const root = { dirs: new Map(), entries: [] };
  for (const li of items) {
    let node = root;
    for (const name of li.dataset.path.split("/").slice(0, -1)) {
      if (!node.dirs.has(name)) {
        const child = { name, dirs: new Map(), entries: [] };
        node.dirs.set(name, child);
        node.entries.push(child);
      }
      node = node.dirs.get(name);
    }
    node.entries.push(li);
  }
  return root;
};
const renderTree = (node) => {
  const ul = document.createElement("ul");
  for (const entry of node.entries) {
    if (entry instanceof Element) {
      ul.append(entry);
      continue;
    }
    let dir = entry;
    let name = dir.name;
    while (dir.entries.length === 1 && !(dir.entries[0] instanceof Element)) {
      dir = dir.entries[0];
      name += "/" + dir.name;
    }
    const li = document.createElement("li");
    li.className = "dir";
    const details = document.createElement("details");
    details.open = true;
    const summary = document.createElement("summary");
    summary.innerHTML = '<span class="dirname"></span><span class="bulk"><button type="button" data-bulk="read">Mark read</button><button type="button" data-bulk="open">Expand</button></span>';
    summary.firstChild.textContent = name + "/";
    details.append(summary, renderTree(dir));
    li.append(details);
    ul.append(li);
  }
  return ul;
};
const setView = (view) => {
  for (const g of groups) {
    if (view === "tree") g.tree.replaceChildren(renderTree(buildTree(g.items)));
    else {
      g.list.append(...g.items);
      g.tree.replaceChildren();
    }
    g.list.hidden = view === "tree";
    g.tree.hidden = view !== "tree";
  }
  for (const b of document.querySelectorAll(".view-toggle button")) b.setAttribute("aria-pressed", b.dataset.view === view);
  document.getElementById("reading-order").classList.toggle("tree-view", view === "tree");
  try { localStorage.setItem("review-guide-view", view); } catch {}
};
for (const b of document.querySelectorAll(".view-toggle button")) b.addEventListener("click", () => setView(b.dataset.view));
let saved = null;
try { saved = localStorage.getItem("review-guide-view"); } catch {}
setView(saved === "tree" ? "tree" : "list");

// Long diff lines scroll by default; Wrap folds them instead. Applies to every diff on the page.
const wrapButton = document.querySelector(".wrap-toggle");
const setWrap = (on) => {
  document.body.classList.toggle("wrap", on);
  wrapButton.setAttribute("aria-pressed", on);
  try { localStorage.setItem("review-guide-wrap", on ? "1" : "0"); } catch {}
};
wrapButton.addEventListener("click", () => setWrap(!document.body.classList.contains("wrap")));
let savedWrap = null;
try { savedWrap = localStorage.getItem("review-guide-wrap"); } catch {}
setWrap(savedWrap === "1");

// Review progress: lines in ticked files plus low-signal files, over all changed lines. Saved per commit range.
const readKey = "review-guide:read:" + document.body.dataset.range;
let readPaths = [];
try { readPaths = JSON.parse(localStorage.getItem(readKey) || "[]"); } catch {}
const totalLines = Number(document.body.dataset.totalLines);
const lowLines = Number(document.body.dataset.lowLines);
const readItems = [...document.querySelectorAll(".group:not(.low) li.file")];
const updateProgress = () => {
  let read = lowLines;
  for (const li of readItems) {
    const done = li.querySelector("input.read").checked;
    li.classList.toggle("is-read", done);
    if (done) read += Number(li.dataset.lines);
  }
  const pct = totalLines ? Math.floor((read / totalLines) * 100) : 100;
  const left = totalLines - read;
  document.querySelector(".progress .bar > span").style.width = pct + "%";
  document.querySelector(".progress .pct").textContent = pct + "% reviewed · " + left.toLocaleString() + (left === 1 ? " line" : " lines") + " left";
  for (const g of groups) {
    if (g.low) continue;
    const done = g.items.filter(isRead).length;
    g.el.querySelector(".group-progress").textContent = done + "/" + g.items.length;
    railButton(g.el.id).querySelector(".group-k").textContent = done + "/" + g.items.length;
  }
  try { localStorage.setItem(readKey, JSON.stringify(readItems.filter((li) => li.classList.contains("is-read")).map((li) => li.dataset.path))); } catch {}
  refreshBulk();
};

// Filter and bulk actions. Bulk buttons act on the visible files in their scope: a folder, a group, or the whole section.
const section = document.getElementById("reading-order");
const filterInput = section.querySelector(".filter input");
const shown = (scope) => [...scope.querySelectorAll("li.file")].filter((li) => !li.hidden && !li.closest(".group").hidden);
// Low-signal files have no checkbox and always count as read.
const isRead = (li) => li.querySelector("input.read")?.checked ?? true;
const setRead = (li, on) => { const box = li.querySelector("input.read"); if (box) box.checked = on; };
const isOpen = (li) => li.querySelector(":scope > details").open;
// Group focus: the rail shows all groups or one. A filter always searches every group, so it switches to All.
const rail = section.querySelector(".rail");
const railButton = (id) => rail.querySelector('button[data-group="' + id + '"]');
const groupIds = [...rail.querySelectorAll("button")].map((b) => b.dataset.group).filter((id) => id !== "all");
const groupNav = section.querySelector(".group-nav");
const lowDivider = document.getElementById("low-signal");
let focus = "all";
const filesHash = () => (focus === "all" ? "all-files" : focus);
const allItems = groups.flatMap((g) => g.items);
const applyFilter = () => {
  const terms = filterInput.value.toLowerCase().split(" ").filter(Boolean);
  if (terms.length && focus !== "all") {
    focusGroup("all", false);
    setHash(filesHash());
  }
  for (const li of allItems) li.hidden = !terms.every((t) => li.dataset.path.toLowerCase().includes(t));
  for (const g of groups) {
    const matches = g.items.filter((li) => !li.hidden).length;
    g.el.hidden = focus === "all" ? !matches : g.el.id !== focus;
    const button = railButton(g.el.id);
    button.querySelector(".match-k").textContent = terms.length ? matches + " match" + (matches === 1 ? "" : "es") : "";
    button.querySelector(".group-k").hidden = terms.length > 0;
  }
  // After group visibility, since a folder counts as empty while its group is hidden.
  for (const dir of section.querySelectorAll("li.dir")) dir.hidden = !shown(dir).length;
  if (lowDivider) lowDivider.hidden = focus !== "all" || !groups.some((g) => g.low && !g.el.hidden);
  groupNav.hidden = focus === "all";
  if (focus !== "all") {
    const i = groupIds.indexOf(focus);
    groupNav.children[0].disabled = i <= 0;
    groupNav.children[1].disabled = i >= groupIds.length - 1;
  }
  const count = allItems.filter((li) => !li.hidden).length;
  section.querySelector(".matches").textContent = terms.length ? count + " of " + allItems.length + " files" : "";
  refreshBulk();
  if (!terms.length) updateProgress();
};
const focusGroup = (id, relayout = true) => {
  focus = railButton(id) ? id : "all";
  for (const b of rail.querySelectorAll("button")) b.setAttribute("aria-selected", b.dataset.group === focus);
  if (relayout) applyFilter();
};
rail.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-group]");
  if (!b) return;
  focusGroup(b.dataset.group);
  setHash(filesHash());
  scrollTo(0, Math.min(scrollY, section.offsetTop - document.querySelector(".tabs").offsetHeight));
});
groupNav.addEventListener("click", (e) => {
  const step = Number(e.target.closest("button[data-step]")?.dataset.step);
  const next = step && groupIds[groupIds.indexOf(focus) + step];
  if (!next) return;
  focusGroup(next);
  setHash(next);
  section.scrollIntoView();
});
const refreshBulk = () => {
  for (const bulk of section.querySelectorAll(".bulk")) {
    const all = bulk.classList.contains("all");
    const items = shown(all ? section : bulk.closest("li.dir") ?? bulk.closest(".group"));
    const read = items.length && items.every(isRead);
    const open = items.length && items.every(isOpen);
    const readButton = bulk.querySelector('[data-bulk="read"]');
    if (readButton) readButton.textContent = (read ? "Mark " + (all ? "all " : "") + "unread" : "Mark " + (all ? "all " : "") + "read");
    bulk.querySelector('[data-bulk="open"]').textContent = (open ? "Collapse" : "Expand") + (all ? " all" : "");
    for (const b of bulk.querySelectorAll("button")) b.disabled = !items.length;
  }
};
section.addEventListener("click", (e) => {
  const button = e.target.closest("button[data-bulk]");
  if (!button) return;
  e.preventDefault();
  const bulk = button.closest(".bulk");
  const scope = bulk.classList.contains("all") ? section : bulk.closest("li.dir") ?? bulk.closest(".group");
  const items = shown(scope);
  if (button.dataset.bulk === "read") {
    const on = !items.every(isRead);
    for (const li of items) setRead(li, on);
    updateProgress();
    // Finishing the focused group moves on to the next one.
    const next = on && focus !== "all" && scope === groups.find((g) => g.el.id === focus)?.el && groupIds[groupIds.indexOf(focus) + 1];
    if (next) {
      focusGroup(next);
      setHash(next);
      section.scrollIntoView();
    }
  } else {
    const on = !items.every(isOpen);
    if (on) for (const d of scope.querySelectorAll("li.dir > details")) d.open = true;
    for (const li of items) li.querySelector(":scope > details").open = on;
  }
  refreshBulk();
});
let refreshQueued = false;
section.addEventListener("toggle", () => {
  if (refreshQueued) return;
  refreshQueued = true;
  requestAnimationFrame(() => { refreshQueued = false; refreshBulk(); });
}, true);
filterInput.addEventListener("input", applyFilter);
filterInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { filterInput.value = ""; applyFilter(); }
});
for (const b of document.querySelectorAll(".view-toggle button")) b.addEventListener("click", applyFilter);
document.getElementById("reading-order").addEventListener("change", (e) => e.target.matches("input.read") && updateProgress());
document.getElementById("reading-order").addEventListener("click", (e) => {
  const button = e.target.closest("button.mark-read");
  if (!button) return;
  const li = button.closest("li.file");
  li.querySelector("input.read").checked = true;
  li.querySelector("details").open = false;
  updateProgress();
  const summary = li.querySelector("summary");
  if (summary.getBoundingClientRect().top < 0) summary.scrollIntoView({ block: "center" });
});
for (const li of readItems) li.querySelector("input.read").checked = readPaths.includes(li.dataset.path);
// An open file's header sticks below the toolbar, whose height changes as it wraps.
const tools = section.querySelector(".reading-tools");
new ResizeObserver(() => section.style.setProperty("--tools-bottom", parseFloat(getComputedStyle(tools).top) + tools.getBoundingClientRect().height + "px")).observe(tools);
section.addEventListener("click", async (e) => {
  const copy = e.target.closest("button.copy-path");
  if (copy) {
    e.preventDefault();
    copy.textContent = (await copyText(copy.closest("li.file").dataset.path)) ? "Copied" : "Copy failed";
    setTimeout(() => (copy.textContent = "Copy"), 1500);
    return;
  }
  // Collapsing from a stuck header would leave the view deep below the file; bring its header back.
  const summary = e.target.closest("li.file > details[open] > summary");
  if (!summary || e.target.closest("a, input, button")) return;
  if (summary.getBoundingClientRect().top <= tools.getBoundingClientRect().bottom) requestAnimationFrame(() => summary.closest("li.file").scrollIntoView());
});
// Small changes open on All; larger ones open on the first group with unread files. A hash naming a group or file wins.
const FOCUS_THRESHOLD = 12;
const firstUnread = groups.find((g) => !g.low && !g.items.every(isRead)) ?? groups.find((g) => !g.low);
focusGroup(readItems.length > FOCUS_THRESHOLD && firstUnread ? firstUnread.el.id : "all");
route();

// Comments: drag or shift-click line numbers in a file diff to comment on a line range, or comment on the whole file.
// Rows are keyed by side and line ("n42" new, "o10" old). Saved per commit range, exported as Markdown.
const commentKey = "review-guide:comments:" + document.body.dataset.range;
let comments = [];
try { comments = JSON.parse(localStorage.getItem(commentKey) || "[]"); } catch {}
const fileItems = [...document.querySelectorAll("li.file")];
const keyedRows = (table) => [...table.rows].filter((tr) => tr.dataset.k);
const rowsBetween = (table, a, b) => {
  const rows = keyedRows(table);
  const [i, j] = [rows.indexOf(a), rows.indexOf(b)].sort((x, y) => x - y);
  return rows.slice(i, j + 1);
};
const commentRows = (li, c) => {
  const table = li.querySelector("table.diff");
  const start = c.start && table?.querySelector('tr[data-k="' + c.start + '"]');
  const end = c.end && table?.querySelector('tr[data-k="' + c.end + '"]');
  return start && end ? rowsBetween(table, start, end) : [];
};
const lineLabel = (k) => k.slice(1) + (k[0] === "o" ? " (before)" : "");
const commentLabel = (c) => {
  if (!c.start) return "File";
  if (c.start === c.end) return "Line " + lineLabel(c.start);
  if (c.start[0] === c.end[0]) return "Lines " + c.start.slice(1) + "-" + lineLabel(c.end);
  return "Lines " + lineLabel(c.start) + " to " + lineLabel(c.end);
};

let sel = null; // { table, anchor, focus }: the line range being picked
let draft = null; // { el, textarea }: the one unsaved new comment
let dragging = false;
const paintSel = () => {
  for (const tr of document.querySelectorAll("tr.c-sel")) tr.classList.remove("c-sel");
  if (sel) for (const tr of rowsBetween(sel.table, sel.anchor, sel.focus)) tr.classList.add("c-sel");
};
const closeDraft = () => {
  draft?.el.remove();
  draft = null;
  sel = null;
  paintSel();
};
// A draft with text is never discarded implicitly: focus it instead.
const keepDraft = () => {
  if (!draft?.textarea.value.trim()) return false;
  draft.textarea.focus();
  return true;
};

const commentForm = (label, body, onSave, onCancel) => {
  const form = document.createElement("form");
  form.className = "c-form";
  form.innerHTML = '<div class="c-label"></div><textarea rows="4" placeholder="Markdown. ⌘/Ctrl+Enter saves, Esc cancels."></textarea><div class="c-actions"><button type="button" data-c="cancel">Cancel</button><button type="submit" class="primary">Save</button></div>';
  form.querySelector(".c-label").textContent = label;
  const textarea = form.querySelector("textarea");
  textarea.value = body;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (textarea.value.trim()) onSave(textarea.value.replace(/\\s+$/, ""));
  });
  form.querySelector('[data-c="cancel"]').addEventListener("click", onCancel);
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); form.requestSubmit(); }
    else if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
  });
  return form;
};
const commentRow = (child) => {
  const tr = document.createElement("tr");
  tr.className = "c-row";
  const td = tr.insertCell();
  td.colSpan = 4;
  td.append(child);
  return tr;
};
// Below the range's last line, after comments already anchored there.
const placeAfter = (tr, el) => {
  let at = tr;
  while (at.nextElementSibling?.classList.contains("c-row") && at.nextElementSibling !== el) at = at.nextElementSibling;
  at.after(el);
};

const commentView = (c, rows) => {
  const el = document.createElement("div");
  el.className = "c-comment";
  const show = () => {
    el.innerHTML = '<div class="c-head"><span class="c-label"></span><button type="button" data-c="edit">Edit</button><button type="button" data-c="delete">Delete</button></div><div class="c-body"></div>';
    el.querySelector(".c-label").textContent = commentLabel(c) + (c.start && !rows.length ? " (no longer in diff)" : "");
    el.querySelector(".c-body").textContent = c.body;
    el.querySelector('[data-c="edit"]').addEventListener("click", () => {
      const form = commentForm(commentLabel(c), c.body, (body) => { c.body = body; saveComments(c.path); }, show);
      el.replaceChildren(form);
      form.querySelector("textarea").focus();
    });
    el.querySelector('[data-c="delete"]').addEventListener("click", () => {
      if (!confirm("Delete this comment?")) return;
      comments = comments.filter((x) => x !== c);
      saveComments(c.path);
    });
  };
  show();
  el.addEventListener("pointerenter", () => rows.forEach((tr) => tr.classList.add("c-hl")));
  el.addEventListener("pointerleave", () => rows.forEach((tr) => tr.classList.remove("c-hl")));
  return el;
};
const renderComments = (li) => {
  for (const el of li.querySelectorAll(".c-comment")) (el.closest("tr.c-row") ?? el).remove();
  for (const tr of li.querySelectorAll("tr.c-hl")) tr.classList.remove("c-hl");
  const mine = comments.filter((c) => c.path === li.dataset.path);
  for (const c of mine) {
    const rows = commentRows(li, c);
    const view = commentView(c, rows);
    if (rows.length) placeAfter(rows.at(-1), commentRow(view));
    else li.querySelector(".c-file").append(view);
  }
  li.querySelector(".c-count").textContent = mine.length ? mine.length + (mine.length === 1 ? " comment" : " comments") : "";
};
const commentTools = document.querySelector(".c-tools");
const refreshCommentTools = () => {
  commentTools.querySelector(".c-total").textContent = comments.length + (comments.length === 1 ? " comment" : " comments");
  for (const b of commentTools.querySelectorAll("button")) b.disabled = !comments.length;
};
const saveComments = (path) => {
  try { localStorage.setItem(commentKey, JSON.stringify(comments)); } catch {}
  for (const li of fileItems) if (li.dataset.path === path) renderComments(li);
  refreshCommentTools();
};
const addComment = (c) => {
  comments.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ...c });
  saveComments(c.path);
};

const openLineDraft = () => {
  const { table } = sel;
  const li = table.closest("li.file");
  if (!draft) {
    const form = commentForm("", "", (body) => {
      const rows = rowsBetween(table, sel.anchor, sel.focus);
      closeDraft();
      addComment({ path: li.dataset.path, start: rows[0].dataset.k, end: rows.at(-1).dataset.k, body });
    }, closeDraft);
    draft = { el: commentRow(form), textarea: form.querySelector("textarea") };
  }
  const rows = rowsBetween(table, sel.anchor, sel.focus);
  draft.el.querySelector(".c-label").textContent = commentLabel({ start: rows[0].dataset.k, end: rows.at(-1).dataset.k });
  placeAfter(rows.at(-1), draft.el);
  draft.textarea.focus();
};
document.addEventListener("pointerdown", (e) => {
  const cell = e.button === 0 && e.target.closest?.("li.file table.diff tr[data-k] > td:is(.ln, .sign)");
  if (!cell) return;
  e.preventDefault();
  const tr = cell.parentElement;
  const table = tr.closest("table");
  if (e.shiftKey && sel?.table === table) sel.focus = tr;
  else {
    if (keepDraft()) return;
    closeDraft();
    sel = { table, anchor: tr, focus: tr };
  }
  dragging = true;
  paintSel();
});
document.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const tr = document.elementFromPoint(e.clientX, e.clientY)?.closest("tr[data-k]");
  if (tr && tr.closest("table") === sel.table && tr !== sel.focus) {
    sel.focus = tr;
    paintSel();
  }
});
document.addEventListener("pointerup", () => {
  if (!dragging) return;
  dragging = false;
  openLineDraft();
});
document.addEventListener("click", (e) => {
  const button = e.target.closest("button.c-add-file");
  if (!button || keepDraft()) return;
  closeDraft();
  const li = button.closest("li.file");
  const form = commentForm("File", "", (body) => { closeDraft(); addComment({ path: li.dataset.path, body }); }, closeDraft);
  draft = { el: form, textarea: form.querySelector("textarea") };
  li.querySelector(".c-file").append(form);
  draft.textarea.focus();
});

const toMarkdown = () => {
  const { title, pr, range } = document.body.dataset;
  const tick = String.fromCharCode(96);
  const out = ["# Review comments: " + title, ""];
  if (pr) out.push(pr, "");
  out.push("Range: " + tick + range + tick, "");
  const seen = new Set();
  for (const li of fileItems) {
    const path = li.dataset.path;
    if (seen.has(path)) continue;
    seen.add(path);
    const table = li.querySelector("table.diff");
    const order = table ? keyedRows(table) : [];
    const mine = comments
      .filter((c) => c.path === path)
      .map((c) => ({ c, rows: commentRows(li, c) }))
      .sort((a, b) => (a.rows.length ? order.indexOf(a.rows[0]) : -1) - (b.rows.length ? order.indexOf(b.rows[0]) : -1));
    if (!mine.length) continue;
    out.push("## " + tick + path + tick, "");
    for (const { c, rows } of mine) {
      out.push("**" + commentLabel(c) + "**", "");
      if (rows.length) {
        const code = rows.map((tr) => (tr.classList.contains("add") ? "+" : tr.classList.contains("del") ? "-" : " ") + tr.cells[3].textContent).join("\\n");
        const fence = tick.repeat(Math.max(3, ...(code.match(/\`+/g) ?? []).map((m) => m.length + 1)));
        out.push(fence + "diff", code, fence, "");
      }
      out.push(c.body, "");
    }
  }
  return out.join("\\n");
};
// The Clipboard API needs a secure context; a guide opened from file:// may fall back to execCommand.
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}
commentTools.addEventListener("click", async (e) => {
  const button = e.target.closest("button[data-export]");
  if (!button) return;
  const md = toMarkdown();
  if (button.dataset.export === "download") {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
    a.download = "review-comments-" + (document.body.dataset.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "guide") + ".md";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return;
  }
  button.textContent = (await copyText(md)) ? "Copied" : "Copy failed";
  setTimeout(() => (button.textContent = "Copy Markdown"), 1500);
});
for (const li of fileItems) renderComments(li);
refreshCommentTools();
</script>
<script type="module">
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
// Diagrams always sit on a light board, so one light palette serves both page themes.
const natural = { useMaxWidth: false };
mermaid.initialize({
  startOnLoad: false,
  securityLevel: "loose",
  theme: "base",
  flowchart: { ...natural, curve: "basis", nodeSpacing: 28, rankSpacing: 50 },
  sequence: natural,
  state: natural,
  class: natural,
  er: natural,
  themeVariables: {
    fontFamily: "ui-sans-serif, system-ui, sans-serif", fontSize: "14px", lineColor: "#6b7688",
    primaryColor: "#eef1f5", primaryBorderColor: "#8a94a6", primaryTextColor: "#18202c", textColor: "#18202c",
    edgeLabelBackground: "#ffffff", titleColor: "#18202c", clusterBkg: "#f3f5f8", clusterBorder: "#c3cad6",
    actorBkg: "#fdf0d2", actorBorder: "#b07d0c", noteBkgColor: "#e0eafb", noteBorderColor: "#2a5db0",
    signalColor: "#18202c", signalTextColor: "#18202c", labelBoxBkgColor: "#eef1f5", labelBoxBorderColor: "#8a94a6",
  },
});
const esc = (s) => s.replace(/[&<>]/g, (c) => "&#" + c.charCodeAt(0) + ";");
const legend = document.querySelector(".legend");
const MIN = 0.2, MAX = 4, STEP = 1.25;

const setupBoard = (board, svg) => {
  const vp = board.querySelector(".viewport");
  const label = board.querySelector(".zl");
  const expandBtn = board.querySelector('[data-act="expand"]');
  const legendBtn = board.querySelector('[data-act="legend"]');
  const vb = svg.viewBox.baseVal;
  const w = vb?.width || svg.getBBox().width;
  const h = vb?.height || svg.getBBox().height;
  svg.removeAttribute("style");
  let zoom = 1;
  if (board.hasAttribute("data-legend") && legend) {
    const mini = legend.cloneNode(true);
    mini.className = "mini-legend";
    mini.hidden = false;
    mini.setAttribute("aria-hidden", "true");
    board.querySelector(".tools").after(mini);
  }
  const apply = (z, ax, ay) => {
    z = Math.min(MAX, Math.max(MIN, z));
    const r = vp.getBoundingClientRect();
    ax ??= r.width / 2;
    ay ??= r.height / 2;
    const fx = (vp.scrollLeft + ax) / zoom;
    const fy = (vp.scrollTop + ay) / zoom;
    zoom = z;
    svg.setAttribute("width", Math.round(w * z));
    svg.setAttribute("height", Math.round(h * z));
    vp.scrollLeft = fx * z - ax;
    vp.scrollTop = fy * z - ay;
    label.textContent = Math.round(z * 100) + "%";
  };
  const fit = () => {
    const zw = (vp.clientWidth - 32) / w;
    const zh = board.classList.contains("expanded") ? (vp.clientHeight - 32) / h : Infinity;
    apply(Math.min(zw, zh, 2));
    vp.scrollLeft = 0;
    vp.scrollTop = 0;
  };
  // Wide diagrams open fitted to the width, but never shrunk past legibility. A board inside a hidden panel has no width yet; the panel refits it when shown.
  const initial = () => {
    if (!vp.clientWidth) return;
    apply(Math.max(0.5, Math.min(1, (vp.clientWidth - 32) / w)));
    vp.scrollLeft = 0;
    vp.scrollTop = 0;
  };
  const showLegend = (on) => {
    board.classList.toggle("show-legend", on);
    legendBtn?.setAttribute("aria-pressed", on);
  };
  const toggle = (on = !board.classList.contains("expanded")) => {
    board.classList.toggle("expanded", on);
    document.body.classList.toggle("locked", on);
    expandBtn.textContent = on ? "Close" : "Expand";
    showLegend(on);
    if (on) {
      requestAnimationFrame(fit);
      expandBtn.focus();
    } else {
      initial();
      board.scrollIntoView({ block: "start" });
    }
  };
  board.closeExpanded = () => toggle(false);
  board.refit = initial;
  board.querySelector(".tools").addEventListener("click", (e) => {
    const act = e.target.closest("button")?.dataset.act;
    if (act === "in") apply(zoom * STEP);
    else if (act === "out") apply(zoom / STEP);
    else if (act === "actual") apply(1);
    else if (act === "fit") fit();
    else if (act === "expand") toggle();
    else if (act === "legend") showLegend(!board.classList.contains("show-legend"));
  });
  vp.addEventListener("wheel", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const r = vp.getBoundingClientRect();
    apply(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  // Dragging starts past a small threshold so clicks on nodes (Hotspot links) still go through.
  let drag = null;
  vp.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.pointerType === "touch") return;
    drag = { x: e.clientX, y: e.clientY, l: vp.scrollLeft, t: vp.scrollTop, id: e.pointerId, moved: false };
  });
  vp.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      vp.setPointerCapture(drag.id);
      vp.classList.add("dragging");
    }
    vp.scrollLeft = drag.l - dx;
    vp.scrollTop = drag.t - dy;
  });
  const swallow = (e) => { e.preventDefault(); e.stopPropagation(); };
  const end = () => {
    if (drag?.moved) {
      vp.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => vp.removeEventListener("click", swallow, { capture: true }));
    }
    drag = null;
    vp.classList.remove("dragging");
  };
  vp.addEventListener("pointerup", end);
  vp.addEventListener("pointercancel", end);
  vp.addEventListener("click", (e) => {
    if (e.target.closest("a") && board.classList.contains("expanded")) toggle(false);
  });
  initial();
};
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") document.querySelector(".board.expanded")?.closeExpanded();
});

let i = 0;
for (const el of document.querySelectorAll("pre.diagram")) {
  const id = "mmd" + i++;
  const board = el.closest(".board");
  try {
    const { svg, bindFunctions } = await mermaid.render(id, el.textContent);
    el.outerHTML = svg;
    const node = board.querySelector(".viewport svg");
    bindFunctions?.(node);
    setupBoard(board, node);
  } catch (e) {
    document.getElementById("d" + id)?.remove();
    el.classList.add("broken");
    board.classList.add("failed");
    el.insertAdjacentHTML("beforebegin", '<p class="error">Diagram failed to render: ' + esc(String(e?.message ?? e)) + "</p>");
  }
}
document.documentElement.dataset.diagrams = "done";
</script>
</body>
</html>
`;
}

const CSS = `
:root {
  --bg: #fafaf9; --fg: #1c1917; --muted: #78716c; --card: #fff; --border: #e7e5e4; --accent: #b45309;
  --add: #dcfce7; --del: #fee2e2; --plus: #15803d; --minus: #b91c1c; --code: #f5f5f4;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0c0a09; --fg: #e7e5e4; --muted: #a8a29e; --card: #1c1917; --border: #292524; --accent: #f59e0b;
    --add: #14532d66; --del: #7f1d1d66; --plus: #4ade80; --minus: #f87171; --code: #292524;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.55 ui-sans-serif, system-ui, sans-serif; }
a { color: var(--accent); }
code { font: 0.9em ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--code); padding: 0.1em 0.35em; border-radius: 4px; }
a code { background: none; padding: 0; }
.top { padding: 2rem 2rem 0.5rem; }
.kicker { margin: 0; text-transform: uppercase; letter-spacing: 0.12em; font-size: 0.75rem; color: var(--accent); font-weight: 600; }
h1 { margin: 0.25rem 0; font-size: 1.6rem; line-height: 1.25; }
.meta { color: var(--muted); margin: 0.25rem 0 1rem; font-size: 0.9rem; }
.tabs { position: sticky; top: 0; z-index: 10; display: flex; gap: 0.25rem; padding: 0 1rem; background: var(--bg); border-bottom: 1px solid var(--border); }
.tabs button { font: 500 0.92rem/1 ui-sans-serif, system-ui, sans-serif; padding: 0.75rem 1rem; color: var(--muted); background: none; border: 0; border-bottom: 2px solid transparent; margin-bottom: -1px; cursor: pointer; }
.tabs button .count { margin-left: 0.35rem; font-size: 0.78rem; }
.tabs button:hover { color: var(--fg); }
.tabs button[aria-selected="true"] { color: var(--fg); border-bottom-color: var(--accent); }
main { padding: 0 2rem 4rem; }
.panel:not(:has(> section.split)) { max-width: 1100px; }
section { padding-top: 1.5rem; scroll-margin-top: 3.5rem; }
h2 { margin: 0 0 0.75rem; font-size: 1rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
#intent { font-size: 1.05rem; }
#intent p { max-width: 75ch; }
.count { color: var(--muted); font-weight: 400; font-size: 0.9rem; }
.muted { color: var(--muted); }
.plus { color: var(--plus); font-family: ui-monospace, monospace; font-size: 0.85em; }
.minus { color: var(--minus); font-family: ui-monospace, monospace; font-size: 0.85em; }
.badge { display: inline-block; font-size: 0.8rem; padding: 0.1rem 0.5rem; border-radius: 999px; border: 1px solid var(--accent); color: var(--accent); margin: 0; }
section.split { display: grid; grid-template-columns: minmax(0, 300px) minmax(0, 1fr); gap: 2.5rem; align-items: start; }
.rail { position: sticky; top: 3.5rem; display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; max-height: calc(100vh - 4rem); overflow: auto; }
.rail button { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0.15rem 0.6rem; width: 100%; min-width: 0; padding: 0.65rem 0.8rem; font: inherit; font-size: 0.9rem; line-height: 1.35; text-align: left; color: var(--fg); background: none; border: 0; border-radius: 8px; cursor: pointer; overflow-wrap: anywhere; }
#hotspots .rail button { grid-template-columns: 1.4rem minmax(0, 1fr); }
.rail button:hover { background: var(--code); }
.rail button[aria-selected="true"] { background: var(--card); box-shadow: inset 0 0 0 1px var(--border), inset 3px 0 0 var(--accent); }
.rail .t { font-weight: 500; }
.rail .t code { font-size: 0.85em; }
.rail .k { font-size: 0.72rem; color: var(--muted); font-variant-numeric: tabular-nums; }
.rail .m { grid-column: 2; display: flex; gap: 0.5rem; align-items: center; min-width: 0; font-size: 0.72rem; color: var(--muted); }
.rail .m .cat { font-size: 0.68rem; }
.rail .m .f { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rail li.low { opacity: 0.7; }
.rail li.low:first-of-type { margin-top: 0.75rem; }
.pane { min-width: 0; padding-left: 2.5rem; border-left: 1px solid var(--border); }
.to-file { font-size: 0.85rem; }
.hotspot { display: none; scroll-margin-top: 4rem; }
.hotspot.on { display: block; }
.hotspot header { display: flex; gap: 0.75rem; align-items: baseline; }
.hotspot h3 { margin: 0; font-size: 1.3rem; flex: 1; }
.rank { color: var(--accent); font-weight: 700; font-variant-numeric: tabular-nums; }
.cat { font-size: 0.75rem; padding: 0.1rem 0.5rem; border-radius: 999px; background: var(--code); color: var(--muted); white-space: nowrap; }
.cat-security, .cat-intent-mismatch, .cat-data-migration { color: var(--minus); }
.loc { margin: 0.6rem 0 1rem; font-size: 0.9rem; }
.why { font-size: 1.02rem; max-width: 72ch; }
.why p { margin: 0.5rem 0; }
.hotspot .diff { margin: 1.25rem 0; max-height: 50vh; overflow: auto; }
.hs-nav { display: flex; justify-content: space-between; margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--border); }
.hs-nav button { font: 500 0.8rem/1 ui-sans-serif, system-ui, sans-serif; padding: 0.4rem 0.8rem; color: var(--fg); background: none; border: 1px solid var(--border); border-radius: 6px; cursor: pointer; }
.hs-nav button:hover:not(:disabled) { border-color: var(--accent); }
.hs-nav button:disabled { opacity: 0.35; cursor: default; }
@media (max-width: 900px) { section.split { display: block; } .rail { position: static; max-height: none; margin-bottom: 1.5rem; } .pane { padding-left: 0; border: 0; } }
.diff { width: 100%; border-collapse: collapse; font: 0.8rem/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0.75rem 0; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; display: block; overflow-x: auto; }
.diff td { padding: 0 0.5rem; white-space: pre; vertical-align: top; }
body.wrap .diff td.code { white-space: pre-wrap; overflow-wrap: anywhere; }
.wrap-toggle { font: inherit; padding: 0.2rem 0.7rem; color: var(--muted); background: none; border: 1px solid var(--border); border-radius: 6px; cursor: pointer; }
.wrap-toggle[aria-pressed="true"] { background: var(--code); color: var(--fg); }
.diff .ln { color: var(--muted); text-align: right; user-select: none; min-width: 2.5rem; opacity: 0.7; }
.diff .sign { user-select: none; width: 1rem; }
.diff .code { width: 100%; }
.diff .add { background: var(--add); }
.diff .del { background: var(--del); }
.diff .gap td { color: var(--muted); text-align: center; background: var(--code); }
.evidence { margin: 1.25rem 0 0; padding-left: 1.25rem; font-size: 0.9rem; }
.evidence::before { content: "Evidence"; display: block; margin: 0 0 0.35rem -1.25rem; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
.evidence li { margin: 0.25rem 0; }
.group h3 { font-size: 1rem; margin: 1.5rem 0 0.25rem; }
.group.low { opacity: 0.8; }
/* Targets scrolled to from a hash land below the sticky tab bar and file toolbar. */
.group, li.file { scroll-margin-top: 10rem; }
.low-divider { margin: 2.5rem 0 0; }
.group-nav { display: flex; justify-content: space-between; margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--border); }
.group-nav button { font: 500 0.8rem/1 ui-sans-serif, system-ui, sans-serif; padding: 0.4rem 0.8rem; color: var(--fg); background: none; border: 1px solid var(--border); border-radius: 6px; cursor: pointer; }
.group-nav button:hover:not(:disabled) { border-color: var(--accent); }
.group-nav button:disabled { opacity: 0.35; cursor: default; }
.group > p { margin: 0.25rem 0; color: var(--muted); font-size: 0.9rem; }
.files, .tree ul { list-style: none; padding-left: 0; margin: 0.5rem 0; }
.tree ul ul { padding-left: 1rem; margin: 0.15rem 0 0.15rem 0.45rem; border-left: 1px solid var(--border); }
.files li, .tree li { margin: 0.3rem 0; }
.file summary { cursor: pointer; }
li.file > details[open] > summary { position: sticky; top: var(--tools-bottom, 6rem); z-index: 3; padding: 0.3rem 0; background: var(--bg); }
.copy-path { margin-left: 0.4rem; font: 500 0.7rem/1 ui-sans-serif, system-ui, sans-serif; padding: 0.2rem 0.45rem; color: var(--muted); background: none; border: 1px solid var(--border); border-radius: 5px; cursor: pointer; vertical-align: 1px; opacity: 0.5; transition: opacity 0.1s; }
.file summary:hover .copy-path, .copy-path:focus-visible { opacity: 1; }
.copy-path:hover { color: var(--fg); border-color: var(--accent); }
.file summary .note { margin-left: 4.7rem; }
.file details[open] { margin-bottom: 1rem; }
.num { display: inline-block; min-width: 2.2rem; color: var(--muted); font-variant-numeric: tabular-nums; }
.path .dir { color: var(--muted); }
.tree-view .path .dir { display: none; }
li.dir > details > summary { cursor: pointer; color: var(--muted); font: 0.85rem ui-monospace, SFMono-Regular, Menlo, monospace; }
.view-toggle { display: inline-flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.view-toggle button { background: none; border: 0; color: var(--muted); padding: 0.2rem 0.7rem; font: inherit; cursor: pointer; }
.view-toggle button[aria-pressed="true"] { background: var(--code); color: var(--fg); }
.ext { font-size: 0.8rem; margin-left: 0.25rem; }
.note { color: var(--muted); font-size: 0.9rem; }
figure { margin: 1.5rem 0 2.5rem; }
figcaption h3 { margin: 0 0 0.25rem; font-size: 1.05rem; }
.lede p { margin: 0 0 0.75rem; color: var(--muted); max-width: 80ch; }
h4 { margin: 0.75rem 0 0.4rem; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
pre.diagram { white-space: pre-wrap; font-size: 0.8rem; color: #5a6475; margin: 0; }
pre.diagram.broken { border-left: 3px solid #c0392b; padding-left: 0.75rem; }
.error { color: var(--minus); font-size: 0.85rem; margin: 0 0 0.5rem; }
.board .error { color: #c0392b; }
.board { position: relative; display: flex; flex-direction: column; overflow: hidden; background: #fbfcfe; color: #18202c; border: 1px solid var(--border); border-radius: 10px; }
.tools { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid #d7dce4; background: #f1f4f8; }
.tools button { font: 500 13px/1 ui-sans-serif, system-ui, sans-serif; color: #18202c; background: #fff; border: 1px solid #c3cad6; border-radius: 6px; padding: 7px 11px; cursor: pointer; min-width: 34px; }
.tools button:hover { border-color: #b45309; }
.tools button.primary { background: #18202c; border-color: #18202c; color: #fff; margin-left: auto; }
.tools .zl { font: 500 12px/1 ui-monospace, monospace; min-width: 46px; text-align: center; font-variant-numeric: tabular-nums; }
.tools .hint { font-size: 12px; color: #5a6475; margin-left: 6px; }
.board.failed .tools { display: none; }
.viewport { overflow: auto; max-height: 78vh; padding: 16px; cursor: grab; }
.viewport.dragging { cursor: grabbing; user-select: none; }
.viewport svg { display: block; max-width: none !important; margin: 0 auto; }
.viewport .edgeLabel, .viewport .edgeLabel *, .viewport .labelBkg { background-color: #fff !important; color: #18202c !important; }
.viewport .edgeLabel rect { fill: #fff !important; opacity: 1 !important; }
.board.expanded { position: fixed; inset: 0; z-index: 100; border: 0; border-radius: 0; }
.board.expanded .viewport { flex: 1; max-height: none; }
body.locked { overflow: hidden; }
.lg { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; }
.lg span { display: inline-flex; align-items: center; gap: 6px; }
.lg svg { flex: none; stroke-width: 1.4; }
.lg svg * { stroke: currentColor; fill: none; }
.sw { display: inline-block; width: 22px; height: 14px; border: 1.5px solid; border-radius: 3px; }
.sw.new { background: #dcf3e4; border-color: #1e8a4a; }
.sw.changed { background: #fdf0d2; border-color: #b07d0c; }
.sw.removed { background: #fbe3e3; border-color: #c0392b; border-style: dashed; }
.sw.context { background: #eef1f5; border-color: #8a94a6; }
.sw.external { background: #e0eafb; border-color: #2a5db0; }
.mini-legend { display: none; position: absolute; left: 12px; bottom: 12px; z-index: 2; max-width: calc(100% - 24px); flex-wrap: wrap; gap: 6px 22px; align-items: center; padding: 10px 14px; font-size: 13px; background: #fff; color: #18202c; border: 1px solid #d7dce4; border-radius: 10px; box-shadow: 0 6px 20px -10px rgba(0, 0, 0, 0.4); }
.mini-legend .muted { display: none; }
.board.show-legend .mini-legend { display: flex; }
.board:not(.expanded) .mini-legend { position: static; max-width: none; border: 0; border-bottom: 1px solid #d7dce4; border-radius: 0; box-shadow: none; }
.tools button[aria-pressed="true"] { background: #e4e9f1; }
.hs-badge { margin-left: 0.35rem; padding: 0.05rem 0.45rem; font-size: 0.75rem; text-decoration: none; color: var(--accent); border: 1px solid var(--accent); border-radius: 999px; }
@media (max-width: 600px) { .tools .hint { display: none; } }
.takeaways { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px 26px; margin-top: 0.9rem; font-size: 14px; }
.takeaways p { margin: 0.2rem 0 0; color: var(--muted); }
.stats { display: flex; flex-wrap: wrap; gap: 8px 22px; margin: 0.5rem 0; font-variant-numeric: tabular-nums; }
.stats div { display: flex; gap: 6px; align-items: baseline; }
.stats b { font-size: 18px; }
.stats .l { color: var(--muted); font-size: 13px; }
.scope { max-width: 80ch; margin: 0.5rem 0 1rem; padding-left: 10px; font-size: 13px; color: var(--muted); border-left: 3px solid var(--accent); }
.scope p { margin: 0.2rem 0; }
.reading-tools { position: sticky; top: 2.6rem; z-index: 4; margin-top: -1.5rem; padding-top: 1.5rem; display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; align-items: center; padding: 0.5rem 0; font-size: 0.85rem; color: var(--muted); background: var(--bg); border-bottom: 1px solid var(--border); }
.progress { display: inline-flex; gap: 0.6rem; align-items: center; color: var(--fg); font-variant-numeric: tabular-nums; }
.progress .bar { width: 140px; height: 6px; overflow: hidden; background: var(--code); border-radius: 999px; }
.progress .bar > span { display: block; height: 100%; background: var(--plus); transition: width 0.2s; }
.reading-tools .hint { font-size: 0.8rem; }
.filter { display: inline-flex; gap: 0.5rem; align-items: center; }
.filter input { width: 14rem; padding: 0.25rem 0.6rem; font: inherit; color: var(--fg); background: var(--card); border: 1px solid var(--border); border-radius: 6px; }
.filter input:focus { outline: none; border-color: var(--accent); }
.bulk { display: inline-flex; gap: 0.35rem; margin-left: 0.6rem; vertical-align: 1px; }
.bulk button { font: 500 0.75rem/1 ui-sans-serif, system-ui, sans-serif; padding: 0.25rem 0.55rem; color: var(--muted); background: none; border: 1px solid var(--border); border-radius: 5px; cursor: pointer; }
.bulk button:hover:not(:disabled) { color: var(--fg); border-color: var(--accent); }
.bulk button:disabled { opacity: 0.4; cursor: default; }
.reading-tools .bulk { margin-left: 0; }
.reading-tools .bulk button { font-size: 0.8rem; padding: 0.3rem 0.65rem; color: var(--fg); }
li.dir > details > summary .bulk { opacity: 0.5; transition: opacity 0.1s; }
li.dir > details > summary:hover .bulk, li.dir > details > summary:focus-within .bulk { opacity: 1; }
input.read { margin: 0 0.5rem 0 0.15rem; vertical-align: -1px; accent-color: var(--plus); cursor: pointer; }
li.is-read > details > summary .path { opacity: 0.5; text-decoration: line-through; text-decoration-color: var(--muted); }
.file-foot { display: flex; justify-content: flex-end; gap: 0.5rem; margin: -0.25rem 0 0.5rem; }
li.file .diff tr[data-k] :is(.ln, .sign) { cursor: pointer; }
li.file .diff tr[data-k]:hover .ln { color: var(--accent); opacity: 1; }
.diff tr.c-sel td, .diff tr.c-hl td { background-color: color-mix(in srgb, var(--accent) 18%, transparent); }
.diff .c-row td { padding: 0.4rem 0.5rem; white-space: normal; font: 0.9rem/1.5 ui-sans-serif, system-ui, sans-serif; background: var(--bg); }
.diff .c-row td > * { position: sticky; left: 0.5rem; max-width: min(80ch, calc(100vw - 5rem)); }
.c-file > * { margin: 0.5rem 0; max-width: 80ch; }
.c-comment, .c-form { padding: 0.5rem 0.75rem; background: var(--card); border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: 6px; }
.c-head { display: flex; gap: 0.4rem; align-items: center; }
.c-label { flex: 1; font-size: 0.8rem; color: var(--muted); }
.c-form .c-label { margin-bottom: 0.35rem; }
.c-body { margin-top: 0.2rem; white-space: pre-wrap; overflow-wrap: anywhere; }
.c-form textarea { display: block; width: 100%; min-height: 5.5rem; resize: vertical; padding: 0.45rem 0.6rem; font: 0.85rem/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--fg); background: var(--bg); border: 1px solid var(--border); border-radius: 6px; }
.c-form textarea:focus { outline: none; border-color: var(--accent); }
.c-actions { display: flex; justify-content: flex-end; gap: 0.4rem; margin-top: 0.4rem; }
:is(.c-head, .c-actions, .c-tools) button, .c-add-file { font: 500 0.75rem/1 ui-sans-serif, system-ui, sans-serif; padding: 0.3rem 0.6rem; color: var(--fg); background: none; border: 1px solid var(--border); border-radius: 5px; cursor: pointer; }
:is(.c-head, .c-actions, .c-tools) button:hover:not(:disabled), .c-add-file:hover { border-color: var(--accent); }
.c-actions button.primary { color: var(--bg); background: var(--fg); border-color: var(--fg); }
.c-tools { display: inline-flex; gap: 0.35rem; align-items: center; }
.c-tools .c-total { margin-right: 0.15rem; }
.c-tools button:disabled { opacity: 0.4; cursor: default; }
.c-count:not(:empty) { margin-left: 0.35rem; padding: 0.05rem 0.45rem; font-size: 0.75rem; color: var(--fg); background: var(--code); border-radius: 999px; }
.mark-read { font: inherit; font-size: 0.8rem; padding: 0.25rem 0.75rem; color: var(--fg); background: var(--code); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; }
.mark-read:hover { border-color: var(--plus); }
.mermaidTooltip { position: absolute; max-width: 320px; padding: 0.35rem 0.6rem !important; background: #fff !important; color: #18202c !important; border: 1px solid #d7dce4 !important; border-radius: 6px !important; font: 0.8rem/1.4 ui-sans-serif, system-ui, sans-serif !important; box-shadow: 0 4px 14px #0003; z-index: 110; pointer-events: none; }
`;

function listFiles(base: string, head: string) {
  const mergeBase = git("merge-base", base, head).trim();
  const files = changedFiles(mergeBase, head);
  console.log(`merge-base ${mergeBase.slice(0, 8)}  head ${git("rev-parse", head).trim().slice(0, 8)}  ${files.length} files`);
  for (const f of files) {
    const counts = f.added === null ? "binary" : `+${f.added} -${f.deleted}`;
    const path = f.oldPath ? `${f.oldPath} -> ${f.path}` : f.path;
    console.log(`${f.status.padEnd(5)} ${counts.padEnd(12)} ${path}${f.lowSignal ? `  [low-signal: ${f.lowSignal}]` : ""}`);
  }
}

async function browserCheck(htmlPath: string): Promise<string[]> {
  const html = readFileSync(htmlPath);
  using server = Bun.serve({ port: 0, fetch: () => new Response(html, { headers: { "content-type": "text/html" } }) });
  let view: Bun.WebView;
  try {
    view = new Bun.WebView({ backend: "chrome" });
  } catch (e) {
    console.error(`warning: browser check skipped (${e instanceof Error ? e.message : e})`);
    return [];
  }
  try {
    await view.navigate(`http://localhost:${server.port}/`);
    let state = { done: false, errors: [] as string[], broken: [] as string[] };
    for (const deadline = Date.now() + 20_000; Date.now() < deadline && !state.done; await Bun.sleep(250))
      state = await view.evaluate(
        `({ done: document.documentElement.dataset.diagrams === "done", errors: window.__guideErrors ?? [], broken: [...document.querySelectorAll("p.error")].map((e) => e.textContent) })`,
      );
    const problems = [...state.errors, ...state.broken].map((p) => (p.length > 400 ? `${p.slice(0, 400)}…` : p));
    if (!state.done) problems.push("diagrams did not finish rendering within 20s (Mermaid failed to load?)");
    return problems;
  } finally {
    view.close();
  }
}

const args = process.argv.slice(2);
const noCheck = args.includes("--no-check");
const [cmd, a, b] = args.filter((x) => x !== "--no-check");
if (cmd === "files" && a && b) {
  listFiles(a, b);
} else if (cmd === "render" && a && b) {
  const guide: Guide = JSON.parse(readFileSync(a, "utf8"));
  const errs = validate(guide);
  if (errs.length) {
    console.error(`Invalid guide JSON:\n${errs.map((e) => `  - ${e}`).join("\n")}`);
    process.exit(1);
  }
  mkdirSync(dirname(b), { recursive: true });
  writeFileSync(b, render(guide));
  const problems = noCheck ? [] : await browserCheck(b);
  if (problems.length) {
    console.error(`Rendered with problems:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log(b);
} else {
  console.error("usage: bun guide.ts files <base> <head> | render <guide.json> <out.html> [--no-check]");
  process.exit(2);
}
