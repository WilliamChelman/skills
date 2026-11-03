---
name: codex
description: Use when asked to delegate a task, review, or second opinion to codex, or when a codex model nickname (solar, terra, luna, astra...) or reasoning effort is named.
---

# Codex

Verified against `codex-cli 0.153.4`.

## Model

`-m <slug>`. Nicknames map to slugs:

| Nickname    | Slug            | Default effort | Efforts                              | Positioning                 |
| ----------- | --------------- | -------------- | ------------------------------------ | --------------------------- |
| astra       | `gpt-6-astra`   | low            | low, medium, high, xhigh, max, ultra | Most capable, complex work  |
| solar / sol | `gpt-5.6-sol`   | medium         | low, medium, high, xhigh, max, ultra | Reliable everyday workhorse |
| terra       | `gpt-5.6-terra` | medium         | low, medium, high, xhigh, max, ultra | Balanced coding             |
| luna        | `gpt-5.6-luna`  | medium         | low, medium, high, xhigh, max        | Fast and cheap              |
| reserve     | `gpt-reserve`   | medium         | low, medium, high, xhigh, max        | Fast and cheap, fallback    |
| 5.5         | `gpt-5.5`       | xhigh          | low, medium, high, xhigh             | Previous generation         |
| mini        | `gpt-5.4-mini`  | medium         | low, medium, high, xhigh             | Small, simple tasks         |

Refresh when a slug is rejected:

```sh
codex debug models | jq -r '.models[] | "\(.slug)\t\(.default_reasoning_level)\t\([.supported_reasoning_levels[].effort] | join(","))"'
```

## Effort

`-c model_reasoning_effort=<level>`, from the model's Efforts column. `ultra` adds automatic task delegation on top of max reasoning. A level outside the column fails as an HTTP 400 after the run starts, so check the table first.

Omitting `-m` or `-c` falls back to `~/.codex/config.toml`.

## Delegate

1. Pick model and effort. Use what the user named; otherwise `gpt-5.6-sol` at the model's default effort.
2. Pick sandbox: `-s read-only` for reviews and questions, `-s workspace-write` when codex should edit files.
3. Run, writing the final message to a fresh temp file so parallel runs never share one:

   ```sh
   out=$(mktemp "${TMPDIR:-/tmp}/codex.XXXXXX")
   codex exec -m gpt-5.6-sol -c model_reasoning_effort=high \
     -s read-only --ephemeral -o "$out" \
     "Review src/auth.ts for race conditions. Report findings only." </dev/null
   ```

   `</dev/null` is required: codex reads a non-TTY stdin as extra prompt input and waits on it. `--ephemeral` keeps the run out of session history; `-C <dir>` sets the working root when it differs from cwd.

4. Read `$out` and relay it. Done when the user has codex's final message, not the run log.
