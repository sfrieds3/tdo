# Changelog

## [0.3.0](https://github.com/sfrieds3/tdo/compare/v0.2.0...v0.3.0) (2026-11-05)


### ⚠ BREAKING CHANGES

* per-project item ids and /tdo picker actions ([#4](https://github.com/sfrieds3/tdo/issues/4))

### Features

* fzf browser, fzf pickers, and grouped ls -a ([#6](https://github.com/sfrieds3/tdo/issues/6)) ([520b159](https://github.com/sfrieds3/tdo/commit/520b159773db0689f48d56fc69faf9bde9bd263c))
* per-project item ids and /tdo picker actions ([#4](https://github.com/sfrieds3/tdo/issues/4)) ([a4e8495](https://github.com/sfrieds3/tdo/commit/a4e8495ada6f307e5250da831b40dc4580ea4317))
* support SSH remote databases across CLI and Pi ([#7](https://github.com/sfrieds3/tdo/issues/7)) ([440097a](https://github.com/sfrieds3/tdo/commit/440097aa61f3d2ed8238ac59f2f1a0d472e47626))

## [0.2.0](https://github.com/sfrieds3/tdo/compare/v0.1.0...v0.2.0) (2026-11-03)


### ⚠ BREAKING CHANGES

* the default database moved from ~/.pi/state/tdo.db to $XDG_DATA_HOME/tdo/tdo.db, the .pi/tdo-project override file is now .tdo-project, and PI_STATE_DIR is no longer read. Move an existing database with: mv ~/.pi/state/tdo.db ~/.local/share/tdo/tdo.db

### Features

* XDG paths, agent skill, and config file ([a09bdf2](https://github.com/sfrieds3/tdo/commit/a09bdf2c7cbaec77902b2c3fd76ceef39f3e9caf))

## 0.1.0 (2026-11-03)


### Features

* initial tdo backlog CLI and Pi extension ([0e67f65](https://github.com/sfrieds3/tdo/commit/0e67f65456fc4f7af83519c17c24a3e010fba0f9))


### Bug Fixes

* silence node:sqlite experimental warning on Node 22 ([d30a8e0](https://github.com/sfrieds3/tdo/commit/d30a8e024196b2e2c582bf7e969e63674a4a60aa))
