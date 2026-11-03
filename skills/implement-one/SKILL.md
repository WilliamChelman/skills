---
name: implement-one
description: Implement one ready ticket on a trunk branch and open a PR
disable-model-invocation: true
---

For a user story with a single task that does not need splitting.

- Pick the first task whose status is `ready-for-agent` and that is not blocked. If none qualifies, report that and stop. If you pick one, change its status to `in-progress`.
- Create a new trunk branch off the current branch (the base branch, usually main) and check it out.
- Run [../_shared/pipeline.md](../_shared/pipeline.md) directly on the trunk, with the base branch as start point. No work tree.
- Squash all the commits and create a pull request from the trunk to the base branch, with me as reviewer and assignee, following [../pr-summary/guidelines.md](../pr-summary/guidelines.md). Set the ticket status to `ready-for-human`.
