# tdo

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
- **Search.** Full-text search over titles and bodies, plus filters by tag, priority, and status.
- **Works with any agent.** One skill teaches agents when to park, how to write an item a future session can act on, and to ask before logging what they found themselves. Every command takes `--json`, and items record which agent added them.
- **Just SQLite, local or over SSH.** One file under `$XDG_DATA_HOME`, built-in `node:sqlite`, zero runtime dependencies. Keep it on one host and access it with your existing SSH config and agent.

## Install

Requires **Node 22.18+** (it runs its TypeScript directly via Node's type stripping).

### CLI

```sh
git clone git@github.com:sfrieds3/tdo.git ~/code/tdo
cd ~/code/tdo && just link        # ~/.local/bin/tdo -> src/cli.ts, plus the skill links below
```

Without `just`: `ln -s ~/code/tdo/src/cli.ts ~/.local/bin/tdo`.

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
| `tdo show [id]` | Full details, including the body. |
| `tdo edit [id] [--title T] [-p PRIO] [-t +add,~remove] [-b BODY] [-f REF]` | Change an item. `~tag` removes a tag (quote it when it comes first: `-t '~old'`; `--tags=-old` also works). With no flags, opens the title and body in `$VISUAL` / `$EDITOR`. |
| `tdo start` / `done` / `drop` / `reopen [id…] [-m NOTE]` | Change status; the note is appended to the body. |
| `tdo rm [id]` | Delete an item outright. |
| `tdo pick [-a] [-s STATUS]` | Pick items with fzf and print their refs, for scripting: `tdo done $(tdo pick)`. |

| `tdo count` | One-line summary, e.g. `4 open (1 urgent, 1 high)`. |
| `tdo tags [-a]` · `tdo projects` · `tdo project` | Tag counts, every project, the resolved project key. |
| `tdo export [-a] [--md]` | Dump everything as JSON, or as a Markdown checklist. |
| `tdo migrate [--dry-run]` | Upgrade an older database: back it up, then print which ids changed. |

Item ids are numbered per project, so every repo's backlog starts at `#1`. `3` or `#3` means item 3 in the current project; reach another project with `NAME#3` (`gadgets#3`, when the name is unambiguous), `KEY#3` (`github.com/example/gadgets#3`), or `--project KEY`. Cross-project listings (`ls -a`) show ids as `NAME#3`. In `--json` output, `id` is the per-project number and `projectId` is the project's UUID; together they identify an item.

Leave the id out of `show`, `edit`, `start`, `done`, `drop`, `reopen`, or `rm` and tdo opens fzf to pick it (`tab` marks several for the status commands; `reopen` offers closed items). Add `-a` to pick across projects. Without fzf or a terminal, the id is required.

Global options: `--db TARGET` for a one-off local or SSH database override, `--json` for machine-readable output, `--project KEY` to target another project, `-C DIR` to resolve the project from another directory, `-a` / `--all` to span every project. `add` also takes `--source NAME` (or `TDO_SOURCE`) to record who added the item; it defaults to `cli`.

`tdo project` shows the resolved project key and `tdo paths` shows where the database and config live.

`-p` on `ls` means "this priority or more urgent", so `tdo ls -p high` shows urgent and high items. Priorities accept prefixes (`-p u`).

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
  … 2 more (tdo ls --project github.com/example/widgets)

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

With the skill installed, ask any agent to "park that" or "add it to tdo" and it adds an item with a real title, body, and `file:line`. When it notices a problem outside the current task on its own, it asks first, proposing a title and priority. Asking "what's on the backlog?" lists open items, and it closes items it fixes, with a note.

### Pi

| | |
|---|---|
| `/tdo` | Pick from this project's open items. |
| `/tdo --all` | Pick from every project (`/tdo all` works too). |
| `/tdo fix the flaky test !high #ci` | Quick-add. |

In the picker:

| Key | Action |
|---|---|
| `enter` | **Work on it**: marks it `doing` and hands it to the agent. With `"worktree": true` in the [config file](#configuration), the agent is asked to do the work in a new git worktree and branch it names itself. |
| `e` | Edit in the editor: the first line is the title, the rest is the body. |
| `p` | Change priority. |
| `x` | Mark done. |
| `d` | Delete (asks first). |
| `esc` | Close. |

After `e`, `p`, `x`, or `d` the picker reopens, so you can triage several items in a row.

The footer shows `tdo 4 (2!) ▸ #3 login test flakes on CI` — open items, how many are urgent or high, and the item this session is working on. The focus survives `/reload` and session resume, and clears itself once the item is closed or deleted. It refreshes after each agent run, so items the agent adds or closes through the CLI show up right away.

## How projects are identified

In order, the first that applies:

1. `TDO_PROJECT` environment variable, or `--project KEY`.
2. The first line of a `.tdo-project` file at the repo root — handy for monorepo subprojects, or committing a key the whole team shares.
3. The git remote (`origin`, else the first remote), normalized: `git@github.com:Owner/repo.git` and `https://github.com/Owner/repo` both become `github.com/Owner/repo`.
4. No remote: `local:~/path/to/repo` (home-relative, so it matches across machines with the same layout).

The result then goes through `aliases` in the [config file](#configuration), so a fork can share its upstream's backlog without touching the repo. Run `tdo project` to see what the current directory resolves to.

## Storage

The database lives at `$XDG_DATA_HOME/tdo/tdo.db` — `~/.local/share/tdo/tdo.db` by default, on macOS too. Set `db` in the config file or `TDO_DB` to put it elsewhere. It is plain SQLite in WAL mode, so `sqlite3 ~/.local/share/tdo/tdo.db` works for ad-hoc queries.

Schema: `projects` has a UUID `id` and the project `key`; `items` is keyed by `(project_id, id)`, where `id` is the per-project number; `tags` references that pair. Full-text search lives in `items_fts`, kept in sync by triggers.

### Upgrading from 0.1.x

0.1.x numbered items globally; now each project counts from `#1`, so existing items get new ids. Any tdo command upgrades the database automatically, but running it by hand first shows what changes:

```sh
tdo migrate --dry-run   # preview: schema version and every id that changes
tdo migrate             # back up to tdo.db.v1-backup-<timestamp>, upgrade, print the id changes
```

Items are renumbered per project in their original order, so the oldest item in each project becomes `#1`. Tags, bodies, statuses, and timestamps carry over. To undo, replace `tdo.db` with the backup (and use a 0.1.x tdo).

**Sharing across machines:** don't sync the database file with Dropbox, Syncthing, or a network mount while more than one machine writes to it — SQLite files corrupt or fork that way. Keep the database on one host and use SSH remote mode instead. `tdo export` is also a safe way to move or back up items.

### SSH remote database

Install a compatible version of `tdo` and Node 22.18+ on the server. The remote noninteractive shell must find `tdo` on `PATH`; use the same tdo release on both ends. Configure SSH keys/agent, host keys, and any jump hosts with your normal SSH setup first. No daemon, database file synchronization, or network-mounted SQLite file is needed.

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
| `aliases` | Maps a resolved project key to the key to use instead — e.g. your fork to its upstream, so both share one backlog. |

Environment variables: `TDO_DB`, `TDO_CONFIG`, `TDO_PROJECT` (force a project key), `TDO_SOURCE` (default `--source`), `TDO_FZF_OPTS` (extra fzf flags), `NO_COLOR` / `FORCE_COLOR`.

## Development

```sh
pnpm install     # dev dependencies (TypeScript, Pi peers for tests)
just check       # type-check + tests
```

Layout: [`src/core.ts`](src/core.ts) holds the schema, queries, paths, config, and project resolution; [`src/store.ts`](src/store.ts) provides operation-level local/SSH stores and the internal RPC protocol; [`src/cli.ts`](src/cli.ts) and [`extensions/tdo.ts`](extensions/tdo.ts) are front-ends. `openDb` remains local-only. `createStore(target, { env })` exposes synchronous `call(operation, ...args)` and `close()` for the CLI; `createAsyncStore(target, { env })` has the same typed operations with Promise results and nonblocking SSH for hosts such as Pi. Operations include CRUD/lookups, list/search, counts, tags, projects, schema checking, and migration; exports format `listItems` results. Tests use a fake `ssh` executable invoking the real helper against isolated local files, never live network connections. The agent skill is [`skills/tdo/SKILL.md`](skills/tdo/SKILL.md), and a test checks that every command it documents exists. Tests live in [`tests/`](tests).

Commits and PR titles follow [Conventional Commits](https://www.conventionalcommits.org/). [release-please](https://github.com/googleapis/release-please) turns them into a release PR with a changelog; merging it tags the release, moves the `vMAJOR` / `vMAJOR.MINOR` tags, and attaches an npm tarball.

## License

[MIT](LICENSE)
