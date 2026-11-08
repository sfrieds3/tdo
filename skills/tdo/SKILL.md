---
name: tdo
description: Per-project persistent backlog for things to fix later, via the `tdo` CLI. Use when the user says to park, defer, log, or "add to tdo/backlog/todo" something; when you notice a real issue outside the current task's scope (ask first); when asked what's pending, open, or parked for this repo; or when you fix something that might already be a tdo item.
---

# tdo — park it, don't derail

`tdo` stores "fix later" items per project in a local SQLite database, shared across sessions, agents, and machines. The project is resolved from the current directory's git remote (`github.com/owner/repo`), so run commands from inside the repo. Always pass `--json` when you need to read the output.

## When to use it

- **User asks to park something** ("park that", "add it to tdo", "deal with it later"): add it right away, no confirmation needed.
- **You notice an out-of-scope problem** (a bug, flaky test, dead code, risky pattern) while working on something else: do not fix it inline. Ask the user whether to park it, proposing a title and priority, e.g. *"Want me to park this in tdo? `config loader re-reads env on every call` (normal, #perf)"*. Add it only if they agree. Never log silently.
- **User asks what's pending / open / on the backlog**: list items.
- **Starting work in an area**: a quick `tdo ls -q <keyword> --json` can surface parked items worth folding in. Mention relevant ones; don't act on them unasked.
- **You fixed something that was parked**: close it with a note.

## Commands

```sh
tdo add "<title>" -p <urgent|high|normal|low> -t tag1,tag2 -b "<body>" -f path/to/file.ts:42 --source <agent> --json
tdo ls --json                      # active (open + doing) items in this project, most urgent first
tdo ls -q "search words" --json    # full-text search over titles and bodies
tdo ls -t perf -p high --json      # filter by tag; -p means "this priority or more urgent"
tdo ls -s all --json               # include done/dropped; -a spans every project
tdo show <id> --json
tdo edit <id> -p high -t +newtag,~oldtag -b "<new body>" --json
tdo start <id>                     # mark as doing
tdo done <id> -m "<what fixed it>" # also: drop <id> -m "<why>", reopen <id>
tdo note <id> "<progress or finding>"   # add a note without changing status
tdo tracker status --json          # approval, destination, links and queued operation counts
tdo sync --json                    # deliver queued work for this project only
tdo sync --retry --json            # reset attention failures only after fixing the cause
```

Set `--source` to the agent you are: `claude`, `codex`, `pi`, or similar. Items record their source, host, and timestamps automatically.

## Writing a good item

A future session — possibly another agent on another machine — must understand it cold.

- **Title**: specific and actionable, under ~80 characters. *"Login test flakes when token refresh races"*, not *"fix test"*.
- **Body**: why it matters, how to reproduce or where you saw it, and any fix idea. Two to five sentences.
- **File**: repo-relative `path:line` when there is one location (`-f src/auth/login.ts:88`).
- **Priority**: `urgent` = broken now / data loss; `high` = real bug or blocker soon; `normal` = default; `low` = cleanup, nice-to-have.
- **Tags**: a few short lowercase topics (`ci`, `perf`, `security`, `cleanup`, `docs`). Check `tdo tags --json` and reuse existing tags before inventing new ones.

## Notes

- If `tdo` is not on PATH, tell the user; don't try to install it.
- `tdo project` prints the resolved project key; `tdo paths` shows where the database and config live.
- Item ids are per project: `3` / `#3` is item 3 in the current project. For another project use `NAME#3` or `--project KEY`. A filed item also answers to `gh#45` (its GitHub issue number, current project) or its issue URL; `↗gh#45` in lists is the issue number, not a tdo id. In JSON, `id` is that per-project number and `projectId` is the project's UUID.
- Always pass an explicit id and `--json`. Plain `tdo` and id-less commands open an interactive fzf picker meant for humans; never rely on it.
- Do not edit the SQLite database directly; always go through the CLI.
- **Never put tdo ids in commit messages, PR titles or bodies, or branch names.** `#3`, `tdo#3`, and `widgets#3` are local bookkeeping; on GitHub `#3` links to an unrelated issue or PR. Describe the change itself. When working on a linked item with issue sync enabled (a valid, approved GitHub tracker), include `Closes https://HOST/OWNER/REPO/issues/42` in the resulting PR description, using the confirmed existing open/closed link's URL and matching external issue number and destination from `tdo show <id> --json`. Use the fully qualified URL, including when the link belongs to a different repository than the PR or current tracker destination; never substitute the local tdo id or guess an issue number from it. Do not add an issue-closing instruction when tracking is disabled, missing, invalid, unapproved/changed, or the item is unlinked, awaiting approval, pending, creating, or unknown. For an item from another project, work from that project's checkout to verify its tracker policy first; the Pi handoff conservatively omits issue instructions for foreign-project items. Referencing an existing issue does not authorize filing a new one or approving configuration.

## GitHub issues

A project can file items as GitHub issues (`tdo push`) once the user has approved its tracker config. Filing creates a public, shared record under the user's GitHub identity, so:

- **Never run `tdo push`, `tdo tracker approve`, or anything with `--yes` unless the user explicitly asks you to in this turn.** Offer instead: *"Want me to file #3 as a GitHub issue?"*
- `tdo show <id> --json` lists an item's `links` (issue URL and state); `tdo ls --linked` shows filed items.
- A link in state `unknown` or `error` needs the user's judgment; report it, don't retry.

Linked items sync one-way to GitHub: title/body/file edits update the issue, notes post comments, and done/drop/reopen change issue state when `closeOnDone` is enabled. Local mutations commit first and still succeed when sync fails. Use `--no-sync` on ordinary mutations to save intent without network delivery. `↗…` means queued work; `↗!` means attention/unknown/error. Delivery pauses while tracker approval is missing or changed; existing links keep their original repository. Comments may be duplicated after a lost response; updates and status operations are idempotent. Notes preceding issue creation are not back-posted.

`sync` only delivers already-authorized links (and pending authorized creates); it does not authorize filing a new item. This is protection against cooperative agents making mistakes, not a security barrier against processes impersonating a human.

### Trigger tags and consent

An approved project can enable `mode: "auto-on-tag"` with a trigger tag (default `#issue`). Adding that tag is fine: agent-created items become `awaiting-approval`, not GitHub issues. Even a human edit does not change creation provenance. Use `tdo ls --awaiting` (or `-s all --awaiting` for closed items) to inspect these. `tdo sync` never files awaiting items. The user can confirm filing in Pi or explicitly ask for `tdo push` in this turn. Do not run `tdo push`, `tdo tracker approve`, or `--yes` without that explicit request. Pi confirmations do not waive this agent rule.

On an item already filed as an issue, tag edits become GitHub label changes (missing labels are created in the repository), so keep tags on filed items meaningful to outside readers.
