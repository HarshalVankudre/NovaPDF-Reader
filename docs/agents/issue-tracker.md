# Issue tracker: GitHub

Issues and specs live in `HarshalVankudre/NovaPDF-Reader` on GitHub. Use the `gh` CLI.

## Conventions

- Target this repository explicitly with `--repo HarshalVankudre/NovaPDF-Reader`. Before creating the first issue in a session, verify the target with `gh repo view --json nameWithOwner`.
- Create: `gh issue create --title "..." --body-file <file>`. Use a UTF-8 temporary file for multiline bodies.
- Read: `gh issue view <number> --json number,title,body,labels,comments`.
- List: `gh issue list --state open --json number,title,body,labels`; add label filters as needed. Read individual issues for their comments.
- Comment: `gh issue comment <number> --body-file <file>`.
- Labels: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`. Read `triage-labels.md` for the role mapping.
- Close: post the resolution as a comment, then run `gh issue close <number>`. This preserves the explanation even if the issue is already closed.
- Sub-issues: use `gh issue create --parent <parent>` or `gh issue edit <parent> --add-sub-issue <child>`. If unavailable, put `Part of #<parent>` at the top of the child body and link it from the parent.
- Blocking: use native dependencies with `gh issue edit <child> --add-blocked-by <blocker>`. Count open blockers with `gh api repos/HarshalVankudre/NovaPDF-Reader/issues/<number> --jq .issue_dependencies_summary.blocked_by`. If dependencies are unavailable, record `Blocked by: #<number>` in the child body. An issue is startable when every blocker is closed.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Skill operations

- "Publish to the issue tracker": create a GitHub issue.
- "Fetch the relevant ticket": read the referenced GitHub issue and its comments.

## Wayfinding operations

- Map: one issue labelled `wayfinder:map`, containing Notes, Decisions-so-far, and Fog.
- Child: a sub-issue of the map, labelled `wayfinder:<type>` (`research`, `prototype`, `grilling`, or `task`). Use the parent/body fallback above if needed.
- Frontier: choose the first open child in map order with no open blockers and no assignee.
- Claim: assign the issue to the driving developer before starting work (`gh issue edit <number> --add-assignee @me` for yourself).
- Resolve: comment with the answer, close the child, and append a gist plus link to the map's Decisions-so-far.
