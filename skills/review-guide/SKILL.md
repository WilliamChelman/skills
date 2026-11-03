---
name: review-guide
description: Generate a Review Guide, an HTML companion that orients a reviewer through a pull request
disable-model-invocation: true
---

# Review Guide

Args: optional PR/MR number or URL, optional `--out <path>`.

A Review Guide tells a reviewer where to look and how the changed parts interact. It contains **no findings and no verdicts**. Write it honestly regardless of who runs it: flag weak spots the author would rather skip.

`guide.ts` lives in this skill's base directory. Run it from inside the repository.

## 1. Resolve the change

Never touch the user's checkout. The Guide covers `<base>..<head>` only: never mention local uncommitted or staged files in it.

- **PR/MR arg.** URL with `/-/merge_requests/` or a GitLab host → `glab`; otherwise `gh`. A bare number → the host of `origin`.
  - GitHub: `gh pr view <arg> --json number,url,title,body,baseRefName,headRefOid,closingIssuesReferences`, then `git fetch origin <baseRefName> pull/<number>/head`. Base `origin/<baseRefName>`, head `headRefOid`.
  - GitLab: `glab mr view <arg> -F json` (`iid`, `web_url`, `title`, `description`, `target_branch`, `sha`), then `git fetch origin <target_branch> merge-requests/<iid>/head`. Base `origin/<target_branch>`, head `sha`.
  - `git worktree add --detach "$TMPDIR/review-guide/wt-<repo>-<number>" <head>` and explore code there. Remove it when done.
- **No arg.** Head `HEAD`. If the current branch has an open PR/MR (`gh pr view` / `glab mr view` with no arg), use its base and metadata. Otherwise base = whichever of `origin/main`, `origin/master`, `origin/develop` (that exist) has the fewest `git rev-list --count <base>..HEAD`. Never assume `main`.

Read linked issues (`gh issue view`, `glab issue view`) as Intent input.

## 2. Survey

```sh
bun <skill-dir>/guide.ts files <base> <head>
```

Lists changed files with +/− counts and auto-flagged Low-signal Files (lockfiles, generated, binary, pure renames). Glance at flagged files, don't study them.

## 3. Analyze

Read surrounding code (callers, callees, consumers, tests), not just the diff: the Change Map needs neighbors.

Large PR (roughly >20 non-low-signal files, or several packages): spawn one Explore subagent per subsystem. Each returns interactions between parts and candidate Hotspots with `file:line` and evidence. Merge, dedupe, rank them yourself. Otherwise do it in a single pass.

## 4. Write the guide JSON

Write to `$TMPDIR/review-guide/<repo>-<number-or-branch>.json`:

```json
{
  "title": "Make config loading tolerant of bad input",
  "base": "origin/main",
  "head": "3f2a9c1",
  "pr": { "url": "https://github.com/acme/app/pull/42" },
  "intent": { "text": "Malformed config no longer crashes startup. The loader falls back to built-in defaults and logs the parse error.", "inferred": false },
  "scope": "Only `src/` analyzed; the `deploy/` Helm charts changed too but weren't read.",
  "changeMaps": [
    {
      "title": "Config loading",
      "description": "Who loads config and what they do with it. Logging calls omitted.",
      "mermaid": "flowchart LR\n  CLI[[\"cli main\"]]:::context --> Parse[\"parseConfig\"]:::changed\n  Parse -->|reads| FS[(\"config.yml\")]:::external\n  Parse --> Defaults[/\"defaults.ts\"/]:::new",
      "takeaways": [{ "title": "Defaults are new", "text": "`defaults.ts` holds the fallback values used on parse failure." }]
    }
  ],
  "hotspots": [
    {
      "id": "parse-undefined",
      "title": "`parseConfig` can now return `undefined`",
      "category": "contract",
      "file": "src/config.ts",
      "line": 42,
      "endLine": 48,
      "why": "Return type widened to include `undefined`; three call sites predate the change.",
      "evidence": [
        { "file": "src/cli.ts", "line": 10, "note": "call site" },
        { "file": "src/server.ts", "line": 88, "note": "uses result directly" }
      ],
      "nodes": ["Parse"]
    }
  ],
  "readingOrder": [
    { "title": "Core", "files": [{ "file": "src/config.ts", "note": "the new return type" }] },
    { "title": "Callers", "note": "Each consumes the widened type.", "files": [{ "file": "src/cli.ts" }] }
  ],
  "lowSignal": [
    { "title": "Import path update", "text": "`utils/config` became `config`; no other change.", "files": ["src/a.ts", "src/b.ts"] }
  ],
  "behaviorDiagrams": [
    { "title": "Startup with bad config", "description": "Before: crash. After: fallback.", "before": "sequenceDiagram\n  ...", "after": "sequenceDiagram\n  ..." }
  ]
}
```

Each fact appears once: Change Maps carry structure (who owns, calls or feeds what), Hotspots carry specific locations, Behavior Diagrams carry flow. Don't restate one in another.

`pr` omitted when there's no PR/MR. `scope` states what the Guide doesn't cover (files skimmed rather than analyzed, related repos, subsystems a fan-out skipped); omit it only when everything was covered. `side: "old"` on a ref points at pre-change lines (deleted code). Inline text supports `` `code` `` and `**bold**`.

