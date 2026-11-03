#!/usr/bin/env bun
/**
 * Validates skills/<name>/SKILL.md frontmatter and regenerates the README skill index.
 *
 * Usage:
 *   bun scripts/check.ts          # validate + rewrite README index in place
 *   bun scripts/check.ts --check  # validate + fail if README index is stale (CI gate)
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SKILLS_DIR = join(ROOT, "skills");
const README = join(ROOT, "README.md");
const START = "<!-- skills-index:start -->";
const END = "<!-- skills-index:end -->";

const checkMode = process.argv.includes("--check");
const errors: string[] = [];

interface Skill {
  name: string;
  description: string;
}

// Strip one layer of matching surrounding quotes (YAML-quoted scalars, e.g. descriptions
// that contain a ": "). The real skill loader parses YAML properly; this keeps the naive
// parser's output (and the generated index) clean.
function unquote(v: string): string {
  const dq = v.match(/^"(.*)"$/);
  if (dq) return dq[1].replace(/\\"/g, '"');
  const sq = v.match(/^'(.*)'$/);
  if (sq) return sq[1];
  return v;
}

function parseFrontmatter(raw: string): Record<string, string> | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) fields[kv[1]] = unquote(kv[2].trim());
  }
  return fields;
}

const skills: Skill[] = [];
const dirs = existsSync(SKILLS_DIR)
  ? readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
      .map((d) => d.name)
      .sort()
  : [];

for (const dir of dirs) {
  const skillPath = join(SKILLS_DIR, dir, "SKILL.md");
  if (!existsSync(skillPath)) {
    errors.push(`skills/${dir}: missing SKILL.md`);
    continue;
  }
  const fm = parseFrontmatter(readFileSync(skillPath, "utf8"));
  if (!fm) {
    errors.push(`skills/${dir}/SKILL.md: missing frontmatter block`);
    continue;
  }
  if (!fm.name) errors.push(`skills/${dir}/SKILL.md: missing 'name' in frontmatter`);
  if (!fm.description) errors.push(`skills/${dir}/SKILL.md: missing 'description' in frontmatter`);
  if (fm.name && fm.name !== dir) {
    errors.push(`skills/${dir}/SKILL.md: frontmatter name '${fm.name}' does not match directory name`);
  }
  if (fm.name && fm.description) skills.push({ name: fm.name, description: fm.description });
}

if (errors.length) {
  console.error("Validation failed:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

const index = skills.length
  ? skills.map((s) => `- **[${s.name}](skills/${s.name}/SKILL.md)** — ${s.description}`).join("\n")
  : "_No skills yet._";

const readme = readFileSync(README, "utf8");
const startIdx = readme.indexOf(START);
const endIdx = readme.indexOf(END);
if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
  console.error(`README.md: missing ${START} / ${END} markers`);
  process.exit(1);
}

const updated =
  readme.slice(0, startIdx + START.length) + "\n\n" + index + "\n\n" + readme.slice(endIdx);

if (updated === readme) {
  console.log(`OK: ${skills.length} skill(s) valid, README index up to date.`);
} else if (checkMode) {
  console.error("README skill index is stale. Run: bun scripts/check.ts");
  process.exit(1);
} else {
  writeFileSync(README, updated);
  console.log(`OK: ${skills.length} skill(s) valid, README index regenerated.`);
}
