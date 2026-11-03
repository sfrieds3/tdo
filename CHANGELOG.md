# Changelog

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
