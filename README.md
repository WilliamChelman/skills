# williamchelman-skills

William Chelman's personal skills vault for Claude Code, distributed as a plugin via a native
marketplace.

## Skills

<!-- skills-index:start -->

- **[bun-browser-testing](skills/bun-browser-testing/SKILL.md)** — Test or verify something in a live browser: navigate a page, click, type, screenshot, or assert on rendered DOM. Uses Bun 1.4's Bun.WebView to drive a real Chrome browser from a test. Prefer this over Chrome MCP.
- **[codex](skills/codex/SKILL.md)** — Use when asked to delegate a task, review, or second opinion to codex, or when a codex model nickname (solar, terra, luna, astra...) or reasoning effort is named.
- **[glab](skills/glab/SKILL.md)** — GitLab via the glab CLI. Use to open or update a merge request, call the GitLab API, or upload a file (screenshot, image) into an MR or issue body.
- **[implement-all](skills/implement-all/SKILL.md)** — Implement all given tasks on a trunk branch, no intermediate PRs
- **[implement-batch](skills/implement-batch/SKILL.md)** — Implement a batch of tasks
- **[implement-one](skills/implement-one/SKILL.md)** — Implement one ready ticket on a trunk branch and open a PR
- **[pr-summary](skills/pr-summary/SKILL.md)** — Summarize PR
- **[review-guide](skills/review-guide/SKILL.md)** — Generate a Review Guide, an HTML companion that orients a reviewer through a pull request
- **[unslop](skills/unslop/SKILL.md)** — Cut AI tells from any writing. Must always apply.
- **[write-comments](skills/write-comments/SKILL.md)** — Rules for writing comments and self-documenting code. Must always apply when writing code.

<!-- skills-index:end -->

## Install into a project

Add the marketplace and install the plugin from inside Claude Code:

```
/plugin marketplace add WilliamChelman/skills
/plugin install williamchelman-skills@williamchelman
```

Skills are invoked as `/williamchelman-skills:<skill>`.

There is no version field: the marketplace is git-backed, so updates propagate automatically on
commit. Refresh installed projects with `/plugin marketplace update`.

## Local development

To iterate on skills locally without pushing to git or touching the marketplace:

1. **Symlink this repo into your project's skills directory** (or globally into `~/.claude/skills/`):

   ```bash
   ln -s /absolute/path/to/this/repo ~/.claude/skills/williamchelman-skills
   # Or for a specific project:
   ln -s /absolute/path/to/this/repo /path/to/project/.claude/skills/williamchelman-skills
   ```

2. **Reload plugins** in Claude Code to pick up the symlink:

   ```
   /reload-plugins
   ```

3. **Edit `SKILL.md` files** in this repo, then run `/reload-plugins` again to pick up the changes.

The plugin loads as `williamchelman-skills@skills-dir` with no marketplace or install step. Nothing
is copied to the plugin cache — edits reflect in place on reload.

> Alternative (Claude Code ≥ 2.1.229): a marketplace entry with a command source and `"mode": "link"`
> symlinks the plugin instead of caching a copy, giving the same live-edit behavior through the
> marketplace flow. The plain symlink above is simpler for solo development.

## Validation

`scripts/check.ts` (bun, zero dependencies) validates each skill's frontmatter (`name`,
`description`, name↔directory match) and regenerates the skill index above:

```bash
bun scripts/check.ts          # validate + regenerate index in place
bun scripts/check.ts --check  # validate + fail if index is stale (runs in CI on push to main)
```

## License

MIT
