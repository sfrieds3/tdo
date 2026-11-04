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
- **Just SQLite.** One file under `$XDG_DATA_HOME`, built-in `node:sqlite`, zero runtime dependencies.

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
| `tdo edit [id] [--title T] [-p PRIO] [-t +add,-remove] [-b BODY] [-f REF]` | Change an item. With no flags, opens the title and body in `$VISUAL` / `$EDITOR`. |
| `tdo start` / `done` / `drop` / `reopen [id…] [-m NOTE]` | Change status; the note is appended to the body. |
| `tdo rm [id]` | Delete an item outright. |
| `tdo pick [-a] [-s STATUS]` | Pick items with fzf and print their refs, for scripting: `tdo done $(tdo pick)`. |

| `tdo count` | One-line summary, e.g. `4 open (1 urgent, 1 high)`. |
| `tdo tags [-a]` · `tdo projects` · `tdo project` | Tag counts, every project, the resolved project key. |
| `tdo export [-a] [--md]` | Dump everything as JSON, or as a Markdown checklist. |
| `tdo migrate [--dry-run]` | Upgrade an older database: back it up, then print which ids changed. |

Item ids are numbered per project, so every repo's backlog starts at `#1`. `3` or `#3` means item 3 in the current project; reach another project with `NAME#3` (`gadgets#3`, when the name is unambiguous), `KEY#3` (`github.com/example/gadgets#3`), or `--project KEY`. Cross-project listings (`ls -a`) show ids as `NAME#3`. In `--json` output, `id` is the per-project number and `projectId` is the project's UUID; together they identify an item.

Leave the id out of `show`, `edit`, `start`, `done`, `drop`, `reopen`, or `rm` and tdo opens fzf to pick it (`tab` marks several for the status commands; `reopen` offers closed items). Add `-a` to pick across projects. Without fzf or a terminal, the id is required.

Global options: `--json` for machine-readable output, `--project KEY` to target another project, `-C DIR` to resolve the project from another directory, `-a` / `--all` to span every project. `add` also takes `--source NAME` (or `TDO_SOURCE`) to record who added the item; it defaults to `cli`.

`tdo project` shows the resolved project key and `tdo paths` shows where the database and config live.

`-p` on `ls` means "this priority or more urgent", so `tdo ls -p high` shows urgent and high items. Priorities accept prefixes (`-p u`).

### Browser

Plain `tdo` opens fzf over the backlog with a preview of the highlighted item. Type to filter; `tab` marks several items for the status and priority keys.

| Key | Action |
|---|---|
| `enter` | View the item in `$PAGER` |
| `ctrl-e` | Edit title and body in `$VISUAL` / `$EDITOR` |
| `ctrl-s` · `ctrl-d` · `ctrl-x` · `ctrl-r` | Start · done · drop · reopen |
| `alt-up` · `alt-down` | Raise · lower priority |
| `alt-d` | Delete (asks first) |
| `ctrl-n` | Add the typed query as a new item |
| `ctrl-a` | Toggle all projects |
| `ctrl-t` | Toggle closed items |
| `esc` | Quit |

`tdo browse -a -s all` starts with every project and closed items showing. `TDO_FZF_OPTS` adds fzf flags (e.g. `--height=100%`) on top of `FZF_DEFAULT_OPTS`.

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
| `enter` | **Work on it**: marks it `doing` and hands it to the agent. |
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

**Sharing across machines:** don't sync the database file with Dropbox, Syncthing, or a network mount while more than one machine writes to it — SQLite files corrupt or fork that way. Keep the database on one host instead. A built-in ssh remote mode is planned; until then, `tdo export` is a safe way to move or back up items.

## Configuration

Everything works without a config file. To change defaults, create `$XDG_CONFIG_HOME/tdo/config.json` (`~/.config/tdo/config.json`), or point `TDO_CONFIG` at another file:

```json
{
  "db": "~/Sync/tdo/tdo.db",
  "perProject": 10,
  "aliases": {
    "github.com/me/widgets": "github.com/example/widgets"
  }
}
```

| Key | Meaning |
|---|---|
| `db` | Database path (`~` expands). `TDO_DB` wins over it. |
| `perProject` | Items per project in `tdo ls -a` (default 5; 0 shows all). |
| `aliases` | Maps a resolved project key to the key to use instead — e.g. your fork to its upstream, so both share one backlog. |

Environment variables: `TDO_DB`, `TDO_CONFIG`, `TDO_PROJECT` (force a project key), `TDO_SOURCE` (default `--source`), `TDO_FZF_OPTS` (extra fzf flags), `NO_COLOR` / `FORCE_COLOR`.

## Development

```sh
pnpm install     # dev dependencies (TypeScript, Pi peers for tests)
just check       # type-check + tests
```

Layout: [`src/core.ts`](src/core.ts) holds the schema, queries, paths, config, and project resolution; [`src/cli.ts`](src/cli.ts) and [`extensions/tdo.ts`](extensions/tdo.ts) are thin front-ends over it. The agent skill is [`skills/tdo/SKILL.md`](skills/tdo/SKILL.md), and a test checks that every command it documents exists. Tests live in [`tests/`](tests).

Commits and PR titles follow [Conventional Commits](https://www.conventionalcommits.org/). [release-please](https://github.com/googleapis/release-please) turns them into a release PR with a changelog; merging it tags the release, moves the `vMAJOR` / `vMAJOR.MINOR` tags, and attaches an npm tarball.

## License

[MIT](LICENSE)
