Per-task pipeline. The calling skill defines where the task runs (work tree or trunk) and the start point the task branched from.

- If running in a work tree and the tasks are local .md issues plus a spec, copy all of them (including issues handled by other tasks) into the work tree, so the subagent has full context.
- Dispatch an opus 5.5 subagent, high effort, to implement the task. It should use the /mattpocock-skills:tdd skill and load /williamchelman-skills:write-comments. Done when the tests pass and the diff is committed.
- Ask a /williamchelman-skills:codex solar agent, medium effort, to /mattpocock-skills:code-review the changes since the start point. Also ask a fable agent with medium effort to do the review.
- Give the findings to fix (if any) to one or more opus 5.5 agent with high effort, depending on the scale of changes asked. Done when every finding is resolved or explicitly dismissed with a reason.
