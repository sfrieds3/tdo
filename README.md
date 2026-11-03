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

It is also a [Pi](https://pi.dev) package: the coding agent gets a `tdo` tool and you get a `/tdo` command, so out-of-scope issues found mid-session get parked instead of derailing the task.

## Features

- **Scoped to the project, not the path.** Items are keyed by the repo's git remote (`github.com/owner/repo`), so a clone in `~/code` on your laptop and one in `/home/you/src` on a server share a backlog. Worktrees share their main checkout's backlog.
- **Priorities and tags.** `urgent`, `high`, `normal`, `low`, plus free-form tags. Inline shorthand — `!high #ci` — works anywhere you type a title.
- **Context that survives.** Each item can carry a body (the why, a repro), a `path:line`, and records where it came from: CLI, you in Pi, or the agent, with the session and host.
- **Search.** Full-text search over titles and bodies, plus filters by tag, priority, and status.
- **Agent-friendly.** Every command takes `--json`. The Pi tool asks before parking something it found on its own.
- **Just SQLite.** One file, built-in `node:sqlite`, zero runtime dependencies.

## Install

Requires **Node 22.18+** (it runs its TypeScript directly via Node's type stripping).

### CLI

```sh
git clone git@github.com:sfrieds3/tdo.git ~/code/tdo
cd ~/code/tdo && just link        # symlinks ~/.local/bin/tdo -> src/cli.ts
```

Without `just`: `ln -s ~/code/tdo/src/cli.ts ~/.local/bin/tdo`.

### Pi package

Add it to `packages` in `~/.pi/agent/settings.json`:

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
| `tdo ls [-a] [-s STATUS] [-t TAGS] [-p PRIO] [-q TEXT] [-n N]` | List items. Defaults to active (`open` + `doing`) in this project. |
| `tdo show <id>` | Full details, including the body. |
| `tdo edit <id> [--title T] [-p PRIO] [-t +add,-remove] [-b BODY] [-f REF]` | Change an item. |
| `tdo start` / `done` / `drop` / `reopen <id>… [-m NOTE]` | Change status; the note is appended to the body. |
| `tdo rm <id>` | Delete an item outright. |
| `tdo count` | One-line summary, e.g. `4 open (1 urgent, 1 high)`. |
| `tdo tags [-a]` · `tdo projects` · `tdo project` | Tag counts, every project, the resolved project key. |
| `tdo export [-a] [--md]` | Dump everything as JSON, or as a Markdown checklist. |

Global options: `--json` for machine-readable output, `--project KEY` to target another project, `-C DIR` to resolve the project from another directory, `-a` / `--all` to span every project.

`-p` on `ls` means "this priority or more urgent", so `tdo ls -p high` shows urgent and high items. Priorities accept prefixes (`-p u`).

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

### Pi

| | |
|---|---|
| `/tdo` | Browse open items. Pick one to **work on it now** (marks it `doing` and hands it to the agent), change its priority, or close it. |
| `/tdo fix the flaky test !high #ci` | Quick-add. |
| `/tdo done 3 [note]` | Also `start`, `drop`, `reopen`, `show`. |
| `/tdo all` | Browse every project. |

The footer shows `tdo 4 (2!)` — open items, and how many are urgent or high.

The agent's `tdo` tool can list, search, add, update, and close items. When it notices a real problem outside the current task, it asks before parking it, with a proposed title and priority. Ask it to "park that" or "add it to tdo" and it adds without asking again.

## How projects are identified

In order, the first that applies:

1. `TDO_PROJECT` environment variable, or `--project KEY`.
2. The first line of `.pi/tdo-project` at the repo root — handy for forks that should share upstream's backlog, or monorepo subprojects.
3. The git remote (`origin`, else the first remote), normalized: `git@github.com:Owner/repo.git` and `https://github.com/Owner/repo` both become `github.com/Owner/repo`.
4. No remote: `local:~/path/to/repo` (home-relative, so it matches across machines with the same layout).

Run `tdo project` to see what the current directory resolves to.

## Storage

The database lives at `~/.pi/state/tdo.db` (or `$PI_STATE_DIR/tdo.db`); set `TDO_DB` to put it anywhere. It is plain SQLite in WAL mode, so `sqlite3 ~/.pi/state/tdo.db` works for ad-hoc queries, and the schema upgrades itself.

**Sharing across machines:** don't sync the database file with Dropbox, Syncthing, or a network mount while more than one machine writes to it — SQLite files corrupt or fork that way. Keep the database on one host instead. A built-in ssh remote mode is planned; until then, `tdo export` is a safe way to move or back up items.

## Development

```sh
pnpm install     # dev dependencies (TypeScript, Pi peers for tests)
just check       # type-check + tests
```

Layout: [`src/core.ts`](src/core.ts) holds the schema, queries, and project resolution; [`src/cli.ts`](src/cli.ts) and [`extensions/tdo.ts`](extensions/tdo.ts) are thin front-ends over it. Tests live in [`tests/`](tests).

Commits and PR titles follow [Conventional Commits](https://www.conventionalcommits.org/). [release-please](https://github.com/googleapis/release-please) turns them into a release PR with a changelog; merging it tags the release, moves the `vMAJOR` / `vMAJOR.MINOR` tags, and attaches an npm tarball.

## License

[MIT](LICENSE)
