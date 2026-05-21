# Changelog

## [0.68.0](https://github.com/cuongtranba/kanna/compare/v0.67.0...v0.68.0) (2026-05-21)


### ⚠ BREAKING CHANGES

* **claude-pty:** Shannon-style TUI transport — drop --print, tail transcript JSONL ([#261](https://github.com/cuongtranba/kanna/issues/261))

### Features

* **claude-pty:** on-disk pid registry to reap crash orphans on next boot ([#267](https://github.com/cuongtranba/kanna/issues/267)) ([1817cde](https://github.com/cuongtranba/kanna/commit/1817cde883b2a5ad992d359a22be682ba134850c))
* **claude-pty:** plan-mode exit via Shift+Tab (F1) + getSupportedCommands live list (F2) ([#262](https://github.com/cuongtranba/kanna/issues/262)) ([5d941a5](https://github.com/cuongtranba/kanna/commit/5d941a574f8686701ad87554ece7bbe9167ada1b))
* **claude-pty:** Shannon-style TUI transport — drop --print, tail transcript JSONL ([#261](https://github.com/cuongtranba/kanna/issues/261)) ([273386c](https://github.com/cuongtranba/kanna/commit/273386cdb8d63803bc863f0ebfcf26b208e84ed9))
* **messages:** mask OAuth key as primary AccountInfo identifier ([#257](https://github.com/cuongtranba/kanna/issues/257)) ([d91f880](https://github.com/cuongtranba/kanna/commit/d91f880747ccad444cbc04c8bf970f412d773a40))
* **notice-banner:** extract reusable shell notice primitive ([#256](https://github.com/cuongtranba/kanna/issues/256)) ([1d1539e](https://github.com/cuongtranba/kanna/commit/1d1539e300a094b98b7e71a805759ae35f37d216))
* **settings:** add global prompt append for Claude + Codex turns ([#260](https://github.com/cuongtranba/kanna/issues/260)) ([f700d08](https://github.com/cuongtranba/kanna/commit/f700d085cd1d60249d582411a449ed25e14288f5))


### Bug Fixes

* **claude-pty, subagent:** adaptive paste-commit wait + clear stale cancel on new turn ([#265](https://github.com/cuongtranba/kanna/issues/265)) ([0782da4](https://github.com/cuongtranba/kanna/commit/0782da4bac0a30b03f2e4b1d7565c8d71204a3bd))
* **claude-pty:** fail-close hung turns on stream-end + add lifecycle trace logs ([#268](https://github.com/cuongtranba/kanna/issues/268)) ([b321973](https://github.com/cuongtranba/kanna/commit/b3219739b0c81afa864c4f006fc6b4e5dda94889))
* **claude-pty:** multi-line paste submit + mtime-floor JSONL discovery ([#264](https://github.com/cuongtranba/kanna/issues/264)) ([d9d9052](https://github.com/cuongtranba/kanna/commit/d9d905207929351df42c33d512f586337895a952))
* **claude-pty:** plug PTY resource leaks + harden graceful shutdown ([#266](https://github.com/cuongtranba/kanna/issues/266)) ([2dd5a16](https://github.com/cuongtranba/kanna/commit/2dd5a1625157896a4fb60ec67049b3a59969aded))
* **claude-pty:** TUI prompt submission, turn-end marker, deterministic JSONL path ([#263](https://github.com/cuongtranba/kanna/issues/263)) ([57aa777](https://github.com/cuongtranba/kanna/commit/57aa77703f31ae9940f3c655e4d7bee7d1c76460))

## [0.67.0](https://github.com/cuongtranba/kanna/compare/v0.66.1...v0.67.0) (2026-05-20)


### Features

* **messages:** surface OAuth key in chat AccountInfoMessage ([#254](https://github.com/cuongtranba/kanna/issues/254)) ([e24ec3e](https://github.com/cuongtranba/kanna/commit/e24ec3e6c2ad96bfd65d12d420b25e26f30042d8))

## [0.66.1](https://github.com/cuongtranba/kanna/compare/v0.66.0...v0.66.1) (2026-05-20)


### Bug Fixes

* **wiki:** editorial home page, WCAG AA gray ramp, Starlight cascade ([#252](https://github.com/cuongtranba/kanna/issues/252)) ([ed2acf3](https://github.com/cuongtranba/kanna/commit/ed2acf32b78ffb417178455e49552553251eaa27))

## [0.66.0](https://github.com/cuongtranba/kanna/compare/v0.65.1...v0.66.0) (2026-05-20)


### Features

* **client:** render &lt;thinking&gt; blocks as collapsible disclosure ([#250](https://github.com/cuongtranba/kanna/issues/250)) ([f91722d](https://github.com/cuongtranba/kanna/commit/f91722d64e640b74f800a6f5f52a5ec5be36926d))
* **wiki:** Kanna documentation site at kanna-wiki.lowbit.link ([#249](https://github.com/cuongtranba/kanna/issues/249)) ([01a86a2](https://github.com/cuongtranba/kanna/commit/01a86a24c33e2af66ada7443373693180a06d040))

## [0.65.1](https://github.com/cuongtranba/kanna/compare/v0.65.0...v0.65.1) (2026-05-19)


### Bug Fixes

* **client:** include subagentRuns in chat-snapshot dedup compare ([#245](https://github.com/cuongtranba/kanna/issues/245)) ([76d7b45](https://github.com/cuongtranba/kanna/commit/76d7b4586d5705234983339996d9f77f52b2e463))
* **oauth-pool:** persist refusal as transcript result entry ([#248](https://github.com/cuongtranba/kanna/issues/248)) ([adbf02d](https://github.com/cuongtranba/kanna/commit/adbf02d8a5f5f5d4ed7c7338117050c0fcf2aad2))

## [0.65.0](https://github.com/cuongtranba/kanna/compare/v0.64.0...v0.65.0) (2026-05-19)


### Features

* **messages:** render mermaid diagrams in transcript markdown ([#242](https://github.com/cuongtranba/kanna/issues/242)) ([c606355](https://github.com/cuongtranba/kanna/commit/c606355c6330175f6ccf170afdc228a90aeea943))


### Bug Fixes

* **event-store:** decouple subagent live progress from global writeChain ([#244](https://github.com/cuongtranba/kanna/issues/244)) ([21ea6e9](https://github.com/cuongtranba/kanna/commit/21ea6e9aefe497fcd66984bbbdbdf1346145faae))

## [0.64.0](https://github.com/cuongtranba/kanna/compare/v0.63.0...v0.64.0) (2026-05-19)


### Features

* **oauth-pool:** name contested chat in token-unavailable refusal ([#235](https://github.com/cuongtranba/kanna/issues/235)) ([eef731b](https://github.com/cuongtranba/kanna/commit/eef731bccd2301aad12bcc6dfa8a32f113a723a8))
* **subagent:** live UI broadcast + pending tool loading state ([#237](https://github.com/cuongtranba/kanna/issues/237)) ([65969ed](https://github.com/cuongtranba/kanna/commit/65969eda3382ae480d1b8e2bf968fdeb26c0d2e5))


### Bug Fixes

* **ui:** align PTY driver banner with floating sidebar chrome ([#239](https://github.com/cuongtranba/kanna/issues/239)) ([855b80d](https://github.com/cuongtranba/kanna/commit/855b80d5221bd0572a1e78ad18ab92c83b62077a))

## [0.63.0](https://github.com/cuongtranba/kanna/compare/v0.62.0...v0.63.0) (2026-05-19)


### Features

* **subagent:** reactive activity label from latest entries ([#231](https://github.com/cuongtranba/kanna/issues/231)) ([08a41a5](https://github.com/cuongtranba/kanna/commit/08a41a58e23642a55b34b3786a1339219a6fe3f8))
* **subagent:** rich activity labels + MCP progress notifications ([#234](https://github.com/cuongtranba/kanna/issues/234)) ([493ef87](https://github.com/cuongtranba/kanna/commit/493ef87e809d09594c210e2f2f52475bef510f82))

## [0.62.0](https://github.com/cuongtranba/kanna/compare/v0.61.5...v0.62.0) (2026-05-19)


### Features

* **ui:** unify AskUserQuestion slide UI across native + pending paths ([#229](https://github.com/cuongtranba/kanna/issues/229)) ([a565506](https://github.com/cuongtranba/kanna/commit/a5655068e415ead2389da36b40c1759f8b0635db))


### Bug Fixes

* **oauth-pool:** stop turn-end release from leaking the rotation pin; OAuth-only PTY auth ([#227](https://github.com/cuongtranba/kanna/issues/227)) ([024e09b](https://github.com/cuongtranba/kanna/commit/024e09be2862fe5c2f7a8ccff1b4a76237626340))

## [0.61.5](https://github.com/cuongtranba/kanna/compare/v0.61.4...v0.61.5) (2026-05-19)


### Bug Fixes

* **tools:** peel MCP CallToolResult envelope when hydrating ask_user_question ([#225](https://github.com/cuongtranba/kanna/issues/225)) ([fc106c1](https://github.com/cuongtranba/kanna/commit/fc106c1f0c4ca369b18493dfc4b56ae3bc1fcc0a))

## [0.61.4](https://github.com/cuongtranba/kanna/compare/v0.61.3...v0.61.4) (2026-05-18)


### Bug Fixes

* **ui:** normalize mcp__kanna__ask_user_question text→question in pending card ([#223](https://github.com/cuongtranba/kanna/issues/223)) ([3610f9b](https://github.com/cuongtranba/kanna/commit/3610f9b2cbf46510d8db0b3910d8a1cd87e07d0b))

## [0.61.3](https://github.com/cuongtranba/kanna/compare/v0.61.2...v0.61.3) (2026-05-18)


### Bug Fixes

* **claude-pty:** SIGINT on stop, drain queue after cancel ([#220](https://github.com/cuongtranba/kanna/issues/220)) ([f5a76ff](https://github.com/cuongtranba/kanna/commit/f5a76ff1d40e956e95a26d818172c19e2b6d436a))
* **tools:** normalize mcp__kanna__ask_user_question text→question field ([#222](https://github.com/cuongtranba/kanna/issues/222)) ([b11741d](https://github.com/cuongtranba/kanna/commit/b11741dbd1ec604adf4f41d8d05a540db04e7747))

## [0.61.2](https://github.com/cuongtranba/kanna/compare/v0.61.1...v0.61.2) (2026-05-18)


### Bug Fixes

* **permission-gate:** force ask for mcp__kanna__ask_user_question / exit_plan_mode ([#217](https://github.com/cuongtranba/kanna/issues/217)) ([941f92f](https://github.com/cuongtranba/kanna/commit/941f92f19f159fba83c07e94abf62d85adb4a438)), closes [#215](https://github.com/cuongtranba/kanna/issues/215)

## [0.61.1](https://github.com/cuongtranba/kanna/compare/v0.61.0...v0.61.1) (2026-05-18)


### Bug Fixes

* **claude-pty:** route AskUserQuestion/ExitPlanMode to UI under PTY ([#216](https://github.com/cuongtranba/kanna/issues/216)) ([2316725](https://github.com/cuongtranba/kanna/commit/2316725845263948761e24d897d5eba5b03bcebb)), closes [#215](https://github.com/cuongtranba/kanna/issues/215)
* **update:** instant overlay + per-button loading for install/rollback/redeploy ([#213](https://github.com/cuongtranba/kanna/issues/213)) ([e2f0801](https://github.com/cuongtranba/kanna/commit/e2f0801810ae12ee704e67d2eb375e8c5f387a24))

## [0.61.0](https://github.com/cuongtranba/kanna/compare/v0.60.0...v0.61.0) (2026-05-18)


### Features

* **codex:** auto-relocate ImageGeneration outputs into project ([#210](https://github.com/cuongtranba/kanna/issues/210)) ([d1fb494](https://github.com/cuongtranba/kanna/commit/d1fb494b664882ec58b9ab39773ab7469f77ed05))


### Bug Fixes

* **settings/subagents:** remove duplicate copy in empty state and list ([#212](https://github.com/cuongtranba/kanna/issues/212)) ([55510cb](https://github.com/cuongtranba/kanna/commit/55510cbc8ef50bf3e62f03e641098d3e0e051450))

## [0.60.0](https://github.com/cuongtranba/kanna/compare/v0.59.0...v0.60.0) (2026-05-18)


### Features

* **ui:** full-app loading overlay during redeploy/update restart ([#207](https://github.com/cuongtranba/kanna/issues/207)) ([c967cf2](https://github.com/cuongtranba/kanna/commit/c967cf21e0b733f06ea2d34f982f8e80ecb96a67))
* **update:** install any release from changelog UI ([#208](https://github.com/cuongtranba/kanna/issues/208)) ([8fd44e9](https://github.com/cuongtranba/kanna/commit/8fd44e9cdf91fe21b8686081b3dbfb38a549ff6b))

## [0.59.0](https://github.com/cuongtranba/kanna/compare/v0.58.0...v0.59.0) (2026-05-18)


### Features

* **subagent:** main agent delegates via mcp__kanna__delegate_subagent ([#205](https://github.com/cuongtranba/kanna/issues/205)) ([47466dc](https://github.com/cuongtranba/kanna/commit/47466dc7aff848baf0fc22d89a14149ee1c30148))
* **ui:** centralize app bootstrap loading state ([#206](https://github.com/cuongtranba/kanna/issues/206)) ([b4ada0e](https://github.com/cuongtranba/kanna/commit/b4ada0ef1504fad5c53471ceecdf016b2127a97b))


### Bug Fixes

* **pty:** close mcp/tmp/tool-callbacks on every exit path ([#201](https://github.com/cuongtranba/kanna/issues/201)) ([26a13b8](https://github.com/cuongtranba/kanna/commit/26a13b8004b93bcafe2803f6ed442cd7e8fc61de))
* **subagent:** inherit parent chat's OAuth-pool reservation ([#204](https://github.com/cuongtranba/kanna/issues/204)) ([007ece2](https://github.com/cuongtranba/kanna/commit/007ece27d2dcf4dc78ede815fd2bd9c0b2d9b79a))

## [0.58.0](https://github.com/cuongtranba/kanna/compare/v0.57.5...v0.58.0) (2026-05-18)


### Features

* **pty:** switch to --print stream-json + trust claude as source of truth ([#200](https://github.com/cuongtranba/kanna/issues/200)) ([ca62112](https://github.com/cuongtranba/kanna/commit/ca621122f39b22609d89782287dbcb8548ff164d))


### Bug Fixes

* **subagent:** close 5 P1 concurrency / routing bugs (B1–B5) ([#199](https://github.com/cuongtranba/kanna/issues/199)) ([0775d69](https://github.com/cuongtranba/kanna/commit/0775d6948b63fc9c8629d97b059381fcf53c805b))
* **subagent:** forward user instruction + scan main reply for mentions ([#196](https://github.com/cuongtranba/kanna/issues/196)) ([0745f78](https://github.com/cuongtranba/kanna/commit/0745f78ac0dd19c153056c1cbec6ee9935e83e1b))

## [0.57.5](https://github.com/cuongtranba/kanna/compare/v0.57.4...v0.57.5) (2026-05-18)


### Bug Fixes

* **server:** allow HEAD on /api/projects/:id/{files,uploads}/*/content ([#194](https://github.com/cuongtranba/kanna/issues/194)) ([330f33a](https://github.com/cuongtranba/kanna/commit/330f33a3adfa00e66889f263c1fa992ef95ddd71))

## [0.57.4](https://github.com/cuongtranba/kanna/compare/v0.57.3...v0.57.4) (2026-05-17)


### Bug Fixes

* **chat-input:** prevent iOS Safari page-jump when tapping file picker ([#192](https://github.com/cuongtranba/kanna/issues/192)) ([e139eb8](https://github.com/cuongtranba/kanna/commit/e139eb83f5044fdc15fa711fd8afa4c4b46f61e4))

## [0.57.3](https://github.com/cuongtranba/kanna/compare/v0.57.2...v0.57.3) (2026-05-17)


### Miscellaneous Chores

* release 0.57.3 to publish reverted baseline to npm ([#190](https://github.com/cuongtranba/kanna/issues/190)) ([5dd8b88](https://github.com/cuongtranba/kanna/commit/5dd8b884921079df6115eef74c2f4f2b1a37f3e7))

## [0.57.2](https://github.com/cuongtranba/kanna/compare/v0.57.1...v0.57.2) (2026-05-17)


### Chores

* bump to 0.57.2 to bypass tag clash with the prior v0.57.1 release (v0.57.1 was reverted in #186 but the git tag still points at the old release commit)

## [0.57.1](https://github.com/cuongtranba/kanna/compare/v0.57.0...v0.57.1) (2026-05-17)


### Bug Fixes

* **chat-input:** prevent iOS Safari page-jump when tapping file picker ([#182](https://github.com/cuongtranba/kanna/issues/182)) ([d8cd8cd](https://github.com/cuongtranba/kanna/commit/d8cd8cdc30de476fdb3e6f3373f3a217c0784708))
* **chat-ui:** clamp Selection back into textarea on iOS keyboard-trackpad drift ([#183](https://github.com/cuongtranba/kanna/issues/183)) ([2b55798](https://github.com/cuongtranba/kanna/commit/2b557987c9d23fcf60b152f125a30f8d77c1be98))


### Reverts

* restore chat input + version to 0.57.0 state ([#186](https://github.com/cuongtranba/kanna/issues/186)) ([cb0495a](https://github.com/cuongtranba/kanna/commit/cb0495aaf94d974a1fdb16689ab8edf89c98d5c0))

## [0.57.0](https://github.com/cuongtranba/kanna/compare/v0.56.4...v0.57.0) (2026-05-17)


### Features

* **pty:** D4 partial — runtime /plan enter via slash command ([#174](https://github.com/cuongtranba/kanna/issues/174)) ([f9ab062](https://github.com/cuongtranba/kanna/commit/f9ab062837d9135e97b31bc584d4d11591ba5bfc))
* **pty:** phase 1 parity wiring (B2 + B5) ([#164](https://github.com/cuongtranba/kanna/issues/164)) ([3781119](https://github.com/cuongtranba/kanna/commit/3781119ae70cf3b754da6f013ef9ac5e8207cc7e))
* **pty:** phase 2 — register kanna MCP server in PTY (B3 + B6) ([#168](https://github.com/cuongtranba/kanna/issues/168)) ([aa37c86](https://github.com/cuongtranba/kanna/commit/aa37c86717cd3d5bb8bd4ea3bd4f798470c7919e))
* **pty:** phase 3 — JSONL event parity (D1 + D2 + D3 + D4) ([#169](https://github.com/cuongtranba/kanna/issues/169)) ([f90384d](https://github.com/cuongtranba/kanna/commit/f90384dee08d457770d00c1505cdb412586a1195))
* **pty:** phase 4 — failure handling parity (B4 + D5 + D7) ([#170](https://github.com/cuongtranba/kanna/issues/170)) ([85a685d](https://github.com/cuongtranba/kanna/commit/85a685d7138609af9a576663a76cd8843e05b31f))
* **pty:** phase 5 — subagent routing + shared prompt + account (D6 + D8 + C1) ([#171](https://github.com/cuongtranba/kanna/issues/171)) ([0fa777d](https://github.com/cuongtranba/kanna/commit/0fa777d7b8f988ed6514f5b47c9211c335e1b3c8))
* **pty:** phase 6 — SDK ↔ PTY equivalence matrix + doc sweep ([#172](https://github.com/cuongtranba/kanna/issues/172)) ([043d82c](https://github.com/cuongtranba/kanna/commit/043d82cf6516752ae707e6272801df2aeb460434))
* **settings:** subagent CRUD UI ([#166](https://github.com/cuongtranba/kanna/issues/166)) ([0f094ab](https://github.com/cuongtranba/kanna/commit/0f094ab7870fb311a84ec17b080923045923fe3a))
* **skills:** add kanna-debug skill for transcript-driven debugging ([f6df21a](https://github.com/cuongtranba/kanna/commit/f6df21afbb27a5c4e41c7ac9b6ae9c7b946a00e6))


### Bug Fixes

* **agent:** preserve rotation reservation in closeClaudeSession ([#179](https://github.com/cuongtranba/kanna/issues/179)) ([102270c](https://github.com/cuongtranba/kanna/commit/102270c7f8e7b934e0ce2a40588a7f9529987224))
* **chat-ui:** prevent iOS cursor-jump during hold-space cursor drag ([#180](https://github.com/cuongtranba/kanna/issues/180)) ([cf28ff0](https://github.com/cuongtranba/kanna/commit/cf28ff0ebf2730d54e306bf1927b1a61848b3b7a))
* **codex:** serve absolute-path generated images via /api/local-file ([#167](https://github.com/cuongtranba/kanna/issues/167)) ([61aa1de](https://github.com/cuongtranba/kanna/commit/61aa1de077404a2009ace01a46043c3d06452eb1))
* **oauth-pool:** TOCTOU-safe hasUsable, ephemeral lease, pure read loop ([#177](https://github.com/cuongtranba/kanna/issues/177)) ([561e074](https://github.com/cuongtranba/kanna/commit/561e074c4a1b313d29036009bc4847d013c72792))
* **pty/preflight:** fail-closed on throw, real invalidateAll, contract-versioned cache, poll vs sleep ([#176](https://github.com/cuongtranba/kanna/issues/176)) ([575011e](https://github.com/cuongtranba/kanna/commit/575011eee6c5ddd957808e489a184d8232a77b5e))
* **pty/preflight:** narrow TOCTOU window by re-verifying binary sha256 before spawn ([#178](https://github.com/cuongtranba/kanna/issues/178)) ([0404680](https://github.com/cuongtranba/kanna/commit/0404680e9a4c148874c075af6ddb697d5bd2c7dc))
* **pty/sandbox:** symlink resolution, glob surfacing, injection + signal ([#175](https://github.com/cuongtranba/kanna/issues/175)) ([378797f](https://github.com/cuongtranba/kanna/commit/378797f5578456410a002b0afc300918df416940))
* **pty:** drop credentials.json requirement when OAuth-pool token supplied ([#173](https://github.com/cuongtranba/kanna/issues/173)) ([6dc8f37](https://github.com/cuongtranba/kanna/commit/6dc8f37e8c3327f77f1a6bc09584b0c4954115b3))

## [0.56.4](https://github.com/cuongtranba/kanna/compare/v0.56.3...v0.56.4) (2026-05-16)


### Bug Fixes

* **chat:** transcript not scrollable on mobile for long conversations ([#159](https://github.com/cuongtranba/kanna/issues/159)) ([22b273b](https://github.com/cuongtranba/kanna/commit/22b273b90301bef85df8c7b02b693c34bea2e4f1))

## [0.56.3](https://github.com/cuongtranba/kanna/compare/v0.56.2...v0.56.3) (2026-05-16)


### Performance Improvements

* **transcript:** stabilize markdown props + memoize message components ([#157](https://github.com/cuongtranba/kanna/issues/157)) ([6ed1531](https://github.com/cuongtranba/kanna/commit/6ed153168686afc6d05fc2f858adcdadbec4209f))

## [0.56.2](https://github.com/cuongtranba/kanna/compare/v0.56.1...v0.56.2) (2026-05-16)


### Bug Fixes

* **chat-preferences:** persist composer state + use providerDefaults for new chat ([#155](https://github.com/cuongtranba/kanna/issues/155)) ([54aa3e0](https://github.com/cuongtranba/kanna/commit/54aa3e0562158d965c80d4426ca90ab6489d2d10))

## [0.56.1](https://github.com/cuongtranba/kanna/compare/v0.56.0...v0.56.1) (2026-05-16)


### Bug Fixes

* **chat-preferences:** refresh new-chat composer when settings change ([#151](https://github.com/cuongtranba/kanna/issues/151)) ([ad7c3ac](https://github.com/cuongtranba/kanna/commit/ad7c3acd91efd437607f4c2617d5969d34d2a4bf))
* **compact:** stop cumulative result.usage leaking into usedTokens ([#152](https://github.com/cuongtranba/kanna/issues/152)) ([3007810](https://github.com/cuongtranba/kanna/commit/30078108852aed9b147479b73cbba04e00271613))

## [0.56.0](https://github.com/cuongtranba/kanna/compare/v0.55.3...v0.56.0) (2026-05-16)


### Features

* **file-preview:** mobile-first universal file preview sheet ([#143](https://github.com/cuongtranba/kanna/issues/143)) ([181e60a](https://github.com/cuongtranba/kanna/commit/181e60aca9877815da7fb95b84a9183889a593cd))


### Bug Fixes

* **agent:** recreate activeTurn on late canUseTool from SDK self-resume ([#148](https://github.com/cuongtranba/kanna/issues/148)) ([4114fc7](https://github.com/cuongtranba/kanna/commit/4114fc7c99944ee0e0f11a4dc8b5e4140d3c7a88))

## [0.55.3](https://github.com/cuongtranba/kanna/compare/v0.55.2...v0.55.3) (2026-05-16)


### Bug Fixes

* **server:** dispose fs.watch managers before fallible shutdown awaits ([#146](https://github.com/cuongtranba/kanna/issues/146)) ([9460481](https://github.com/cuongtranba/kanna/commit/9460481145898b469605d4fd687b05dc6f242121))

## [0.55.2](https://github.com/cuongtranba/kanna/compare/v0.55.1...v0.55.2) (2026-05-16)


### Bug Fixes

* **test:** dispose AppSettingsManager FSWatchers via centralized afterEach ([#144](https://github.com/cuongtranba/kanna/issues/144)) ([9b7c0be](https://github.com/cuongtranba/kanna/commit/9b7c0be4717167b1c5208db63c8a2c172fe6f91f))

## [0.55.1](https://github.com/cuongtranba/kanna/compare/v0.55.0...v0.55.1) (2026-05-16)


### Bug Fixes

* **ci:diag:** capture stuck-process stack when bun test hangs ([#141](https://github.com/cuongtranba/kanna/issues/141)) ([4d83e9c](https://github.com/cuongtranba/kanna/commit/4d83e9cc25cd519aef38e522ca353f9287ad858b))

## [0.55.0](https://github.com/cuongtranba/kanna/compare/v0.54.0...v0.55.0) (2026-05-16)


### Features

* **claude-pty:** P7 — driver toggle, lifecycle, sidebar badges, per-chat permissions ([#135](https://github.com/cuongtranba/kanna/issues/135)) ([1742ea7](https://github.com/cuongtranba/kanna/commit/1742ea775e419adfb43f01514557e6fc57241529))


### Bug Fixes

* **chat:** seed composer provider from server snapshot on session reload ([#137](https://github.com/cuongtranba/kanna/issues/137)) ([9019c50](https://github.com/cuongtranba/kanna/commit/9019c509786b13153680dbd2342c39db46b17d06))
* **chat:** server-authoritative routing kills duplicate queued bubble ([#136](https://github.com/cuongtranba/kanna/issues/136)) ([5354454](https://github.com/cuongtranba/kanna/commit/535445437a7d08dde652c2b39b9a91bf71755bd8))
* **codex:** render ImageGeneration inline with project URL and populated prompt ([#132](https://github.com/cuongtranba/kanna/issues/132)) ([a9d4c39](https://github.com/cuongtranba/kanna/commit/a9d4c3911729984201b498acce32eead1f5263d2))
* **compact:** persist proactive-compact circuit breaker + harden audit gaps ([#139](https://github.com/cuongtranba/kanna/issues/139)) ([81ed65b](https://github.com/cuongtranba/kanna/commit/81ed65b3db05a96134d4335ad2b32a56f48cb051))
* **compact:** protect queued message from accidental dequeue mid-compact ([#134](https://github.com/cuongtranba/kanna/issues/134)) ([e1c0c73](https://github.com/cuongtranba/kanna/commit/e1c0c73b79f770483fbdd509ae64d13646650959))
* **compact:** seed maxTokens from [1m] model id to stop premature compact ([#131](https://github.com/cuongtranba/kanna/issues/131)) ([1f7bc42](https://github.com/cuongtranba/kanna/commit/1f7bc42a483c5d8b65a5eb074c14c25422e4c0b4))
* **image-gen:** tighten types, fix silent error, dedupe URL builder ([#138](https://github.com/cuongtranba/kanna/issues/138)) ([890ad71](https://github.com/cuongtranba/kanna/commit/890ad716ccf15b3484c3ad6192ae0b8feeb7b3d2))
* **local-file-link:** treat extension-less paths as editor links ([#129](https://github.com/cuongtranba/kanna/issues/129)) ([8a0c867](https://github.com/cuongtranba/kanna/commit/8a0c867d857f50374d9836988870e2decddebb59))
* **useKannaState:** drop optimistic user_prompt when chat.send acks queued ([#133](https://github.com/cuongtranba/kanna/issues/133)) ([554b492](https://github.com/cuongtranba/kanna/commit/554b492bcee57f70a41fcf5f6573052ffc345b4e))

## [0.54.0](https://github.com/cuongtranba/kanna/compare/v0.53.0...v0.54.0) (2026-05-15)


### Features

* **claude-pty:** session lifecycle + prompt-too-long recovery (P6) ([#122](https://github.com/cuongtranba/kanna/issues/122)) ([9239751](https://github.com/cuongtranba/kanna/commit/9239751d5af721c7807572e454c9e40228f25605))


### Bug Fixes

* **codex:** surface image generation + unknown ThreadItems, suppress empty agent messages ([#125](https://github.com/cuongtranba/kanna/issues/125)) ([4130ba9](https://github.com/cuongtranba/kanna/commit/4130ba93d49d98138241a68a66a8798bf73f6af8))
* **oauth-pool:** release token reservation on turn end so idle chats stop blocking ([#128](https://github.com/cuongtranba/kanna/issues/128)) ([086d60d](https://github.com/cuongtranba/kanna/commit/086d60da07199f8307071839fb946278729d6f24))
* **tests:** force NODE_ENV=test via bunfig preload to load React dev bundle ([#127](https://github.com/cuongtranba/kanna/issues/127)) ([b38d32f](https://github.com/cuongtranba/kanna/commit/b38d32f036ecd0d502b10311990c2db18276fafc))

## [0.53.0](https://github.com/cuongtranba/kanna/compare/v0.52.0...v0.53.0) (2026-05-15)


### Features

* **oauth-pool:** add disabled token status to exclude accounts from pool ([#117](https://github.com/cuongtranba/kanna/issues/117)) ([1fb43ae](https://github.com/cuongtranba/kanna/commit/1fb43ae04b2e7e76282f83864fbdacf7e734cf86))
* **update:** host-agnostic install with detection + KANNA_UPDATE_COMMAND override ([#119](https://github.com/cuongtranba/kanna/issues/119)) ([e9e66b2](https://github.com/cuongtranba/kanna/commit/e9e66b2d62b34751efacdc2b818db6733c986964))


### Bug Fixes

* **oauth-pool:** refuse spawn + rotate on 401 to stop keychain-fallback 401 loop ([#123](https://github.com/cuongtranba/kanna/issues/123)) ([99662fc](https://github.com/cuongtranba/kanna/commit/99662fca8cac12e53eaa8fc8019472ea73e5800c))

## [0.52.0](https://github.com/cuongtranba/kanna/compare/v0.51.0...v0.52.0) (2026-05-15)


### Features

* **agent:** proactive /compact injection before context overflows ([#116](https://github.com/cuongtranba/kanna/issues/116)) ([1169e3e](https://github.com/cuongtranba/kanna/commit/1169e3e120946e8c0cfce5a76da6527e6b228356))
* cancel individual subagent run ([#96](https://github.com/cuongtranba/kanna/issues/96)) ([b171ddf](https://github.com/cuongtranba/kanna/commit/b171ddf7cbf1b566b6df4aa0c82684364a29f704))
* **claude-pty:** allowlist preflight + --tools flag (P3b) ([#110](https://github.com/cuongtranba/kanna/issues/110)) ([ba6b440](https://github.com/cuongtranba/kanna/commit/ba6b440ae53a6f47cd459d8e5d10750de04e246d))
* **claude-pty:** Linux bwrap sandbox parity (P4.1) ([#112](https://github.com/cuongtranba/kanna/issues/112)) ([713c1da](https://github.com/cuongtranba/kanna/commit/713c1da25cbbd9c933434920994e6aabf67d4023))
* **claude-pty:** macOS sandbox-exec wrapper (P4) ([#111](https://github.com/cuongtranba/kanna/issues/111)) ([b3a9e12](https://github.com/cuongtranba/kanna/commit/b3a9e1258c30057dce89f4aa6a68598948643f99))
* **claude-pty:** OAuth pool rotation via CLAUDE_CODE_OAUTH_TOKEN (P5) ([#114](https://github.com/cuongtranba/kanna/issues/114)) ([65c1542](https://github.com/cuongtranba/kanna/commit/65c1542e4e371a5109c2565679a45ad8dd9c945a))
* **claude-pty:** PTY core driver (P2 — flag off by default) ([#106](https://github.com/cuongtranba/kanna/issues/106)) ([0ece0ba](https://github.com/cuongtranba/kanna/commit/0ece0ba128c5fc16fd758e675a878f63f8b69095))
* **kanna-mcp:** built-in tool shims (P3a — flag off by default) ([#107](https://github.com/cuongtranba/kanna/issues/107)) ([bbaed17](https://github.com/cuongtranba/kanna/commit/bbaed17c014bbe874b255aa871b1af5db1c2172b))
* **mcp-tool-refactor:** durable approval protocol + permission-gate (P1 — flag off by default) ([#105](https://github.com/cuongtranba/kanna/issues/105)) ([d2b2cce](https://github.com/cuongtranba/kanna/commit/d2b2cce003191f5989520adfabeaea6a3de2a1eb))


### Bug Fixes

* **agent:** gate runClaudeSession finally activeTurn cleanup on isCurrentSession ([#115](https://github.com/cuongtranba/kanna/issues/115)) ([fad644a](https://github.com/cuongtranba/kanna/commit/fad644a87a2be63ebc7842cedea16621d7f39b0a))
* **event-store:** dedupe appendMessage by messageId (JSONL replay safety) ([#109](https://github.com/cuongtranba/kanna/issues/109)) ([b6d5c01](https://github.com/cuongtranba/kanna/commit/b6d5c01e3e733d3b3e4a9bad2413b55099edff56))
* **subagent:** cancel rejects pending resolvers even with no main turn ([#94](https://github.com/cuongtranba/kanna/issues/94)) ([9aac71d](https://github.com/cuongtranba/kanna/commit/9aac71dc226a62703568790bafd45974771c0167))
* **tool-callback test:** flush background persists before tmpdir cleanup ([#113](https://github.com/cuongtranba/kanna/issues/113)) ([dd0387a](https://github.com/cuongtranba/kanna/commit/dd0387a06b16f2df7bae471aa81a0c9db2b7c951))

## [0.51.0](https://github.com/cuongtranba/kanna/compare/v0.50.0...v0.51.0) (2026-05-14)


### Features

* phase 3 subagent orchestration + UI ([#83](https://github.com/cuongtranba/kanna/issues/83)) ([bca45b9](https://github.com/cuongtranba/kanna/commit/bca45b9098b292373b54dcfd1e2bda5f05a3efe9))
* phase 4 real provider integration for subagents ([#86](https://github.com/cuongtranba/kanna/issues/86)) ([52d22ce](https://github.com/cuongtranba/kanna/commit/52d22ce50335059cc52b3c8705e1608b573d8a70))
* **sidebar:** asterism separator between stacks ([#85](https://github.com/cuongtranba/kanna/issues/85)) ([002f39e](https://github.com/cuongtranba/kanna/commit/002f39ecb73173ee1b0fbcfe5bd1a34eb264d8ca))


### Bug Fixes

* **event-store:** forkChat preserves stack membership ([#87](https://github.com/cuongtranba/kanna/issues/87)) ([7f76ac9](https://github.com/cuongtranba/kanna/commit/7f76ac94bdb1d3f7558b8cfc92ad8deed91d2c26))
* **oauth-pool:** reserve token per chat to prevent concurrent rotation race ([#89](https://github.com/cuongtranba/kanna/issues/89)) ([686c6b8](https://github.com/cuongtranba/kanna/commit/686c6b8a7de31d02f31f85d52c1c00a6df1581c9))
* **subagent:** clear pendingTool on terminal events + use /api/local-file ([#88](https://github.com/cuongtranba/kanna/issues/88)) ([e32db6f](https://github.com/cuongtranba/kanna/commit/e32db6fa264f5b5947bd524a3834fdce1890daa3))
* **subagent:** resolver leaks, full restart recovery, harden cap ([#93](https://github.com/cuongtranba/kanna/issues/93)) ([7bb3d92](https://github.com/cuongtranba/kanna/commit/7bb3d923c84e012a2716aa428d624ec70c519c3a))
* **ws-router:** strip timings from chat snapshot dedup signature ([#90](https://github.com/cuongtranba/kanna/issues/90)) ([ee3548a](https://github.com/cuongtranba/kanna/commit/ee3548a9ece5c4785aeaaed5e4d9de465fb00668))

## [0.50.0](https://github.com/cuongtranba/kanna/compare/v0.49.0...v0.50.0) (2026-05-14)


### Features

* model-independent chat phase 2 (subagent CRUD + [@agent](https://github.com/agent) mentions) ([#81](https://github.com/cuongtranba/kanna/issues/81)) ([07955a8](https://github.com/cuongtranba/kanna/commit/07955a81ad07f16a24bbf69f0c325a7f21999337))

## [0.49.0](https://github.com/cuongtranba/kanna/compare/v0.48.0...v0.49.0) (2026-05-13)


### Features

* model-independent chat phase 1 (provider-switching) ([#77](https://github.com/cuongtranba/kanna/issues/77)) ([075000b](https://github.com/cuongtranba/kanna/commit/075000be0201cc59194a76415213784cec0f6db1))
* **sidebar:** add stack delete via dropdown + context menu ([#79](https://github.com/cuongtranba/kanna/issues/79)) ([f4843a1](https://github.com/cuongtranba/kanna/commit/f4843a1fc987cc05986fdfcb7fc276bb2c4a4702))

## [0.48.0](https://github.com/cuongtranba/kanna/compare/v0.47.2...v0.48.0) (2026-05-13)


### Features

* **chat-navbar:** show worktree dir in branch label ([#69](https://github.com/cuongtranba/kanna/issues/69)) ([6dca7cc](https://github.com/cuongtranba/kanna/commit/6dca7cc70e3a950bf88713fe95add172ce00644e))
* star projects in sidebar ([#74](https://github.com/cuongtranba/kanna/issues/74)) ([65c1b33](https://github.com/cuongtranba/kanna/commit/65c1b330b88c3c67157b8514b5fc3ae0e59efe60))
* **tunnel:** replace bash-detector with agent-callable expose_port tool ([#70](https://github.com/cuongtranba/kanna/issues/70)) ([24c6233](https://github.com/cuongtranba/kanna/commit/24c6233f3e0594c8ab0543485a312b62661a936b))


### Bug Fixes

* **downloads:** render local-file markdown links as download cards ([#75](https://github.com/cuongtranba/kanna/issues/75)) ([67fb665](https://github.com/cuongtranba/kanna/commit/67fb6651788c5718bae2403e777c5db28d9e1667))
* **oauth-pool:** tear down session on token rotation ([#72](https://github.com/cuongtranba/kanna/issues/72)) ([9f28a71](https://github.com/cuongtranba/kanna/commit/9f28a713bf78657cce14fbbc43cd22db806fb4f0))
* **server:** serve arbitrary local files via /api/local-file ([#66](https://github.com/cuongtranba/kanna/issues/66)) ([dffbf01](https://github.com/cuongtranba/kanna/commit/dffbf0126b0faa49510dcda0a57eb7e7a1683e05))
* **stacks:** render stack chats inside expanded stack section ([#71](https://github.com/cuongtranba/kanna/issues/71)) ([d00f6a5](https://github.com/cuongtranba/kanna/commit/d00f6a555a7e51f03e979c3cb235a3014869e93b))

## [0.47.2](https://github.com/cuongtranba/kanna/compare/v0.47.1...v0.47.2) (2026-05-13)


### Bug Fixes

* **app-settings:** atomic writes prevent OAuth token loss ([#60](https://github.com/cuongtranba/kanna/issues/60)) ([7619fb8](https://github.com/cuongtranba/kanna/commit/7619fb8e7c2d3ec30a1084704decb2db3dad9077))

## [0.47.1](https://github.com/cuongtranba/kanna/compare/v0.47.0...v0.47.1) (2026-05-13)


### Bug Fixes

* **stacks:** stack chat create row layout on narrow widths ([#57](https://github.com/cuongtranba/kanna/issues/57)) ([95d83be](https://github.com/cuongtranba/kanna/commit/95d83bebfb6fbe82a464efe7ce80d68c33dd8888))

## [0.47.0](https://github.com/cuongtranba/kanna/compare/v0.46.1...v0.47.0) (2026-05-13)


### Features

* **stacks:** Phase 3 — sidebar UI, chat creation, peer strip ([#55](https://github.com/cuongtranba/kanna/issues/55)) ([0a680c1](https://github.com/cuongtranba/kanna/commit/0a680c119688a9c069e747c5087df96ebe461645))

## [0.46.1](https://github.com/cuongtranba/kanna/compare/v0.46.0...v0.46.1) (2026-05-12)


### Bug Fixes

* **oauth-pool:** detect SDK-wrapped rate-limit and rotate tokens ([c0a30a9](https://github.com/cuongtranba/kanna/commit/c0a30a90122db3c15fd5c98a0c00d3e44b62f887))

## [0.46.0](https://github.com/cuongtranba/kanna/compare/v0.45.0...v0.46.0) (2026-05-11)


### Features

* OAuth token pool with automatic rotation on rate-limit ([#52](https://github.com/cuongtranba/kanna/issues/52)) ([219ecef](https://github.com/cuongtranba/kanna/commit/219ecefe4fb453525c6e4314413c976235e7806c))
* **stacks:** Phase 1 — server, events, store, ws-router ([#48](https://github.com/cuongtranba/kanna/issues/48)) ([7abeff1](https://github.com/cuongtranba/kanna/commit/7abeff13a6a7293959d712a36b0480b5ea1e6787))
* **stacks:** Phase 2 — chat bindings + agent spawn wiring ([#50](https://github.com/cuongtranba/kanna/issues/50)) ([2295fc8](https://github.com/cuongtranba/kanna/commit/2295fc80f2a24815e9263040ab731d91efce8cab))
* **stacks:** Phase 3 — UI plan (draft, plan-only) ([#51](https://github.com/cuongtranba/kanna/issues/51)) ([4f52dac](https://github.com/cuongtranba/kanna/commit/4f52dace8ddc06f26c879b40a9b0151c0693031a))


### Bug Fixes

* **bg-tasks:** remove duplicate "Background tasks" header ([#53](https://github.com/cuongtranba/kanna/issues/53)) ([029c957](https://github.com/cuongtranba/kanna/commit/029c957f44208df6aa4e85ef7ea4e1a611a4c776))
* **uploads:** raise Bun maxRequestBodySize to upload max ([#45](https://github.com/cuongtranba/kanna/issues/45)) ([68752f4](https://github.com/cuongtranba/kanna/commit/68752f4344c6ecf0dd6d760ef8aa238f4b2bfbf6))

## [0.45.0](https://github.com/cuongtranba/kanna/compare/v0.44.0...v0.45.0) (2026-05-10)


### Features

* **agent:** inline file downloads via offer_download SDK MCP tool ([#42](https://github.com/cuongtranba/kanna/issues/42)) ([20b2d99](https://github.com/cuongtranba/kanna/commit/20b2d998e532860551b22bd7dcd4b30ff1e436ef))
* **bg-tasks:** visibility and stop control for background tasks ([#38](https://github.com/cuongtranba/kanna/issues/38)) ([416bab5](https://github.com/cuongtranba/kanna/commit/416bab580b0cede033f6a16e2bce29026d472e10))
* **worktrees:** server git wrapper (phase 1) ([#44](https://github.com/cuongtranba/kanna/issues/44)) ([8c1553c](https://github.com/cuongtranba/kanna/commit/8c1553c8c8e0b0bb3d64b70b4b23eae4acfb6299))


### Bug Fixes

* **push:** skip push when chat is currently open ([#41](https://github.com/cuongtranba/kanna/issues/41)) ([f6c6bf2](https://github.com/cuongtranba/kanna/commit/f6c6bf23b4ccb658a6ea81c048947bdc3a035050))

## [0.44.0](https://github.com/cuongtranba/kanna/compare/v0.43.2...v0.44.0) (2026-05-08)


### Features

* **uploads:** configurable max file size + upload progress UI ([#37](https://github.com/cuongtranba/kanna/issues/37)) ([220d590](https://github.com/cuongtranba/kanna/commit/220d590f541d7e13bce1499484380f5d9be0c87b))


### Bug Fixes

* **agent:** clear stuck Running state after cancel-then-steer ([#39](https://github.com/cuongtranba/kanna/issues/39)) ([c951f1c](https://github.com/cuongtranba/kanna/commit/c951f1c8e941b300f488bda7db31189a2a36895a))
* **chat-input:** show attach button on desktop ([#35](https://github.com/cuongtranba/kanna/issues/35)) ([40c8c8e](https://github.com/cuongtranba/kanna/commit/40c8c8eb50ba95381a5279f0319b76b5d5c68643))

## [0.43.2](https://github.com/cuongtranba/kanna/compare/v0.43.1...v0.43.2) (2026-05-06)


### Bug Fixes

* **terminals:** stop dev process leaks on project remove, shell exit, SIGHUP, and crash ([#33](https://github.com/cuongtranba/kanna/issues/33)) ([7d872c1](https://github.com/cuongtranba/kanna/commit/7d872c1dbfa967baae5ccae8f390adb23c6753eb))

## [0.43.1](https://github.com/cuongtranba/kanna/compare/v0.43.0...v0.43.1) (2026-05-06)


### Bug Fixes

* **diff-store:** harden git spawns and add CI test workflow ([#31](https://github.com/cuongtranba/kanna/issues/31)) ([fe874fb](https://github.com/cuongtranba/kanna/commit/fe874fbfdaa5c670d2c083c4e044b5984bd21028))

## [0.43.0](https://github.com/cuongtranba/kanna/compare/v0.42.6...v0.43.0) (2026-05-06)


### Features

* **timings:** chat session timings UI ([#28](https://github.com/cuongtranba/kanna/issues/28)) ([2f50b22](https://github.com/cuongtranba/kanna/commit/2f50b22d1f21b1b2760cb02f5af5c5d1a7e885cf))


### Bug Fixes

* **agent:** set claude_code preset with trust context to stop spurious malware refusals ([a38ec31](https://github.com/cuongtranba/kanna/commit/a38ec3113391c4aef22530a0595d195ecc26ef19))

## [0.42.6](https://github.com/cuongtranba/kanna/compare/v0.42.5...v0.42.6) (2026-05-05)


### Bug Fixes

* **quick-response:** unblock Haiku title gen in nested CC sessions ([fff7fa4](https://github.com/cuongtranba/kanna/commit/fff7fa4e21aef17263cddd3506b1776e8a6682a2))

## [0.42.5](https://github.com/cuongtranba/kanna/compare/v0.42.4...v0.42.5) (2026-05-05)


### Bug Fixes

* **push:** use /chat singular route in notification payload ([#24](https://github.com/cuongtranba/kanna/issues/24)) ([f7ee018](https://github.com/cuongtranba/kanna/commit/f7ee01838df257cf6c650f8e96c8c3b2feca1d74))

## [0.42.4](https://github.com/cuongtranba/kanna/compare/v0.42.3...v0.42.4) (2026-05-05)


### Bug Fixes

* **push:** include diagnostic delivery logging in release ([fb549a9](https://github.com/cuongtranba/kanna/commit/fb549a9c6fb2a9ee91c603a797ddcb7dfe31f5b0))

## [0.42.3](https://github.com/cuongtranba/kanna/compare/v0.42.2...v0.42.3) (2026-05-05)


### Bug Fixes

* **test:** make pushClient tests robust to readonly globalThis.window ([#20](https://github.com/cuongtranba/kanna/issues/20)) ([18451f0](https://github.com/cuongtranba/kanna/commit/18451f08d90296c79192300f4dbcd3c68d692cf7))

## [0.42.2](https://github.com/cuongtranba/kanna/compare/v0.42.1...v0.42.2) (2026-05-05)


### Bug Fixes

* **push:** use real mailto for VAPID subject ([#18](https://github.com/cuongtranba/kanna/issues/18)) ([df5fd48](https://github.com/cuongtranba/kanna/commit/df5fd48878368cf4f71219a1d03d2cea11f1f057))

## [0.42.1](https://github.com/cuongtranba/kanna/compare/v0.42.0...v0.42.1) (2026-05-05)


### Bug Fixes

* **settings:** repair push notifications UI overflow ([#16](https://github.com/cuongtranba/kanna/issues/16)) ([ac39fcd](https://github.com/cuongtranba/kanna/commit/ac39fcdc27497e81aa8b36c1d9f95eaf6e1401ec))

## [0.42.0](https://github.com/cuongtranba/kanna/compare/v0.41.0...v0.42.0) (2026-05-04)


### Features

* **agent:** emit session_commands_loaded on Claude session start ([ada47a3](https://github.com/cuongtranba/kanna/commit/ada47a32d962c05b5e1fad141942b7a09915c3f1))
* **agent:** expose getSupportedCommands on Claude harness ([5416847](https://github.com/cuongtranba/kanna/commit/541684778152845408f548a4b184e9fb76d0e6ae))
* always-on sidebar RELOAD button + design polish ([b341e37](https://github.com/cuongtranba/kanna/commit/b341e3783c59ec79bd312c3e209beaf8a28fbcc6))
* **auth:** persist sessions across restart and browser close ([#10](https://github.com/cuongtranba/kanna/issues/10)) ([2734f51](https://github.com/cuongtranba/kanna/commit/2734f51a582ebf2d5895a2f7e8021e8274a99d4e))
* **auto-continue:** auto-resume chats on rate-limit reset ([#2](https://github.com/cuongtranba/kanna/issues/2)) ([bd67cd8](https://github.com/cuongtranba/kanna/commit/bd67cd8f485a7f505f9d99a5c07f2a0c88c4ee87))
* **chat-ui:** @ mention file picker ([7f23523](https://github.com/cuongtranba/kanna/commit/7f23523b4b820f8f57dde45b7b5552b55a2c1832))
* **chat-ui:** add SlashCommandPicker component ([492a61a](https://github.com/cuongtranba/kanna/commit/492a61a6b3fb53fa6083157262bb93e027a4f92c))
* **chat-ui:** skeleton rows while slash commands load ([b3a4fba](https://github.com/cuongtranba/kanna/commit/b3a4fbab56463255be00e195d707f8ae1c78f52f))
* **chat-ui:** wire slash command picker into ChatInput ([41d1d22](https://github.com/cuongtranba/kanna/commit/41d1d22ba68b76ff1a94ba57277e02da51fbe16e))
* **client:** add slash command filter and picker-open utils ([5ebb58c](https://github.com/cuongtranba/kanna/commit/5ebb58c3fc577b72e86a9f731ce78b5a3290c6dc))
* **client:** add slash commands store ([e7af522](https://github.com/cuongtranba/kanna/commit/e7af5220fae38fb21a42e4b05eb1611c4f3d38d1))
* **client:** add useSlashCommands hook ([fc213ed](https://github.com/cuongtranba/kanna/commit/fc213ede672168c702e76c8649816e40efc04f68))
* **client:** populate slash commands store from chat snapshot ([65c2510](https://github.com/cuongtranba/kanna/commit/65c2510ed50d7e36e2729e2bb68f26dd0615b790))
* **event-store:** record session_commands_loaded events ([4415aab](https://github.com/cuongtranba/kanna/commit/4415aab1eff13a92ba895c87f9f41e07c8b593d5))
* **events:** add session_commands_loaded turn event ([374e550](https://github.com/cuongtranba/kanna/commit/374e5506b63125921b0d81a27a7809c8854a5674))
* **import:** add Claude Code session record types ([f5e1f64](https://github.com/cuongtranba/kanna/commit/f5e1f64efccd605572813e0aef93b801c1b79eba))
* **import:** add Import button to sidebar header ([0759563](https://github.com/cuongtranba/kanna/commit/075956393c9d0a3345c7dc4e8f357007f0633d7b))
* **import:** add importClaudeSessions state hook ([5e7e491](https://github.com/cuongtranba/kanna/commit/5e7e4916b1132d49ba4cb14a06c51f98e48a7b1e))
* **import:** add sessions.importClaude WS command ([83219b1](https://github.com/cuongtranba/kanna/commit/83219b168908af49b3b22e3a75fab6f25ad71865))
* **import:** append new messages when source JSONL changes ([f9fe383](https://github.com/cuongtranba/kanna/commit/f9fe383f246e00576a03b3f1b2759c40cb4279be))
* **import:** handle sessions.importClaude over WebSocket ([52487bc](https://github.com/cuongtranba/kanna/commit/52487bcc8c522dd2fa35d5e5afb7d6ef86d39b15))
* **import:** map Claude session records to Kanna transcript entries ([00706a0](https://github.com/cuongtranba/kanna/commit/00706a0a557bd48708531fd1255eb467b986697e))
* **import:** orchestrate import with dedup and event emission ([f131f69](https://github.com/cuongtranba/kanna/commit/f131f69333870f7c18fd3e248b654f7b490032a3))
* **import:** parse Claude Code session JSONL files ([46b96bb](https://github.com/cuongtranba/kanna/commit/46b96bb94b9114628d2d88785678d586016abba4))
* **import:** scan ~/.claude/projects for session files ([c6e369f](https://github.com/cuongtranba/kanna/commit/c6e369f5ac88e744bf9147b1ebd64236d2a0d119))
* **import:** surface updated count in import result alert ([2529569](https://github.com/cuongtranba/kanna/commit/252956994b353786ffb80d708793936c294d79e6))
* **import:** track source file md5 on chats for change detection ([02ad85d](https://github.com/cuongtranba/kanna/commit/02ad85d48ac0bbfd95da0072f510e65c7acbb962))
* pm2 update reloader + swappable update strategy ([4a36d0b](https://github.com/cuongtranba/kanna/commit/4a36d0befb71bd07cb4fe86fed2a941003a5d02f))
* **pm2:** forward cloudflared token + password via scripts/pm2.env ([3c7a250](https://github.com/cuongtranba/kanna/commit/3c7a2506d394487f5666a07e42120ba2957fe569))
* **push:** web push notifications for chat state changes ([#11](https://github.com/cuongtranba/kanna/issues/11)) ([8ecb9d1](https://github.com/cuongtranba/kanna/commit/8ecb9d1b76674a22482b086af033c6e2196bec1c))
* **read-models:** expose slashCommands on ChatSnapshot ([2846ffb](https://github.com/cuongtranba/kanna/commit/2846ffb4c109f784b5e6727bff37ff3215dec218))
* support serving kanna from a subpath ([72ead70](https://github.com/cuongtranba/kanna/commit/72ead70599bfc99e7b1f4e5a4f9369eed570dd94))
* **tunnel:** cloudflare quick-tunnel auto-expose ([#3](https://github.com/cuongtranba/kanna/issues/3)) ([7a3d365](https://github.com/cuongtranba/kanna/commit/7a3d3653230a98131e30b7d765b3b3c73bd18348))
* **types:** add SlashCommand type and ChatSnapshot.slashCommands ([e432971](https://github.com/cuongtranba/kanna/commit/e4329711c371360bff5c29a29cb50498baa3a2f4))
* **user-message:** render steer icon left of bubble for mid-turn messages ([e251047](https://github.com/cuongtranba/kanna/commit/e251047ba5a1cb8541436c9865173b79cdf40e3e))


### Bug Fixes

* add chat auto-scroll setting ([d314796](https://github.com/cuongtranba/kanna/commit/d3147969201af2b6b5b323f9cfc3b21b670e6587))
* **agent:** pre-warm slash commands on chat subscribe ([4c4ee81](https://github.com/cuongtranba/kanna/commit/4c4ee81d007c9a1b87e3ba085c5bbca3b45b9637))
* **auto-continue:** detect rate-limit from stream result text ([29ae73c](https://github.com/cuongtranba/kanna/commit/29ae73cd35da5018d2d0e4af3a9a1c1ebbd7327a))
* **auto-continue:** parse minutes in rate-limit reset text ([bf0f33e](https://github.com/cuongtranba/kanna/commit/bf0f33e97ea9319343374a0f9ec336e6e9161377))
* avoid autofocus for existing chat history ([8a98fd5](https://github.com/cuongtranba/kanna/commit/8a98fd59c0590d489d7f0c9754578e66659fc763))
* **chat-ui:** align slash picker columns, prevent wrap ([0da17a1](https://github.com/cuongtranba/kanna/commit/0da17a15ceb1ee0a343033a983f0379a65430856))
* **chat-ui:** dismiss picker after accepting a command ([321823a](https://github.com/cuongtranba/kanna/commit/321823a66cd4a0eaa5c1eb6f0617fead2afd98ec))
* **chat-ui:** show full slash command name, responsive picker ([31f2aa5](https://github.com/cuongtranba/kanna/commit/31f2aa5fad120be039de2acadb19e72702b58a51))
* **chat:** surface tool and action card errors in UI ([8533147](https://github.com/cuongtranba/kanna/commit/85331479c26018a5c07871ed0b3ffcf1fffc204a))
* close mobile sidebar after chat selection ([b4b5c6f](https://github.com/cuongtranba/kanna/commit/b4b5c6fe10e3f7f4737369bbd52bf84924d6b418))
* **diff-store:** use main as default branch and support Git &lt; 2.38 ([c22f2a7](https://github.com/cuongtranba/kanna/commit/c22f2a796fd8253bf3a24652e6430c4198a44232))
* **import:** extract title from array-form user content ([026ac34](https://github.com/cuongtranba/kanna/commit/026ac34c2150dede9fabd30efc4be6e4214232bb))
* **import:** harden parser against stat errors and use symmetric timestamp sentinels ([18cd8d0](https://github.com/cuongtranba/kanna/commit/18cd8d0674f7b49fdd5f017cab12b2b8b853d7e9))
* keep chat switches pinned to latest message ([ad73460](https://github.com/cuongtranba/kanna/commit/ad73460990d3b0db932ea2f4c8fd16227ca05b2b))
* **npm:** rename package scope to [@cuongtran001](https://github.com/cuongtran001) to match npm account ([bd2c0d0](https://github.com/cuongtranba/kanna/commit/bd2c0d0e3d6df02712017a0facd023a463412b87))
* **pm2:** use ./bin/kanna shebang to bypass pm2 require-based fork wrapper ([13a6e0c](https://github.com/cuongtranba/kanna/commit/13a6e0c690f664ac23c2320de8f0e4362fca5d85))
* restore chat title fallback generation ([40bc694](https://github.com/cuongtranba/kanna/commit/40bc69461418462710b96b7a4e38582e9d2320c7))
* restore kanna client bundle build ([38dc79b](https://github.com/cuongtranba/kanna/commit/38dc79b5d3f7049c9d814ae2adc6793ce607a022))
* **server:** fall back to bundled cloudflared binary ([d539bae](https://github.com/cuongtranba/kanna/commit/d539bae7d87ccb3c7e8490dc1ac03d4b12e7dd07))
* **sidebar:** allow touch scroll past project headers ([ecb97d8](https://github.com/cuongtranba/kanna/commit/ecb97d80ba4f1a637adecd3c33533032f0d3e8dd))
* stop forcing transcript autoscroll ([cc39984](https://github.com/cuongtranba/kanna/commit/cc39984f4b6ca6281b566bcfe6d7aa4ca48886a3))
* **terminal-manager:** prevent zsh-newuser-install dialog in tests ([ac22810](https://github.com/cuongtranba/kanna/commit/ac22810cc57f70124189f16c34a807c3f2d9a9ff))
* **tests:** use Object.defineProperty to override read-only globalThis props ([aea7eba](https://github.com/cuongtranba/kanna/commit/aea7eba77461bfc3225dd1f7cd99e8c7a5cf3520))
* **tunnel:** hide card when dismissing a proposed tunnel ([097cc23](https://github.com/cuongtranba/kanna/commit/097cc2323e6cdea8bf2ec4ebebbd2513141d209b))
* **update:** drop pm2 IPC reload to avoid "Reload in progress" error ([0629f04](https://github.com/cuongtranba/kanna/commit/0629f04f7b02615297dac67fb530c64c3843a394))
* **update:** re-deploy installs current version when latest is stale ([7deece0](https://github.com/cuongtranba/kanna/commit/7deece0e12556ce4f252d3e16acd6a3963a43980))

## [0.41.0](https://github.com/cuongtranba/kanna/compare/v0.40.1...v0.41.0) (2026-05-04)


### Features

* **push:** web push notifications for chat state changes ([#11](https://github.com/cuongtranba/kanna/issues/11)) ([8ecb9d1](https://github.com/cuongtranba/kanna/commit/8ecb9d1b76674a22482b086af033c6e2196bec1c))

## [0.40.1](https://github.com/cuongtranba/kanna/compare/v0.40.0...v0.40.1) (2026-04-30)


### Bug Fixes

* **tunnel:** hide card when dismissing a proposed tunnel ([097cc23](https://github.com/cuongtranba/kanna/commit/097cc2323e6cdea8bf2ec4ebebbd2513141d209b))

## [0.40.0](https://github.com/cuongtranba/kanna/compare/v0.39.2...v0.40.0) (2026-04-29)


### Features

* **auth:** persist sessions across restart and browser close ([#10](https://github.com/cuongtranba/kanna/issues/10)) ([2734f51](https://github.com/cuongtranba/kanna/commit/2734f51a582ebf2d5895a2f7e8021e8274a99d4e))


### Bug Fixes

* **chat:** surface tool and action card errors in UI ([8533147](https://github.com/cuongtranba/kanna/commit/85331479c26018a5c07871ed0b3ffcf1fffc204a))
* **server:** fall back to bundled cloudflared binary ([d539bae](https://github.com/cuongtranba/kanna/commit/d539bae7d87ccb3c7e8490dc1ac03d4b12e7dd07))

## [0.39.2](https://github.com/cuongtranba/kanna/compare/v0.39.1...v0.39.2) (2026-04-29)


### Bug Fixes

* **npm:** rename package scope to [@cuongtran001](https://github.com/cuongtran001) to match npm account ([bd2c0d0](https://github.com/cuongtranba/kanna/commit/bd2c0d0e3d6df02712017a0facd023a463412b87))

## [0.39.1](https://github.com/cuongtranba/kanna/compare/v0.39.0...v0.39.1) (2026-04-29)


### Bug Fixes

* **update:** re-deploy installs current version when latest is stale ([7deece0](https://github.com/cuongtranba/kanna/commit/7deece0e12556ce4f252d3e16acd6a3963a43980))

## [0.39.0](https://github.com/cuongtranba/kanna/compare/v0.38.0...v0.39.0) (2026-04-29)


### Features

* **agent:** emit session_commands_loaded on Claude session start ([ada47a3](https://github.com/cuongtranba/kanna/commit/ada47a32d962c05b5e1fad141942b7a09915c3f1))
* **agent:** expose getSupportedCommands on Claude harness ([5416847](https://github.com/cuongtranba/kanna/commit/541684778152845408f548a4b184e9fb76d0e6ae))
* always-on sidebar RELOAD button + design polish ([b341e37](https://github.com/cuongtranba/kanna/commit/b341e3783c59ec79bd312c3e209beaf8a28fbcc6))
* **auto-continue:** auto-resume chats on rate-limit reset ([#2](https://github.com/cuongtranba/kanna/issues/2)) ([bd67cd8](https://github.com/cuongtranba/kanna/commit/bd67cd8f485a7f505f9d99a5c07f2a0c88c4ee87))
* **chat-ui:** @ mention file picker ([7f23523](https://github.com/cuongtranba/kanna/commit/7f23523b4b820f8f57dde45b7b5552b55a2c1832))
* **chat-ui:** add SlashCommandPicker component ([492a61a](https://github.com/cuongtranba/kanna/commit/492a61a6b3fb53fa6083157262bb93e027a4f92c))
* **chat-ui:** skeleton rows while slash commands load ([b3a4fba](https://github.com/cuongtranba/kanna/commit/b3a4fbab56463255be00e195d707f8ae1c78f52f))
* **chat-ui:** wire slash command picker into ChatInput ([41d1d22](https://github.com/cuongtranba/kanna/commit/41d1d22ba68b76ff1a94ba57277e02da51fbe16e))
* **client:** add slash command filter and picker-open utils ([5ebb58c](https://github.com/cuongtranba/kanna/commit/5ebb58c3fc577b72e86a9f731ce78b5a3290c6dc))
* **client:** add slash commands store ([e7af522](https://github.com/cuongtranba/kanna/commit/e7af5220fae38fb21a42e4b05eb1611c4f3d38d1))
* **client:** add useSlashCommands hook ([fc213ed](https://github.com/cuongtranba/kanna/commit/fc213ede672168c702e76c8649816e40efc04f68))
* **client:** populate slash commands store from chat snapshot ([65c2510](https://github.com/cuongtranba/kanna/commit/65c2510ed50d7e36e2729e2bb68f26dd0615b790))
* **event-store:** record session_commands_loaded events ([4415aab](https://github.com/cuongtranba/kanna/commit/4415aab1eff13a92ba895c87f9f41e07c8b593d5))
* **events:** add session_commands_loaded turn event ([374e550](https://github.com/cuongtranba/kanna/commit/374e5506b63125921b0d81a27a7809c8854a5674))
* **import:** add Claude Code session record types ([f5e1f64](https://github.com/cuongtranba/kanna/commit/f5e1f64efccd605572813e0aef93b801c1b79eba))
* **import:** add Import button to sidebar header ([0759563](https://github.com/cuongtranba/kanna/commit/075956393c9d0a3345c7dc4e8f357007f0633d7b))
* **import:** add importClaudeSessions state hook ([5e7e491](https://github.com/cuongtranba/kanna/commit/5e7e4916b1132d49ba4cb14a06c51f98e48a7b1e))
* **import:** add sessions.importClaude WS command ([83219b1](https://github.com/cuongtranba/kanna/commit/83219b168908af49b3b22e3a75fab6f25ad71865))
* **import:** append new messages when source JSONL changes ([f9fe383](https://github.com/cuongtranba/kanna/commit/f9fe383f246e00576a03b3f1b2759c40cb4279be))
* **import:** handle sessions.importClaude over WebSocket ([52487bc](https://github.com/cuongtranba/kanna/commit/52487bcc8c522dd2fa35d5e5afb7d6ef86d39b15))
* **import:** map Claude session records to Kanna transcript entries ([00706a0](https://github.com/cuongtranba/kanna/commit/00706a0a557bd48708531fd1255eb467b986697e))
* **import:** orchestrate import with dedup and event emission ([f131f69](https://github.com/cuongtranba/kanna/commit/f131f69333870f7c18fd3e248b654f7b490032a3))
* **import:** parse Claude Code session JSONL files ([46b96bb](https://github.com/cuongtranba/kanna/commit/46b96bb94b9114628d2d88785678d586016abba4))
* **import:** scan ~/.claude/projects for session files ([c6e369f](https://github.com/cuongtranba/kanna/commit/c6e369f5ac88e744bf9147b1ebd64236d2a0d119))
* **import:** surface updated count in import result alert ([2529569](https://github.com/cuongtranba/kanna/commit/252956994b353786ffb80d708793936c294d79e6))
* **import:** track source file md5 on chats for change detection ([02ad85d](https://github.com/cuongtranba/kanna/commit/02ad85d48ac0bbfd95da0072f510e65c7acbb962))
* pm2 update reloader + swappable update strategy ([4a36d0b](https://github.com/cuongtranba/kanna/commit/4a36d0befb71bd07cb4fe86fed2a941003a5d02f))
* **pm2:** forward cloudflared token + password via scripts/pm2.env ([3c7a250](https://github.com/cuongtranba/kanna/commit/3c7a2506d394487f5666a07e42120ba2957fe569))
* **read-models:** expose slashCommands on ChatSnapshot ([2846ffb](https://github.com/cuongtranba/kanna/commit/2846ffb4c109f784b5e6727bff37ff3215dec218))
* support serving kanna from a subpath ([72ead70](https://github.com/cuongtranba/kanna/commit/72ead70599bfc99e7b1f4e5a4f9369eed570dd94))
* **tunnel:** cloudflare quick-tunnel auto-expose ([#3](https://github.com/cuongtranba/kanna/issues/3)) ([7a3d365](https://github.com/cuongtranba/kanna/commit/7a3d3653230a98131e30b7d765b3b3c73bd18348))
* **types:** add SlashCommand type and ChatSnapshot.slashCommands ([e432971](https://github.com/cuongtranba/kanna/commit/e4329711c371360bff5c29a29cb50498baa3a2f4))
* **user-message:** render steer icon left of bubble for mid-turn messages ([e251047](https://github.com/cuongtranba/kanna/commit/e251047ba5a1cb8541436c9865173b79cdf40e3e))


### Bug Fixes

* add chat auto-scroll setting ([d314796](https://github.com/cuongtranba/kanna/commit/d3147969201af2b6b5b323f9cfc3b21b670e6587))
* **agent:** pre-warm slash commands on chat subscribe ([4c4ee81](https://github.com/cuongtranba/kanna/commit/4c4ee81d007c9a1b87e3ba085c5bbca3b45b9637))
* **auto-continue:** detect rate-limit from stream result text ([29ae73c](https://github.com/cuongtranba/kanna/commit/29ae73cd35da5018d2d0e4af3a9a1c1ebbd7327a))
* **auto-continue:** parse minutes in rate-limit reset text ([bf0f33e](https://github.com/cuongtranba/kanna/commit/bf0f33e97ea9319343374a0f9ec336e6e9161377))
* avoid autofocus for existing chat history ([8a98fd5](https://github.com/cuongtranba/kanna/commit/8a98fd59c0590d489d7f0c9754578e66659fc763))
* **chat-ui:** align slash picker columns, prevent wrap ([0da17a1](https://github.com/cuongtranba/kanna/commit/0da17a15ceb1ee0a343033a983f0379a65430856))
* **chat-ui:** dismiss picker after accepting a command ([321823a](https://github.com/cuongtranba/kanna/commit/321823a66cd4a0eaa5c1eb6f0617fead2afd98ec))
* **chat-ui:** show full slash command name, responsive picker ([31f2aa5](https://github.com/cuongtranba/kanna/commit/31f2aa5fad120be039de2acadb19e72702b58a51))
* close mobile sidebar after chat selection ([b4b5c6f](https://github.com/cuongtranba/kanna/commit/b4b5c6fe10e3f7f4737369bbd52bf84924d6b418))
* **diff-store:** use main as default branch and support Git &lt; 2.38 ([c22f2a7](https://github.com/cuongtranba/kanna/commit/c22f2a796fd8253bf3a24652e6430c4198a44232))
* **import:** extract title from array-form user content ([026ac34](https://github.com/cuongtranba/kanna/commit/026ac34c2150dede9fabd30efc4be6e4214232bb))
* **import:** harden parser against stat errors and use symmetric timestamp sentinels ([18cd8d0](https://github.com/cuongtranba/kanna/commit/18cd8d0674f7b49fdd5f017cab12b2b8b853d7e9))
* keep chat switches pinned to latest message ([ad73460](https://github.com/cuongtranba/kanna/commit/ad73460990d3b0db932ea2f4c8fd16227ca05b2b))
* **pm2:** use ./bin/kanna shebang to bypass pm2 require-based fork wrapper ([13a6e0c](https://github.com/cuongtranba/kanna/commit/13a6e0c690f664ac23c2320de8f0e4362fca5d85))
* restore chat title fallback generation ([40bc694](https://github.com/cuongtranba/kanna/commit/40bc69461418462710b96b7a4e38582e9d2320c7))
* restore kanna client bundle build ([38dc79b](https://github.com/cuongtranba/kanna/commit/38dc79b5d3f7049c9d814ae2adc6793ce607a022))
* **sidebar:** allow touch scroll past project headers ([ecb97d8](https://github.com/cuongtranba/kanna/commit/ecb97d80ba4f1a637adecd3c33533032f0d3e8dd))
* stop forcing transcript autoscroll ([cc39984](https://github.com/cuongtranba/kanna/commit/cc39984f4b6ca6281b566bcfe6d7aa4ca48886a3))
* **terminal-manager:** prevent zsh-newuser-install dialog in tests ([ac22810](https://github.com/cuongtranba/kanna/commit/ac22810cc57f70124189f16c34a807c3f2d9a9ff))
* **tests:** use Object.defineProperty to override read-only globalThis props ([aea7eba](https://github.com/cuongtranba/kanna/commit/aea7eba77461bfc3225dd1f7cd99e8c7a5cf3520))

## [0.35.0](https://github.com/cuongtranba/kanna/compare/v0.34.2...v0.35.0) (2026-04-28)


### Features

* **agent:** emit session_commands_loaded on Claude session start ([ada47a3](https://github.com/cuongtranba/kanna/commit/ada47a32d962c05b5e1fad141942b7a09915c3f1))
* **agent:** expose getSupportedCommands on Claude harness ([5416847](https://github.com/cuongtranba/kanna/commit/541684778152845408f548a4b184e9fb76d0e6ae))
* always-on sidebar RELOAD button + design polish ([b341e37](https://github.com/cuongtranba/kanna/commit/b341e3783c59ec79bd312c3e209beaf8a28fbcc6))
* **auto-continue:** auto-resume chats on rate-limit reset ([#2](https://github.com/cuongtranba/kanna/issues/2)) ([bd67cd8](https://github.com/cuongtranba/kanna/commit/bd67cd8f485a7f505f9d99a5c07f2a0c88c4ee87))
* **chat-ui:** @ mention file picker ([7f23523](https://github.com/cuongtranba/kanna/commit/7f23523b4b820f8f57dde45b7b5552b55a2c1832))
* **chat-ui:** add SlashCommandPicker component ([492a61a](https://github.com/cuongtranba/kanna/commit/492a61a6b3fb53fa6083157262bb93e027a4f92c))
* **chat-ui:** skeleton rows while slash commands load ([b3a4fba](https://github.com/cuongtranba/kanna/commit/b3a4fbab56463255be00e195d707f8ae1c78f52f))
* **chat-ui:** wire slash command picker into ChatInput ([41d1d22](https://github.com/cuongtranba/kanna/commit/41d1d22ba68b76ff1a94ba57277e02da51fbe16e))
* **client:** add slash command filter and picker-open utils ([5ebb58c](https://github.com/cuongtranba/kanna/commit/5ebb58c3fc577b72e86a9f731ce78b5a3290c6dc))
* **client:** add slash commands store ([e7af522](https://github.com/cuongtranba/kanna/commit/e7af5220fae38fb21a42e4b05eb1611c4f3d38d1))
* **client:** add useSlashCommands hook ([fc213ed](https://github.com/cuongtranba/kanna/commit/fc213ede672168c702e76c8649816e40efc04f68))
* **client:** populate slash commands store from chat snapshot ([65c2510](https://github.com/cuongtranba/kanna/commit/65c2510ed50d7e36e2729e2bb68f26dd0615b790))
* **event-store:** record session_commands_loaded events ([4415aab](https://github.com/cuongtranba/kanna/commit/4415aab1eff13a92ba895c87f9f41e07c8b593d5))
* **events:** add session_commands_loaded turn event ([374e550](https://github.com/cuongtranba/kanna/commit/374e5506b63125921b0d81a27a7809c8854a5674))
* **import:** add Claude Code session record types ([f5e1f64](https://github.com/cuongtranba/kanna/commit/f5e1f64efccd605572813e0aef93b801c1b79eba))
* **import:** add Import button to sidebar header ([0759563](https://github.com/cuongtranba/kanna/commit/075956393c9d0a3345c7dc4e8f357007f0633d7b))
* **import:** add importClaudeSessions state hook ([5e7e491](https://github.com/cuongtranba/kanna/commit/5e7e4916b1132d49ba4cb14a06c51f98e48a7b1e))
* **import:** add sessions.importClaude WS command ([83219b1](https://github.com/cuongtranba/kanna/commit/83219b168908af49b3b22e3a75fab6f25ad71865))
* **import:** append new messages when source JSONL changes ([f9fe383](https://github.com/cuongtranba/kanna/commit/f9fe383f246e00576a03b3f1b2759c40cb4279be))
* **import:** handle sessions.importClaude over WebSocket ([52487bc](https://github.com/cuongtranba/kanna/commit/52487bcc8c522dd2fa35d5e5afb7d6ef86d39b15))
* **import:** map Claude session records to Kanna transcript entries ([00706a0](https://github.com/cuongtranba/kanna/commit/00706a0a557bd48708531fd1255eb467b986697e))
* **import:** orchestrate import with dedup and event emission ([f131f69](https://github.com/cuongtranba/kanna/commit/f131f69333870f7c18fd3e248b654f7b490032a3))
* **import:** parse Claude Code session JSONL files ([46b96bb](https://github.com/cuongtranba/kanna/commit/46b96bb94b9114628d2d88785678d586016abba4))
* **import:** scan ~/.claude/projects for session files ([c6e369f](https://github.com/cuongtranba/kanna/commit/c6e369f5ac88e744bf9147b1ebd64236d2a0d119))
* **import:** surface updated count in import result alert ([2529569](https://github.com/cuongtranba/kanna/commit/252956994b353786ffb80d708793936c294d79e6))
* **import:** track source file md5 on chats for change detection ([02ad85d](https://github.com/cuongtranba/kanna/commit/02ad85d48ac0bbfd95da0072f510e65c7acbb962))
* pm2 update reloader + swappable update strategy ([4a36d0b](https://github.com/cuongtranba/kanna/commit/4a36d0befb71bd07cb4fe86fed2a941003a5d02f))
* **pm2:** forward cloudflared token + password via scripts/pm2.env ([3c7a250](https://github.com/cuongtranba/kanna/commit/3c7a2506d394487f5666a07e42120ba2957fe569))
* **read-models:** expose slashCommands on ChatSnapshot ([2846ffb](https://github.com/cuongtranba/kanna/commit/2846ffb4c109f784b5e6727bff37ff3215dec218))
* support serving kanna from a subpath ([72ead70](https://github.com/cuongtranba/kanna/commit/72ead70599bfc99e7b1f4e5a4f9369eed570dd94))
* **tunnel:** cloudflare quick-tunnel auto-expose ([#3](https://github.com/cuongtranba/kanna/issues/3)) ([7a3d365](https://github.com/cuongtranba/kanna/commit/7a3d3653230a98131e30b7d765b3b3c73bd18348))
* **types:** add SlashCommand type and ChatSnapshot.slashCommands ([e432971](https://github.com/cuongtranba/kanna/commit/e4329711c371360bff5c29a29cb50498baa3a2f4))
* **user-message:** render steer icon left of bubble for mid-turn messages ([e251047](https://github.com/cuongtranba/kanna/commit/e251047ba5a1cb8541436c9865173b79cdf40e3e))


### Bug Fixes

* add chat auto-scroll setting ([d314796](https://github.com/cuongtranba/kanna/commit/d3147969201af2b6b5b323f9cfc3b21b670e6587))
* **agent:** pre-warm slash commands on chat subscribe ([4c4ee81](https://github.com/cuongtranba/kanna/commit/4c4ee81d007c9a1b87e3ba085c5bbca3b45b9637))
* **auto-continue:** detect rate-limit from stream result text ([29ae73c](https://github.com/cuongtranba/kanna/commit/29ae73cd35da5018d2d0e4af3a9a1c1ebbd7327a))
* **auto-continue:** parse minutes in rate-limit reset text ([bf0f33e](https://github.com/cuongtranba/kanna/commit/bf0f33e97ea9319343374a0f9ec336e6e9161377))
* avoid autofocus for existing chat history ([8a98fd5](https://github.com/cuongtranba/kanna/commit/8a98fd59c0590d489d7f0c9754578e66659fc763))
* **chat-ui:** align slash picker columns, prevent wrap ([0da17a1](https://github.com/cuongtranba/kanna/commit/0da17a15ceb1ee0a343033a983f0379a65430856))
* **chat-ui:** dismiss picker after accepting a command ([321823a](https://github.com/cuongtranba/kanna/commit/321823a66cd4a0eaa5c1eb6f0617fead2afd98ec))
* **chat-ui:** show full slash command name, responsive picker ([31f2aa5](https://github.com/cuongtranba/kanna/commit/31f2aa5fad120be039de2acadb19e72702b58a51))
* close mobile sidebar after chat selection ([b4b5c6f](https://github.com/cuongtranba/kanna/commit/b4b5c6fe10e3f7f4737369bbd52bf84924d6b418))
* **diff-store:** use main as default branch and support Git &lt; 2.38 ([c22f2a7](https://github.com/cuongtranba/kanna/commit/c22f2a796fd8253bf3a24652e6430c4198a44232))
* **import:** extract title from array-form user content ([026ac34](https://github.com/cuongtranba/kanna/commit/026ac34c2150dede9fabd30efc4be6e4214232bb))
* **import:** harden parser against stat errors and use symmetric timestamp sentinels ([18cd8d0](https://github.com/cuongtranba/kanna/commit/18cd8d0674f7b49fdd5f017cab12b2b8b853d7e9))
* keep chat switches pinned to latest message ([ad73460](https://github.com/cuongtranba/kanna/commit/ad73460990d3b0db932ea2f4c8fd16227ca05b2b))
* **pm2:** use ./bin/kanna shebang to bypass pm2 require-based fork wrapper ([13a6e0c](https://github.com/cuongtranba/kanna/commit/13a6e0c690f664ac23c2320de8f0e4362fca5d85))
* restore chat title fallback generation ([40bc694](https://github.com/cuongtranba/kanna/commit/40bc69461418462710b96b7a4e38582e9d2320c7))
* restore kanna client bundle build ([38dc79b](https://github.com/cuongtranba/kanna/commit/38dc79b5d3f7049c9d814ae2adc6793ce607a022))
* **sidebar:** allow touch scroll past project headers ([ecb97d8](https://github.com/cuongtranba/kanna/commit/ecb97d80ba4f1a637adecd3c33533032f0d3e8dd))
* stop forcing transcript autoscroll ([cc39984](https://github.com/cuongtranba/kanna/commit/cc39984f4b6ca6281b566bcfe6d7aa4ca48886a3))
* **terminal-manager:** prevent zsh-newuser-install dialog in tests ([ac22810](https://github.com/cuongtranba/kanna/commit/ac22810cc57f70124189f16c34a807c3f2d9a9ff))
* **tests:** use Object.defineProperty to override read-only globalThis props ([aea7eba](https://github.com/cuongtranba/kanna/commit/aea7eba77461bfc3225dd1f7cd99e8c7a5cf3520))
