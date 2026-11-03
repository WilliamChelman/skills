---
name: glab
description: GitLab via the glab CLI. Use to open or update a merge request, call the GitLab API, or upload a file (screenshot, image) into an MR or issue body.
---

# glab

glab owns the auth: every call goes through `glab` itself, so the token stays in its keyring. `glab auth status` shows the logged-in user.

## API

`glab api <path>` calls the REST API. `:id` in the path resolves to the current repo's project. `glab api user | jq -r .username` gives your own username (for `--assignee`).

## File uploads

Upload with the multipart flag `--form`, value prefixed with `@`:

```bash
glab api --method POST "projects/:id/uploads" --form "file=@shot.png"
```

The response's `markdown` field (`![shot](/uploads/<hash>/shot.png)`) embeds the file in any MR, issue or comment body as is. `-F`/`--field` sends JSON and gets a 400 here.

## Merge requests

Write the body to a file, then pass it in:

```bash
glab mr create -s <branch> -b main -t "<title>" -d "$(cat body.md)" -a <username> --remove-source-branch -y
glab mr update <iid> -d "$(cat body.md)"
```

`-y` skips the interactive confirmation.
