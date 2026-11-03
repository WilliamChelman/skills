---
name: implement-all
description: Implement all given tasks on a trunk branch, no intermediate PRs
disable-model-invocation: true
---

Create a new trunk branch and check it out. Work on all given tasks, up to 3 in parallel, each in a separate work tree branching from the trunk, created in `.claude/worktrees`. No intermediate PRs: the deliverable is the trunk with every task merged. For each task:

- Run [../_shared/pipeline.md](../_shared/pipeline.md) in its work tree, with the trunk as start point.
- Rebase onto the trunk, resolving conflicts and re-running tests if needed. Fast-forward merge into the trunk, then delete the work tree.
