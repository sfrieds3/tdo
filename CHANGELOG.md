# Changelog

## [0.8.0](https://github.com/sfrieds3/tdo/compare/v0.7.0...v0.8.0) (2026-11-09)


### Features

* merge a machine-local config.local.json over the user config ([#55](https://github.com/sfrieds3/tdo/issues/55)) ([cea0d48](https://github.com/sfrieds3/tdo/commit/cea0d48a075e958da3bfa8ebf664aec62bf55fc5))


### Bug Fixes

* let ssh exit status decide async store failures instead of stdin EPIPE ([#57](https://github.com/sfrieds3/tdo/issues/57)) ([52fe3a4](https://github.com/sfrieds3/tdo/commit/52fe3a46fcdd2ba9b1042c9cb71a73d70a1bd5d3))

## [0.7.0](https://github.com/sfrieds3/tdo/compare/v0.6.0...v0.7.0) (2026-11-09)


### Features

* address items by their linked issue and show issue refs unambiguously ([#54](https://github.com/sfrieds3/tdo/issues/54)) ([6e7eb98](https://github.com/sfrieds3/tdo/commit/6e7eb98445527efc991938eddc08f52e640d8360))
* check for similar active items before agents add a tdo ([#53](https://github.com/sfrieds3/tdo/issues/53)) ([7994f2c](https://github.com/sfrieds3/tdo/commit/7994f2ce5a942eee0e5720ccea5e0b9dfefd5105))
* reference linked GitHub issues in work handoffs ([#50](https://github.com/sfrieds3/tdo/issues/50)) ([b9b90f5](https://github.com/sfrieds3/tdo/commit/b9b90f5eef0fcaae49a7db8eb73f5a77d1a79d94))
* sync item tags to GitHub issue labels ([#52](https://github.com/sfrieds3/tdo/issues/52)) ([0784183](https://github.com/sfrieds3/tdo/commit/0784183de85313c0a1c6176c2535282369644e23))


### Bug Fixes

* prompt for GitHub consent after chained agent mutations ([#49](https://github.com/sfrieds3/tdo/issues/49)) ([ca8194a](https://github.com/sfrieds3/tdo/commit/ca8194a5676824b6d8cc171d15e537c871746e6a))

## [0.6.0](https://github.com/sfrieds3/tdo/compare/v0.5.0...v0.6.0) (2026-11-06)


### ⚠ BREAKING CHANGES

* add consent-aware auto-on-tag and Pi issue filing ([#18](https://github.com/sfrieds3/tdo/issues/18))
* sync linked GitHub issue lifecycle through a durable queue ([#17](https://github.com/sfrieds3/tdo/issues/17))
* add manual GitHub issue filing and structured notes ([#16](https://github.com/sfrieds3/tdo/issues/16))

### Features

* add consent-aware auto-on-tag and Pi issue filing ([#18](https://github.com/sfrieds3/tdo/issues/18)) ([6a0e6d2](https://github.com/sfrieds3/tdo/commit/6a0e6d2bbcd0d1aadf39852277035661d4cc9ef4))
* add manual GitHub issue filing and structured notes ([#16](https://github.com/sfrieds3/tdo/issues/16)) ([d1a4380](https://github.com/sfrieds3/tdo/commit/d1a4380b821c45349f9cd66a2c47e9681e2b8689))
* sync linked GitHub issue lifecycle through a durable queue ([#17](https://github.com/sfrieds3/tdo/issues/17)) ([fcdef16](https://github.com/sfrieds3/tdo/commit/fcdef16052d967c8335360f4f5f794af3ada329b))

## [0.5.0](https://github.com/sfrieds3/tdo/compare/v0.4.0...v0.5.0) (2026-11-06)


### Features

* add tdo icon to Pi statusline ([#22](https://github.com/sfrieds3/tdo/issues/22)) ([dd42179](https://github.com/sfrieds3/tdo/commit/dd4217966872b7ce7662e6fb3687fda6df7eedec))


### Bug Fixes

* make list limits explicit and exports complete ([#23](https://github.com/sfrieds3/tdo/issues/23)) ([4ca2fc2](https://github.com/sfrieds3/tdo/commit/4ca2fc20ad0fb05f75266760addeebc13272c80f))
* resolve Pi projects without blocking the event loop ([#20](https://github.com/sfrieds3/tdo/issues/20)) ([95ebe72](https://github.com/sfrieds3/tdo/commit/95ebe72f758621ffade2bf73bcde6125ecacf087))
* worktree hand-off creates worktrees under .worktrees/ ([#24](https://github.com/sfrieds3/tdo/issues/24)) ([99aa89b](https://github.com/sfrieds3/tdo/commit/99aa89b7b09e6f176de55435dcd1475115781d55))

## [0.4.0](https://github.com/sfrieds3/tdo/compare/v0.3.0...v0.4.0) (2026-11-05)


### Features

* add config-gated Rex and tmux floating browsers ([#8](https://github.com/sfrieds3/tdo/issues/8)) ([4a3c126](https://github.com/sfrieds3/tdo/commit/4a3c1266f046af4ab424f46f92cd8a3bd3c9e465))
* config worktree asks the Pi agent to work in a new worktree/branch ([#13](https://github.com/sfrieds3/tdo/issues/13)) ([3886e28](https://github.com/sfrieds3/tdo/commit/3886e28562f037ef06bf589c23978d1b78cc6363))


### Bug Fixes

* accept ~tag for tag removal and ignore '=' from -t=… ([#10](https://github.com/sfrieds3/tdo/issues/10)) ([970abf3](https://github.com/sfrieds3/tdo/commit/970abf35b33beb91a57f87e1529ecd3bc42da3ca))
* bare /tdo&lt;space&gt; opens the project picker instead of --all ([#14](https://github.com/sfrieds3/tdo/issues/14)) ([8de4dfd](https://github.com/sfrieds3/tdo/commit/8de4dfd0af6dd28566160d31700d7c6a32025edb))
* ctrl-n/ctrl-p move the cursor in fzf ([#12](https://github.com/sfrieds3/tdo/issues/12)) ([5845d35](https://github.com/sfrieds3/tdo/commit/5845d35b678f33671ef4046866271369c267c6e8))
* read items under the write lock in setStatus, updateItem, and deleteItem ([#11](https://github.com/sfrieds3/tdo/issues/11)) ([871b489](https://github.com/sfrieds3/tdo/commit/871b4897c0bbf528b978ffc2e61e9a922d946c49))

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
