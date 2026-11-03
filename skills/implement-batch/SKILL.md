---
name: implement-batch
description: Implement a batch of tasks
disable-model-invocation: true
---

Select up to 3 tasks whose status is `ready-for-agent` and that are not blocked. If none qualify, report that and stop. If you pick tasks, change their status to `in-progress`. If you are currently on main, create a new trunk branch and check it out, otherwise stay on the current branch. Work on the tasks in parallel, each in a separate work tree branching from the trunk branch, created in `.claude/worktrees`. For each task:

- run [pipeline.md](../_shared/pipeline.md) in its work tree, with the trunk as start point.
- finally, squash all the commits and create a pull request from the work tree to the trunk, following /mattpocock-skills:pr. Set the ticket status to `ready-for-human`. Delete the work tree.