### Intent

2–3 full sentences on what the change is for. Gloss any term the PR itself introduces (e.g. from a new ADR) on first use. `inferred: true` when built from commits alone.

### Change Map

- `flowchart` (or `graph`). Aim for 5–15 nodes. Pick the granularity that gets there: packages for broad PRs, files or symbols for narrow ones.
- Every node gets a status class (definitions are injected): `:::new`, `:::changed`, `:::removed`, `:::context` (unchanged, shown because the change touches or can break it), `:::external` (backend endpoint, third-party service, queue).
- Shape = kind of part; the legend explains these to the reader:
  - `["..."]` module / component / class
  - `(["..."])` service, long-lived stateful object
  - `[["..."]]` entry point: route, page, CLI command, job
  - `[/"..."/]` data, types, utils, config
  - `[("...")]` storage or endpoint
- Edge style = kind of link: `==>` owns / renders / hosts, `-->` depends on / calls / injects, `-.->` remote (HTTP, RPC, events). Add a label only when the style doesn't say enough (`-.->|POST /drafts|`). Arrows point from owner or caller to what it owns or calls (`A --> B` = A uses B), never along data flow.
- `subgraph` for layers or packages (app, libs, backend).
- `description`: one or two lines on what the map shows, and what was deliberately omitted ("every module imports `core`; those edges omitted").
- `takeaways`: 0–3 short cards on structure the diagram can't show at a glance. Never restate a Hotspot or Behavior Diagram (Hotspot `nodes` already link from the map). Facts, not verdicts or defenses ("by design").
- Several maps when the PR spans unrelated subsystems.
- Plain alphanumeric node ids, quoted labels, `<br/>` for a second label line. Label lines ≤ ~25 chars. Prefer `flowchart TB` when the longest chain is more than ~4 nodes: wide maps don't fit the screen. No `%%{init}%%`: theme and layout are global. A Hotspot's `nodes` makes those nodes link to it.

### Hotspots

A Hotspot = one location, one concern, evidence pointers.

- `title`: ≤10 words naming the specific fact, not the PR's headline mechanism (Intent and Change Map carry that).
- `why`: ≤3 short sentences (~50 words), stating what changed and what it touches. An unrelated second fact is its own Hotspot or is dropped; "separately" means you merged two.
- `evidence`: every ref gets a `note` (≤6 words) saying what is there, and supports something `why` states. Don't cite lines inside the Hotspot's own range.
- No conclusions, consequences, mitigations or leading questions. Give the facts; the reviewer connects them.

Examples:
- Bad: "2 callers don't handle `undefined`." (conclusion)
- Bad: "Are you sure every caller handles `undefined`?" (leading)
- Bad: "…so a mixed `?cases=` would render `unsupported` fields. The modal prevents it." (consequence, then mitigation: both conclusions)
- Bad: "The picker does not normalise the value." (a missing behavior reads as a defect; point at the code that reads the value instead)
- Good: "Return type widened to include `undefined`; three call sites predate the change." plus all three call sites as evidence.

Rank by risk × blast radius, highest first. Soft cap ~10. Zero is fine: the guide then says "Nothing stands out."

Categories: `intent-mismatch`, `contract`, `data-migration`, `concurrency`, `security`, `error-handling`, `performance`, `test-coverage`, `other`. Pick the most specific; `contract` is for interface changes callers see, not a catch-all.

Diff contradicts stated Intent (e.g. "pure refactor" but a default changes) → `intent-mismatch` Hotspot.

### Reading Order

Every changed file that isn't low-signal, grouped by concern (e.g. types, core, callers, tests). Groups and files within them are in the order a reviewer should walk them. Each group gets a one-line `note` on what to check there. File notes only when they add something the path and counts don't. Place tests one way throughout: right after their source, or one tests group per subsystem. Group titles become entries in a side rail, so keep them to a few words. Each file renders with a collapsible diff; files holding a Hotspot are badged automatically.

### Low-signal Files

Groups of files that share one explanation: `title`, optional `text` saying what the pattern is, and `files`. Use it for mechanical edits the script can't detect (a rename applied across modules, a lint fix, an import path update), so the reviewer reads the pattern once instead of every file. Auto-flagged files (lockfiles, generated, binary, pure renames) are grouped automatically unless you claim them in your own group.

### Behavior Diagrams

Only when control flow or state changes. `sequenceDiagram` or `stateDiagram-v2`, before and after; `alt`/`opt` for outcome branches. Omit `before` for new behavior. Optional `description`.

Apply `unslop` to all prose.

## 5. Render

```sh
bun <skill-dir>/guide.ts render <json> <html>
```

Default `<html>`: same path as the JSON with `.html`; `--out` overrides. After writing, the script loads the page in headless Chrome (Bun.WebView) and fails on Mermaid parse errors, JS errors or CDN load failures. Fix validation and render errors and re-run. Address any `not in readingOrder or lowSignal` warning. Then `open <html>` (macOS) or `xdg-open`, remove the worktree, and print the path.
