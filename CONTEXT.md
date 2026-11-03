# Skills vault

Personal Claude Code skills. Terms below are shared vocabulary across skills.

## Language

### PR review

**Review Guide**:
An HTML companion document that orients a reviewer through a pull request: where to look, how the changed parts interact. Contains no findings or verdicts.
_Avoid_: PR report, review report, PR companion

**Intent**:
The purpose of a pull request: stated (description, linked issue) or inferred from commits, and marked as inferred when so. A diff that contradicts the stated Intent yields a Hotspot.
_Avoid_: goal, motivation

**Hotspot**:
A location in a pull request worth the reviewer's attention: where, why, and pointers to the evidence. States facts neutrally; neither concludes nor steers with questions.
_Avoid_: finding, issue, warning

**Change Map**:
A diagram of the parts a pull request touches and how they interact (calls, events, HTTP, storage...). Each part is marked new, changed, removed, unchanged context, or external, and the Map states what it omits. Granularity (package, file or symbol) is whatever keeps it legible; a Guide may have several.
_Avoid_: architecture diagram, dependency graph

**Behavior Diagram**:
A before/after diagram of control flow or state, included only when the pull request changes behavior rather than just structure.

**Reading Order**:
The suggested sequence in which a reviewer walks the diff, grouped by concern.

**Low-signal File**:
A changed file the reviewer can skim: generated output, lockfiles, pure renames, mechanical edits. Grouped by shared pattern, explained once per group.
_Avoid_: noise, trivial file

**Scope**:
What a Review Guide explicitly does not cover: files skimmed rather than analyzed, related repos, skipped subsystems.

**Pull request**:
A proposed change under review, on GitHub or GitLab.
_Avoid_: merge request, MR, PR (in prose)

**Review**:
Findings and a verdict on a change, produced by a reviewer (human or `code-review`).
_Avoid_: Review Guide (a Guide points where to look; a Review says what's wrong)

**PR Summary**:
The title, description and squashed commit message of a pull request, produced by `pr-summary`.
_Avoid_: Review Guide
