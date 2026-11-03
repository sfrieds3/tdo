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

It ships with an [agent skill](skills/tdo/SKILL.md), so Claude Code, Codex, Pi, or any agent that reads `SKILL.md` files can park the issues it trips over mid-task — after asking you — instead of derailing the work. And it's a [Pi](https://pi.dev) package with a `/tdo` command and a footer count.

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

Optional, for the `/tdo` command and footer count; the package bundles the skill too. Add it to `packages` in `~/.pi/agent/settings.json`:

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

Global options: `--json` for machine-readable output, `--project KEY` to target another project, `-C DIR` to resolve the project from another directory, `-a` / `--all` to span every project. `add` also takes `--source NAME` (or `TDO_SOURCE`) to record who added the item; it defaults to `cli`.

`tdo project` shows the resolved project key and `tdo paths` shows where the database and config live.

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

### Agents

With the skill installed, ask any agent to "park that" or "add it to tdo" and it adds an item with a real title, body, and `file:line`. When it notices a problem outside the current task on its own, it asks first, proposing a title and priority. Asking "what's on the backlog?" lists open items, and it closes items it fixes, with a note.

### Pi

| | |
|---|---|
| `/tdo` | Browse open items. Pick one to **work on it now** (marks it `doing` and hands it to the agent), change its priority, or close it. |
| `/tdo fix the flaky test !high #ci` | Quick-add. |
| `/tdo done 3 [note]` | Also `start`, `drop`, `reopen`, `show`. |
| `/tdo all` | Browse every project. |

The footer shows `tdo 4 (2!)` — open items, and how many are urgent or high. It refreshes after each agent run, so items the agent adds through the CLI show up right away.

## How projects are identified

In order, the first that applies:

1. `TDO_PROJECT` environment variable, or `--project KEY`.
2. The first line of a `.tdo-project` file at the repo root — handy for monorepo subprojects, or committing a key the whole team shares.
3. The git remote (`origin`, else the first remote), normalized: `git@github.com:Owner/repo.git` and `https://github.com/Owner/repo` both become `github.com/Owner/repo`.
4. No remote: `local:~/path/to/repo` (home-relative, so it matches across machines with the same layout).

The result then goes through `aliases` in the [config file](#configuration), so a fork can share its upstream's backlog without touching the repo. Run `tdo project` to see what the current directory resolves to.

## Storage

The database lives at `$XDG_DATA_HOME/tdo/tdo.db` — `~/.local/share/tdo/tdo.db` by default, on macOS too. Set `db` in the config file or `TDO_DB` to put it elsewhere. It is plain SQLite in WAL mode, so `sqlite3 ~/.local/share/tdo/tdo.db` works for ad-hoc queries, and the schema upgrades itself.

**Sharing across machines:** don't sync the database file with Dropbox, Syncthing, or a network mount while more than one machine writes to it — SQLite files corrupt or fork that way. Keep the database on one host instead. A built-in ssh remote mode is planned; until then, `tdo export` is a safe way to move or back up items.

## Configuration

Everything works without a config file. To change defaults, create `$XDG_CONFIG_HOME/tdo/config.json` (`~/.config/tdo/config.json`), or point `TDO_CONFIG` at another file:

```json
{
  "db": "~/Sync/tdo/tdo.db",
  "aliases": {
    "github.com/me/widgets": "github.com/example/widgets"
  }
}
```

| Key | Meaning |
|---|---|
| `db` | Database path (`~` expands). `TDO_DB` wins over it. |
| `aliases` | Maps a resolved project key to the key to use instead — e.g. your fork to its upstream, so both share one backlog. |

Environment variables: `TDO_DB`, `TDO_CONFIG`, `TDO_PROJECT` (force a project key), `TDO_SOURCE` (default `--source`).

## Development

```sh
pnpm install     # dev dependencies (TypeScript, Pi peers for tests)
just check       # type-check + tests
```

Layout: [`src/core.ts`](src/core.ts) holds the schema, queries, paths, config, and project resolution; [`src/cli.ts`](src/cli.ts) and [`extensions/tdo.ts`](extensions/tdo.ts) are thin front-ends over it. The agent skill is [`skills/tdo/SKILL.md`](skills/tdo/SKILL.md), and a test checks that every command it documents exists. Tests live in [`tests/`](tests).

Commits and PR titles follow [Conventional Commits](https://www.conventionalcommits.org/). [release-please](https://github.com/googleapis/release-please) turns them into a release PR with a changelog; merging it tags the release, moves the `vMAJOR` / `vMAJOR.MINOR` tags, and attaches an npm tarball.

## License

[MIT](LICENSE)
