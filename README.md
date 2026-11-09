# tdo

[![Build](https://github.com/sfrieds3/tdo/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/sfrieds3/tdo/actions/workflows/ci.yml)
[![Version](https://img.shields.io/github/v/release/sfrieds3/tdo)](https://github.com/sfrieds3/tdo/releases/latest)

<img src="assets/tdo.svg" alt="tdo — a checked box" width="64" height="64">

**A per-project backlog for the things you'll fix later.**

You're halfway through a change and notice a flaky test, a slow config loader, a helper with a misleading name. None of it belongs in this commit, and all of it is gone from your head by tomorrow. `tdo` is the place to put it: one command to park an item, scoped to the repo you're in, and still there when you come back — on any machine.

```console
$ tdo add "login test flakes on CI !high #ci" -f src/auth/login.test.ts:88
added #1  high    login test flakes on CI  #ci  @ src/auth/login.test.ts:88

$ tdo ls
#2  normal  [doing]  config loader re-reads env on every call  #perf  @ src/config.ts:12
#4  urgent  crash when settings file is empty  @ src/settings.ts:40
#1  high    login test flakes on CI  #ci  @ src/auth/login.test.ts:88
#3  low     rename helpers in utils/ to match house style  #cleanup

$ tdo done 1 -m "added retry around token refresh"
done #1  high    [done]  login test flakes on CI  #ci  @ src/auth/login.test.ts:88
```

It ships with an [agent skill](skills/tdo/SKILL.md), so Claude Code, Codex, Pi, or any agent that reads `SKILL.md` files can park the issues it trips over mid-task — after asking you — instead of derailing the work. And it's a [Pi](https://pi.dev) package with a `/tdo` picker and a footer that shows the open count and the item you're working on.

## Features

- **Scoped to the project, not the path.** Items are keyed by the repo's git remote (`github.com/owner/repo`), so a clone in `~/code` on your laptop and one in `/home/you/src` on a server share a backlog. Worktrees share their main checkout's backlog.
- **Priorities and tags.** `urgent`, `high`, `normal`, `low`, plus free-form tags. Inline shorthand — `!high #ci` — works anywhere you type a title.
- **Context that survives.** Each item can carry a body (the why, a repro), a `path:line`, and records where it came from: CLI, you in Pi, or the agent, with the session and host.
- **Search.** Full-text search over titles, bodies, and notes, plus filters by tag, priority, and status.
- **File GitHub issues when you're ready.** Explicitly push an item using your local `gh` credentials, then sync its edits, notes, and lifecycle with a durable queue and per-user approval for repository-provided tracker settings.
- **Works with any agent.** One skill teaches agents when to park, how to write an item a future session can act on, and to ask before logging what they found themselves. Every command takes `--json`, and items record which agent added them.
- **Just SQLite, local or over SSH.** One file under `$XDG_DATA_HOME`, built-in `node:sqlite`, zero runtime dependencies. Keep it on one host and access it with your existing SSH config and agent.

## Install

Requires **Node 22.18+** (it runs its TypeScript directly via Node's type stripping, with Node's compile cache enabled so later runs skip recompiling; set `NODE_DISABLE_COMPILE_CACHE=1` to turn that off).

### CLI

```sh
git clone git@github.com:sfrieds3/tdo.git ~/code/tdo
cd ~/code/tdo && just link        # ~/.local/bin/tdo -> src/bin.mjs, plus the skill links below
```

Without `just`: `ln -s ~/code/tdo/src/bin.mjs ~/.local/bin/tdo`.

### Agent skill

Link [`skills/tdo`](skills/tdo/SKILL.md) wherever your agent looks for skills:

```sh
ln -s ~/code/tdo/skills/tdo ~/.agents/skills/tdo    # Codex, Pi, and other Agent Skills readers
ln -s ~/code/tdo/skills/tdo ~/.claude/skills/tdo    # Claude Code
```

`just link` does the CLI and both skill links in one go. The skill only shells out to `tdo`, so the CLI must be on `PATH`.

### Pi package

Optional, for the `/tdo` picker and footer; the package bundles the skill too. Add it to `packages` in `~/.pi/agent/settings.json`:

```jsonc
{
  "packages": [
    "git:git@github.com:sfrieds3/tdo@v0"   // tracks the latest 0.x release
  ]
}
```

Use `@v0.2.3` to pin an exact release, or a local path (`"~/code/tdo"`) while hacking on it — then `/reload` picks up your edits.

## Usage

### CLI

| Command | What it does |
|---|---|
| `tdo add <title…> [-p PRIO] [-t TAGS] [-b BODY] [-f PATH[:LINE]]` | Add an item. `!prio` and `#tag` in the title work too. |
| `tdo` | In a terminal with [fzf](https://github.com/junegunn/fzf): [browse and act on items](#browser). Otherwise the same as `tdo ls`. |
| `tdo ls [-a] [-s STATUS] [-t TAGS] [-p PRIO] [-q TEXT] [-n N]` | List items. Defaults to active (`open` + `doing`) in this project. `-a` [groups by project](#all-projects). |
| `tdo show [id]` | Full details, including the body, notes, and issue links. |
| `tdo edit [id] [--title T] [-p PRIO] [-t +add,~remove] [-b BODY] [-f REF]` | Change an item. `~tag` removes a tag (quote it when it comes first: `-t '~old'`; `--tags=-old` also works). With no flags, opens the title and body in `$VISUAL` / `$EDITOR`. |
| `tdo start` / `done` / `drop` / `reopen [id…] [-m NOTE]` | Change status; save the optional note separately from the body. |
| `tdo note [id] <text…>` | Add a note without changing status. |
| `tdo push [id…] [--attach URL \| --force \| --detach]` | [File GitHub issues](#github-issues), recover an uncertain attempt, or remove a local link. |
| `tdo tracker [status\|approve\|revoke] [--yes]` | Inspect tracker settings and manage approval of repository settings. |
| `tdo rm [id]` | Delete an item outright. |
| `tdo pick [-a] [-s STATUS]` | Pick items with fzf and print their refs, for scripting: `tdo done $(tdo pick)`. |
| `tdo count` | One-line summary, e.g. `4 open (1 urgent, 1 high)`. |
| `tdo tags [-a]` · `tdo projects` · `tdo project` | Tag counts, every project, the resolved project key. |
| `tdo export [-a] [--md]` | Dump everything as JSON, or as a Markdown checklist. |
| `tdo migrate [--dry-run]` | Upgrade an older database: back it up, then print which ids changed. |

Item ids are numbered per project, so every repo's backlog starts at `#1`. `3` or `#3` means item 3 in the current project; reach another project with `NAME#3` (`gadgets#3`, when the name is unambiguous), `KEY#3` (`github.com/example/gadgets#3`), or `--project KEY`. Cross-project listings (`ls -a`) show ids as `NAME#3`. An item filed as a GitHub issue also answers to its issue number, `gh#45` (current project), or its full issue URL (any project); tdo ids stay the canonical key, so items keep their number before, during and after filing. In `--json` output, `id` is the per-project number and `projectId` is the project's UUID; together they identify an item.

Leave the id out of `show`, `edit`, `start`, `done`, `drop`, `reopen`, `note`, `push`, or `rm` and tdo opens fzf to pick it (`tab` marks several for the status commands and `push`; `reopen` offers closed items). Add `-a` to pick across projects. Without fzf or a terminal, the id is required.

Global options: `--db TARGET` for a one-off local or SSH database override, `--json` for machine-readable output, `--project KEY` to target another project, `-C DIR` to resolve the project from another directory, `-a` / `--all` to span every project. `add` also takes `--source NAME` (or `TDO_SOURCE`) to record who added the item; it defaults to `cli`.

`tdo project` shows the resolved project key and `tdo paths` shows where the database and config live.

**List limits:** `tdo ls` shows at most 500 matching items by default. `-n N` (or `--limit N`) changes the limit; `-n 0` shows all matching items, with or without `-a`, and there is no hidden 5,000-row ceiling. `ls -a` applies its limit per project (default 5), not globally. When results are omitted, text output includes a dim `… more` notice; `--json` keeps the same array shape and writes a truncation warning to stderr. Exactly filling a limit does not produce a warning unless another matching item exists. Use `-n 0` for a complete list, increase `-n`, or narrow with `-s` / `-q` / `-t`.

`tdo export` always includes every matching item in the current project (all statuses by default); `-a` spans all projects and `-s` selects statuses. Exports, the CLI browser, and CLI fzf pickers have no row limit. Large SSH results can still exceed the transport byte/time bounds described below; that fails explicitly rather than returning a partial export.

`-p` on `ls` means "this priority or more urgent", so `tdo ls -p high` shows urgent and high items. Priorities accept prefixes (`-p u`).

### Notes

Status notes (`tdo done 3 -m "fixed the empty-file case"`) and standalone notes (`tdo note 3 "reproduces only on Linux"`) are stored separately from the item body. `show`, JSON and Markdown exports, and the Pi work hand-off include them. Full-text search covers notes too; replacing the body with `tdo edit -b` does not remove notes. Notes are not included in filed GitHub issue bodies.

### GitHub issues

When Pi's `/tdo` **work on it** hands off an item with a confirmed existing open/closed GitHub link and a valid, approved tracker with issue sync enabled, it asks the agent to include `Closes https://HOST/OWNER/REPO/issues/42` in the resulting PR description. The fully qualified URL comes from the saved link, not the local tdo id or current filing destination, so cross-repository links remain unambiguous. Local tdo ids still never belong in commit messages, PR text, or branch names. Disabled, missing, invalid, unapproved/changed trackers and unlinked, awaiting, pending, creating, unknown, or malformed links produce no issue-closing instruction. Foreign-project picker items also omit the instruction because this checkout cannot verify their repository tracker policy; work from that project's checkout instead. This adds no filing, approval, or GitHub lookup.

This version supports **manual filing, auto-on-tag, and one-way lifecycle sync** (tdo → GitHub). Only selected items become issues. Install and authenticate the [GitHub CLI](https://cli.github.com/) (`gh auth login`) on the machine where you run tdo. With an SSH database, `gh` still runs locally, never through the database helper.

Commit a tracker block in `.tdo/config.json` at the repository root:

```json
{
  "tracker": {
    "provider": "github",
    "repo": "example/widgets",
    "labels": ["backlog"]
  }
}
```

`repo` accepts `OWNER/REPO` or `HOST/OWNER/REPO` (for GitHub Enterprise). Omit it to derive the destination from a `github.com/OWNER/REPO` project key; other project keys require it explicitly. `labels` are added to every filed issue, alongside the item's tags (see [Lifecycle sync](#lifecycle-sync)). Labels missing from the repository are created first; if that fails, nothing is filed and the push can be retried.

```sh
tdo tracker status          # settings, approval, gh health, link and queue counts
tdo tracker approve         # review and approve this repository's settings
tdo push 3                  # file one item
tdo push 4 5                # file several; failures don't stop later items
tdo ls --linked             # list active items with a link record
tdo ls --linked -s all       # include closed local items
tdo done 3 -m "fixed"        # commit locally, then post the note and close the issue
tdo edit 3 --title "new" --no-sync # commit and queue without contacting GitHub
tdo sync                    # drain this project
tdo sync --retry            # explicitly reset operations needing attention
```

Repository settings require **your approval**, saved in your local user config (`config.local.json`). Approval pins the normalized repository settings and resolved destination; changing either requires approval again. An interactive `push` can ask for approval, but scripts must first review `tracker status` and explicitly run `tdo tracker approve --yes`. `tdo tracker revoke` removes approval without deleting existing links or issues. `tracker status` can check `gh` health, but only an explicit `push` creates an issue.

To keep tracker settings private, put them under `projects.<project-key>.tracker` in your [user config](#configuration):

```json
{
  "projects": {
    "github.com/example/widgets": {
      "tracker": {
        "provider": "github",
        "repo": "example/widgets",
        "labels": ["backlog"]
      }
    }
  }
}
```

User settings override individual repository settings; labels replace the whole list. A tracker defined only in your user config needs no approval. Set that project's `"tracker": false` to disable it. Defaults are `mode: "manual"`, `tag: "issue"`, `labels: []`, and `closeOnDone: true`. `closeOnDone` controls close/reopen delivery. `mode: "auto-on-tag"` enables filing when an add or edit leaves the item carrying `tag` (default `#issue`). The item must have been created by a human (TTY plus source `cli`/`user`), the current command must also be human, and the effective tracker must be approved. Otherwise the link is saved as `awaiting-approval`, never created by `sync`; explicitly push it to consent. A human edit does not change an agent-created item’s provenance. Authorized `--no-sync` creates stay `pending` for a later sync. Existing awaiting/error/unknown links are never auto-promoted. Removing the tag does not detach a link.

`tdo ls --awaiting` filters awaiting links (use `-s all` to include closed items). In Pi, the footer counts awaiting items; `/tdo` offers **g Push to GitHub** only for items in the current resolvable project. Filing requires explicit item consent, separately from project config approval. The extension immediately offers consent after verified agent adds/edits that became awaiting, including multiple `tdo add`/`tdo edit` commands joined by `&&` and bash calls nested in codemode. Each prompt names the item and destination; declining keeps it local and awaiting. Verification uses saved database state, not IDs or approval hints in command output, so truncated output or a later failed command does not hide a successfully saved item. The extension also guards bash `tdo push`/`tdo tracker approve` calls with confirmation. Without UI these guarded calls fail closed. Shell recognition is best-effort: complex scripts, expansions, mixed commands, or cwd/database/project overrides do not trigger post-result filing dialogs. Network work runs asynchronously on the caller, never in the database helper.

A new issue contains the title and body, plus the file reference if present, without tdo identifiers or notes. Its labels are the configured `labels` plus the item's tags, except the tracker `tag` itself. Notes written before creation completes are never back-posted. Concurrent edits during creation are reconciled against the current item atomically; already-done/dropped items can be filed and are then closed when `closeOnDone` is true. Pushing an already-filed item returns its existing link rather than creating another issue. Existing links retain their original destination if configuration changes; `tracker status` lists destination and last-synced status mismatches.

#### Lifecycle sync

- Title, body, file-reference and tag edits queue an issue update. Title and body are one-way, last-write-wins: a later tdo edit overwrites GitHub edits. Priority is not synced.
- Tags sync as labels (the tracker `tag` excepted), and missing labels are created in the repository. tdo records which labels it applied and only ever removes those, so labels added on GitHub, and configured `labels`, are left alone. Issues linked with `--attach`, or filed before tag sync, start with no record: tags are added, but nothing is removed until tdo has applied it.
- Notes become separate comments. `done` and `drop` close with reasons `completed` and `not planned`; `reopen` reopens. A status note is posted before its close/reopen operation. With `closeOnDone: false`, notes still post, but close/reopen operations are not enqueued.
- Item changes, notes and delivery intent commit together before any GitHub call. A tracker or SSH delivery failure never rolls back or fails an ordinary local mutation; warnings go to stderr, and `--json` stdout remains one document describing the committed local result.
- Ordinary edit/status/note commands attempt at most five operations in total. `--no-sync` leaves all intent saved for later. `tdo sync [--retry]` drains only the current project, with no five-operation cap, and never auto-retries an unknown create or creates an awaiting-approval item.
- Delivery requires a currently approved effective tracker config. Revoked, changed, invalid or disabled settings leave operations queued. Re-approval allows delivery to each link's persisted destination, even if the newly approved destination differs.
- Cross-project `done`, `drop`, and `reopen` on filed items require a resolvable user-only tracker policy for that project (a repository approval hash alone is not enough). Otherwise the whole selection is refused before any writes: run from its project checkout or configure its project tracker in your user config. The current checkout's `closeOnDone` never applies to foreign items; unlinked items and `start` remain usable across projects.
- Per-link leases serialize drainers; operations keep their sequence across restarts and acknowledgements. Only consecutive, unleased updates coalesce; close/reopen history is preserved. A failed operation blocks the rest of its link but not other links. Crashed drainers' leases expire after 60 seconds.
- Network/timeouts/rate limits are retried by later commands. Permission/auth/not-found failures, or five failed attempts, need attention and block delivery until `tdo sync --retry` explicitly resets them. Fix the cause first; `show` and `tracker status` explain queued/attention counts.
- Updates, close and reopen are idempotent and delivered at least once. **A comment may be posted twice if its response or local acknowledgement is lost.** tdo cannot cancel an already-running GitHub call when a lease expires; stale owners cannot acknowledge or reorder the saved queue.

#### Links and recovery

Lists and browser rows show `↗gh#42` for a filed issue (the `gh` prefix keeps GitHub numbers distinct from tdo ids), `↗…` for queued operations or a pending/in-progress attempt, `↗?` for an awaiting-approval link, and `↗!` for an operation needing attention, an error, or an unknown outcome. `tdo show` includes link details. `--linked` matches any link state, not just successfully filed issues.

An interrupted, timed-out, or unrecognized failed create may have made an issue. tdo records an **unknown** outcome and does not automatically retry it. Check GitHub first:

```sh
tdo push 3 --attach https://github.com/example/widgets/issues/42  # record the existing issue
tdo push 3 --force                                              # only after checking no issue exists
tdo push 3 --detach                                             # remove the local link; leave GitHub untouched
```

`--attach` accepts exactly one item and checks the URL's syntax and destination, not whether the issue exists. `--force` only applies to an unknown or stale interrupted attempt, and can create a duplicate if your check was wrong. Neither attach nor detach can replace an active create attempt. Detaching makes a later plain push eligible to file a new issue, so prefer attach when recovering an existing one. Multi-item `push --json` returns a per-item result array and exits with status 1 if any item failed.

Agents must only push or approve tracker settings when you explicitly ask them to in the current turn. This protects against cooperative agents accidentally filing issues, not adversarial processes: TTY/source provenance can be impersonated and explicit push remains available. Local tdo ids are backlog references, not identifiers to include in commits, PRs, or branch names.

### Browser

Plain `tdo` opens fzf over the backlog with a preview of the highlighted item. Type to filter; `ctrl-n` / `ctrl-p` (or the arrow keys) move the cursor; `tab` marks several items for the status and priority keys.

| Key | Action |
|---|---|
| `enter` | View the item in `$PAGER` |
| `ctrl-e` | Edit title and body in `$VISUAL` / `$EDITOR` |
| `ctrl-s` · `ctrl-d` · `ctrl-x` · `ctrl-r` | Start · done · drop · reopen |
| `alt-up` · `alt-down` | Raise · lower priority |
| `alt-d` | Delete (asks first) |
| `alt-n` | Add the typed query as a new item |
| `ctrl-a` | Toggle all projects |
| `ctrl-t` | Toggle closed items |
| `esc` | Quit |

`tdo browse -a -s all` starts with every project and closed items showing. `TDO_FZF_OPTS` adds fzf flags (e.g. `--height=100%`) on top of `FZF_DEFAULT_OPTS`.

#### Floating browser (tmux and Rex)

Set `"floating": true` in the [config file](#configuration) to open the CLI browser in an 80%-sized tmux popup or [Rex](https://www.superlogical.com/rex) floating pane. This is **off by default**. It applies to plain `tdo` in an interactive terminal and explicit `tdo browse`, not list output, id pickers, or the Pi `/tdo` picker. Inside tmux (including tmux running inside Rex), tdo uses `tmux display-popup`; otherwise, with `REX_SESSION` and `REX_BLOCK`, it uses Rex's floating-layer API in the caller's window. Outside either environment, the browser stays inline.

Requires tmux with `display-popup` and multi-argument command support (tmux 3.3+), or a Rex CLI/server with `session.new_layer` and the terminal shell block flavor. The browser runs on the same host with the caller's working directory, database, project, filters, and browser/editor/SSH settings. Rex launches asynchronously and closes the pane when the browser exits; quick startup failures remain visible for diagnosis. tmux waits for the popup to close. Launcher failures are reported rather than silently falling back (a Rex launch may already have succeeded if the response times out).

Use `tdo --no-float` or `tdo browse --no-float` for an inline browser without changing your config.

### All projects

`tdo ls -a` groups items under a bold project header, most urgent first, and shows the projects with the most urgent work at the top:

```console
$ tdo ls -a
widgets  github.com/example/widgets · 7 items, 3!
  #2  urgent  crash on empty file
  #1  high    fix flaky test  #ci
  #6  high    speed up build
  #4  normal  tidy logs
  #5  normal  doc the api
  … 2 more (tdo ls --project github.com/example/widgets -n 0)

gadgets  github.com/example/gadgets · 1 item
  #1  normal  bump deps
```

It shows 5 items per project; `-n N` changes that for one run (`-n 0` shows everything), and `perProject` in the [config file](#configuration) changes the default. Output is colored on a terminal; `NO_COLOR` turns that off and `FORCE_COLOR` forces it on (e.g. for `less -R`).

```console
$ tdo show 4
#4 crash when settings file is empty
project:  github.com/example/widgets
status:   open
priority: urgent
file:     src/settings.ts:40
created:  2026-11-03 17:21 on laptop via cli

JSON.parse throws on an empty file; treat as {}
```

### Agents

With the skill installed, ask any agent to "park that" or "add it to tdo" and it adds an item with a real title, body, and `file:line`. When it notices a problem outside the current task on its own, it asks first, proposing a title and priority. Before adding, it checks the project's active items for a semantically similar one; if it finds a likely duplicate, it shows the match and asks whether to update that item instead or create a separate one. Asking "what's on the backlog?" lists open items, and it closes items it fixes, with a note.

### Pi

| | |
|---|---|
| `/tdo` | Pick from this project's open items. |
| `/tdo --all` | Pick from every project (`/tdo all` works too). |
| `/tdo fix the flaky test !high #ci` | Quick-add. |

In the picker:

| Key | Action |
|---|---|
| `enter` | **Work on it**: marks it `doing` and hands it to the agent. With `"worktree": true` in the [config file](#configuration), the agent is asked to do the work in a new git worktree (under the main checkout's `.worktrees/`) and branch it names itself. |
| `e` | Edit in the editor: the first line is the title, the rest is the body. |
| `p` | Change priority. |
| `x` | Mark done. |
| `d` | Delete (asks first). |
| `esc` | Close. |

After `e`, `p`, `x`, or `d` the picker reopens, so you can triage several items in a row.

The Pi picker shows at most 200 active items. If more match, its title shows `200+` and a warning points to `tdo ls -n 0` (or `tdo ls -a -n 0` across projects) and the CLI browser for the complete backlog.

The footer shows `☑ 4 (2!) ▸ #3 login test flakes on CI` — open items, how many are urgent or high, and the item this session is working on. The checkbox is the terminal counterpart of the [tdo icon](assets/tdo.svg): a plain Unicode glyph (U+2611), with no Nerd Font or terminal image support required. The focus survives `/reload` and session resume, and clears itself once the item is closed or deleted. It refreshes after each agent run, so items the agent adds or closes through the CLI show up right away. An empty backlog hides the status; a store error shows `☑ unavailable` instead of a stale count.

## How projects are identified

In order, the first that applies:

1. `TDO_PROJECT` environment variable, or `--project KEY`.
2. The `project` string in `.tdo/config.json` at the repo root — a committed project key, which can sit alongside tracker settings.
3. The first line of a `.tdo-project` file at the repo root (legacy fallback).
4. The git remote (`origin`, else the first remote), normalized: `git@github.com:Owner/repo.git` and `https://github.com/Owner/repo` both become `github.com/Owner/repo`.
5. No remote: `local:~/path/to/repo` (home-relative, so it matches across machines with the same layout).

The result then goes through `aliases` in the [config file](#configuration), so a fork can share its upstream's backlog without touching the repo. Run `tdo project` to see what the current directory resolves to.

## Storage

The database lives at `$XDG_DATA_HOME/tdo/tdo.db` — `~/.local/share/tdo/tdo.db` by default, on macOS too. Set `db` in the config file or `TDO_DB` to put it elsewhere. It is plain SQLite in WAL mode, so `sqlite3 ~/.local/share/tdo/tdo.db` works for ad-hoc queries.

Schema: `projects` has a UUID `id` and the project `key`; `items` is keyed by `(project_id, id)`, where `id` is the per-project number; `tags`, `notes`, and `links` reference that pair. Full-text search lives in `items_fts`, kept in sync by triggers and covering notes as well as titles and bodies. Schema v3 includes `link_ops`, which stores the durable lifecycle queue; item edits, notes, and status transitions enqueue operations atomically with the local change. Schema v4 adds `links.labels`, the labels tdo applied to each issue.

### Upgrading for notes and GitHub issues

**Compatibility break:** this release uses schema v4 and SSH RPC v6. Update tdo on both the caller and database host to the same release before using an SSH database. Old helpers fail the protocol check; after updating the helper, an existing older remote database still requires an explicit `tdo migrate`. Local databases upgrade automatically on open, with a backup; use the commands below to preview first:

```sh
tdo migrate --dry-run
tdo migrate
# For a remote database, use its configured target or pass --db to both commands.
```

The v2→v3 migration preserves per-project ids, creates note/link tables, and rebuilds full-text search. It extracts recognized trailing legacy status-note blocks from item bodies into notes, leaving the remaining body intact. The dry-run reports how many notes would move. Notes now appear separately in item JSON (`notes`) rather than being appended to `body`; item JSON also includes `links`. The database records whether an item was created by a human for future auto-filing safeguards. The v3→v4 migration only adds the `links.labels` column; existing links start with no label record.

Backups are created beside the database on the machine storing it. To roll back, restore the pre-upgrade backup and use the older tdo release; older versions cannot read schema v3 or v4. Do not point an older caller at the upgraded database.

### Upgrading from 0.1.x

0.1.x numbered items globally; now each project counts from `#1`, so existing items get new ids. Any tdo command upgrades the database automatically, but running it by hand first shows what changes:

```sh
tdo migrate --dry-run   # preview: schema version and every id that changes
tdo migrate             # back up to tdo.db.v1-backup-<timestamp>, upgrade, print the id changes
```

Items are renumbered per project in their original order, so the oldest item in each project becomes `#1`. Tags, bodies, statuses, and timestamps carry over. To undo, replace `tdo.db` with the backup (and use a 0.1.x tdo).

**Sharing across machines:** don't sync the database file with Dropbox, Syncthing, or a network mount while more than one machine writes to it — SQLite files corrupt or fork that way. Keep the database on one host and use SSH remote mode instead. `tdo export` is also a safe way to move or back up items.

### SSH remote database

Install a compatible version of `tdo` and Node 22.18+ on the server. The remote noninteractive shell must find `tdo` on `PATH`; use the same tdo release on both ends. Unlimited list/export support was introduced in RPC protocol v2, structured notes and issue filing in v3, lifecycle queues in v4, consent-aware automatic filing in v5, and tag/label sync in v6. This release requires v6: upgrade both ends together. Older helpers are rejected rather than allowed to silently apply the old row ceiling. Configure SSH keys/agent, host keys, and any jump hosts with your normal SSH setup first. No daemon, database file synchronization, or network-mounted SQLite file is needed.

```sh
tdo db use 'ssh://you@backlog-host/home/you/.local/share/tdo/tdo.db'
tdo db check
tdo add 'shared across my machines #infra'
tdo --db /tmp/scratch-tdo.db ls       # one command only
tdo db use /home/you/.local/share/tdo/tdo.db  # return to a local database
```

Targets are local file paths or `ssh://[user@]host[:port]/absolute/path` URIs. SSH config host aliases and bracketed IPv6 addresses work. Percent-encode reserved characters in paths (`%20` for a space, `%23` for `#`); paths are decoded exactly once. Passwords, query strings, fragments, malformed hosts/users/ports, and other URI schemes are rejected. Remote `~` expansion is not supported: supply an absolute path.

Selection order is **`--db` > `TDO_DB` > config `db` > the default local path**. `tdo db use <target>` checks the target and schema before atomically saving it to the local config, preserving aliases and unknown keys. An existing `TDO_DB` still overrides that saved choice. `tdo paths` reports the selected target without contacting it; `tdo db check` connects and checks schema compatibility. Fresh databases are initialized automatically. `db use` trims the target, expands local `~/` paths, and saves relative local paths as absolute paths so the checked database stays selected when you change directories. One-off relative paths retain their usual cwd-relative meaning.

Existing remote databases on older schemas require an explicit migration; ordinary commands never silently upgrade them. To preview and upgrade before saving a target:

```sh
tdo --db 'ssh://backlog-host/absolute/path/tdo.db' migrate --dry-run
tdo --db 'ssh://backlog-host/absolute/path/tdo.db' migrate
tdo db use 'ssh://backlog-host/absolute/path/tdo.db'
```

Migration backups are made next to the database **on the server**, and the returned backup path is a server path. Local databases retain automatic migration behavior. Project identity, aliases, source, session, and host metadata are resolved by the caller, not by the server's checkout or configuration.

**Security and offline behavior:** each operation runs the fixed command `tdo internal-rpc` through system OpenSSH, with a versioned, validated JSON protocol over stdin/stdout. Paths, titles, and other user text are data, never interpolated into the remote shell command. There is no arbitrary SQL endpoint. The helper accepts only explicit absolute local database paths and ignores server-side tdo config and project resolution. It is an internal transport, not an authorization sandbox: an SSH account must be trusted and has its normal filesystem permissions. OpenSSH config, agent, and host-key checks remain in effect; batch mode disables interactive authentication prompts. Connections have an 8-second connect timeout, a 20-second overall operation timeout, and an 8 MiB request/output bound. Shell startup must not write noise to stdout.

When offline or authentication fails, commands fail clearly: there is **no retry, local fallback, offline cache, or queued write**. A disconnected/timed-out write may already have committed; inspect the server before retrying. Every operation uses a new SSH process (normal SSH multiplexing configuration may reuse connections). Bulk CLI commands can issue multiple independent operations, not one cross-operation transaction.

## Configuration

Everything works without a config file. To change defaults, create `$XDG_CONFIG_HOME/tdo/config.json` (`~/.config/tdo/config.json`), or point `TDO_CONFIG` at another file:

```json
{
  "db": "~/.local/share/tdo/tdo.db",
  "perProject": 10,
  "floating": true,
  "worktree": true,
  "issueIds": true,
  "aliases": {
    "github.com/me/widgets": "github.com/example/widgets"
  }
}
```

| Key | Meaning |
|---|---|
| `db` | Local database path (`~` expands) or SSH URI. `TDO_DB` and `--db` win over it. |
| `perProject` | Items per project in `tdo ls -a` (default 5; 0 shows all). |
| `floating` | Open the CLI browser in a tmux popup or Rex floating pane when available (default `false`). `--no-float` overrides it. |
| `worktree` | Pi `/tdo` "work on it" asks the agent to work in a new git worktree and branch, which it names (default `false`). |
| `issueIds` | List rows of filed items lead with the issue ref (`gh#45  normal  title  #3`) instead of the tdo id; unfiled items are unchanged (default `false`). Override per project with `projects.KEY.issueIds`. |
| `aliases` | Maps a resolved project key to the key to use instead — e.g. your fork to its upstream, so both share one backlog. |
| `projects` | Per-project settings, keyed by the resolved project key. `tracker` overrides repository tracker settings, or `false` disables filing; `issueIds` overrides the global setting. See [GitHub issues](#github-issues). |

**Machine-local overrides:** a `config.local.json` next to the config file (`~/.config/tdo/config.local.json`, or `c.local.json` beside `TDO_CONFIG=c.json`) is merged over it, so you can keep `config.json` in your dotfiles and put per-machine settings such as `db` in the local file. Objects (`aliases`, `projects`, and their entries) merge key by key; any other value, including arrays and `tracker: false`, replaces the main file's. Each file is validated on its own, and errors name the file at fault. Tracker approvals (`tdo tracker approve`, Pi's approval prompt) are machine state and always go to `config.local.json`; `tdo tracker revoke` removes the approval from the local file and also clears any older approval left in `config.json`. `tdo db use` writes `config.json`, unless the local file already sets `db`, in which case it updates the local file so the saved choice takes effect. Writes follow symlinks, so a stow-managed config stays a link. `tdo paths` shows both locations.

Repository config is separate: `.tdo/config.json` accepts `project` and `tracker`, not user settings such as `db`. A malformed repository file or invalid `project` fails project resolution; an invalid tracker block is reported by tracker commands without blocking ordinary backlog commands.

Environment variables: `TDO_DB`, `TDO_CONFIG`, `TDO_PROJECT` (force a project key), `TDO_SOURCE` (default `--source`), `TDO_FZF_OPTS` (extra fzf flags), `NO_COLOR` / `FORCE_COLOR`.

## Release automation

Release-please maintains a release PR after changes land on `main`. GitHub may require approval before running CI on that bot-created PR. Approve the workflow run and wait for the checks to pass before merging when you are ready to release; there is no separate automatic release-PR CI bypass.

Merging the release PR publishes the release, updates floating tags, and attaches the package tarball. This workflow does not enforce pre-merge approval or passing checks itself; those requirements depend on repository branch protection.

## Development

```sh
pnpm install     # dev dependencies (TypeScript, Pi peers for tests)
just check       # type-check + tests
```

Layout: [`src/core.ts`](src/core.ts) holds queries, paths, config, and project resolution; [`src/migrations/`](src/migrations/) owns the schema and migrations; [`src/store.ts`](src/store.ts) provides operation-level local/SSH stores and the internal RPC protocol; [`src/cli.ts`](src/cli.ts) and [`extensions/tdo.ts`](extensions/tdo.ts) are front-ends. `openDb` remains local-only. `createStore(target, { env })` exposes synchronous `call(operation, ...args)` and `close()` for the CLI; `createAsyncStore(target, { env })` has the same typed operations with Promise results and nonblocking SSH for hosts such as Pi. Operations include CRUD/lookups, list/search, counts, tags, projects, schema checking, and migration; exports format `listItems` results. Tests use a fake `ssh` executable invoking the real helper against isolated local files, never live network connections. The agent skill is [`skills/tdo/SKILL.md`](skills/tdo/SKILL.md), and a test checks that every command it documents exists. Tests live in [`tests/`](tests).

### Adding a schema migration

Historical migrations are immutable: do not edit [`src/migrations/v2.ts`](src/migrations/v2.ts), [`src/migrations/v3.ts`](src/migrations/v3.ts), or [`src/migrations/v4.ts`](src/migrations/v4.ts), or make them depend on current application helpers. For v5, add a self-contained `src/migrations/v5.ts` conversion, register a `4 -> 5` step in [`src/migrations/index.ts`](src/migrations/index.ts), and bump `SCHEMA` there to 5. Keep the earlier steps: fresh and old databases then follow the same chain (`0 -> 2 -> 3 -> 4 -> 5`, `1 -> 2 -> 3 -> 4 -> 5`). Steps run inside one `BEGIN IMMEDIATE` transaction; the runner updates `user_version` after each step and takes one pre-upgrade backup for an existing file. Steps must not commit, start transactions, or set `user_version`. Add tests for the new conversion, fresh/upgraded schema equivalence, and rollback of the whole chain on failure, then run `pnpm check`. Local upgrades remain automatic; older remote databases still require `tdo migrate` explicitly.

Commits and PR titles follow [Conventional Commits](https://www.conventionalcommits.org/). [release-please](https://github.com/googleapis/release-please) turns them into a release PR with a changelog; merging it tags the release, moves the `vMAJOR` / `vMAJOR.MINOR` tags, and attaches an npm tarball.

## License

[MIT](LICENSE)
