# GitHub Issues

Issues and product requirements live in GitHub Issues for `gregbell/unlab`.
Run `gh` from this repo so it picks up the repository from `origin`.
Before creating the first issue in a session, verify that `gh repo view --json nameWithOwner --jq .nameWithOwner` returns `gregbell/unlab`.

| Task                             | Command                                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------------------- |
| Publish a ticket                 | `gh issue create --title "<title>" --body-file <file>`                                          |
| Read a ticket and its discussion | `gh issue view <number> --json title,body,labels,comments`                                      |
| Find open tickets by label       | `gh issue list --state open --label "<label>"`                                                  |
| Comment on a ticket              | `gh issue comment <number> --body-file <file>`                                                  |
| Apply or remove a label          | `gh issue edit <number> --add-label "<label>"` or `--remove-label "<label>"`                    |
| Close a ticket                   | `gh issue comment <number> --body-file <resolution-file>` followed by `gh issue close <number>` |

**PRs as a request surface: no.**

## Wayfinder

Keep the map in one issue labeled `wayfinder:map`. Link child tickets as
GitHub sub-issues. If sub-issues are unavailable, list the tickets in the
map's task list and put `Part of #<map>` in each child.

Label each child by its work type using `wayfinder:research`,
`wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`.
Record blockers with GitHub issue dependencies. If dependencies are
unavailable, add `Blocked by: #<number>` to the child.

With `gh` 2.94 or newer, link a child with `gh issue edit <parent> --add-sub-issue <child>` and record a blocker with `gh issue edit <child> --add-blocked-by <blocker>`. Check the open blocker count with `gh api repos/gregbell/unlab/issues/<number> --jq .issue_dependencies_summary.blocked_by`.

To claim work, take the first open, unassigned child in map order whose
blockers are all closed. Assign it to yourself with
`gh issue edit <number> --add-assignee @me`. When finished, comment with
the result, close the child, and add a summary and link to the map.
