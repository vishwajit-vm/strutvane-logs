---
description: Run the pre-PR checklist for this repo
---

Run the pre-PR checklist for Strutvane Logs:
1. `git status` and `git diff`: summarise the change.
2. Run lint, typecheck and tests if a package.json exists. Report the exact results.
3. Confirm there is a changeset, and that the docs and spec are updated for any public API or behaviour change.
4. Confirm no `.env`, secrets or Docker files are staged.
5. Invoke the `logs-security-reviewer` subagent on the diff and include its findings.
End with: ready / not ready, and why.
