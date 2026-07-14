# Kanna 项目原理与架构分析

## 总体结论

Kanna 是一个运行在本机的 AI 编程工作台：它自己不实现模型推理，而是为 Claude Code 和 Codex CLI 提供统一的 Web 界面、会话管理、终端、Git、文件上传、计划审批和历史持久化能力。

它的核心价值可以概括为：

```text
React 浏览器界面
       ↕ WebSocket
Bun 本地服务
       ↕ 统一 Agent 协调层
Claude Agent SDK / Codex app-server
       ↕
项目目录、Git、终端和本地历史
```

## 一、项目基本信息

| 项目 | 当前信息 |
|---|---|
| 包名 | `kanna-code` |
| 本地版本 | `0.41.7` |
| 定位 | Claude Code 与 Codex CLI 的本地 Web UI |
| 运行时 | Bun 1.3.5+ |
| 前端 | React 19、React Router、Zustand、Tailwind、Radix UI、xterm.js |
| 后端 | Bun HTTP/WebSocket Server、TypeScript |
| Agent 接入 | Claude Agent SDK、Codex `app-server` JSON-RPC |
| 存储 | JSONL 事件日志、状态快照、每会话独立 transcript |
| 默认端口 | `127.0.0.1:3210` |
| 许可证 | MIT |
| TypeScript/TSX 规模 | 约 57,419 行，包含测试 |

主要项目信息位于 `package.json` 和 `README.md`。

启动方式：

```bash
bun install
bun run dev
```

或者安装全局包后，在任意项目目录运行：

```bash
kanna
```

生产构建由 Vite 生成前端资源，Bun 同时负责静态文件、HTTP API 和 WebSocket 服务。

## 二、启动原理

命令入口是 `bin/kanna`。

实际启动分成两层进程：

```text
kanna supervisor
    └── kanna server child process
            ├── Bun HTTP/WS Server
            ├── EventStore
            ├── AgentCoordinator
            ├── TerminalManager
            └── Codex/Claude sessions
```

外层 supervisor 位于 `src/server/cli-supervisor.ts`，主要作用是：

- 启动真正的 Kanna 子进程。
- 转发 `SIGINT`、`SIGTERM`。
- 更新安装完成后重新启动子进程。
- 防止自动更新造成无限重启循环。

内层 `src/server/cli.ts` 解析命令行参数，然后调用 `src/server/server.ts` 创建服务。

生产模式中，一个 Bun 服务同时处理：

- `/ws`：WebSocket。
- `/api/...`：上传、文件读取等 HTTP API。
- `/auth/...`：密码登录。
- `/health`：健康检查。
- 其他路径：Vite 构建出的 React SPA。

开发模式稍有不同：

```text
浏览器 → Vite 开发服务器
               ├── React HMR
               └── /ws、/api、/auth 代理到 Bun 后端
```

相关配置位于 `vite.config.ts` 和 `scripts/dev.ts`。

## 三、一条聊天消息如何运行

这是项目最重要的调用链。

### 1. 前端立即进行乐观更新

用户点击发送后，`src/client/app/useKannaState.ts` 会：

- 立即在浏览器内插入一条临时 `user_prompt`。
- 显示用户刚发送的内容，不等待服务器响应。
- 生成 `clientTraceId`，用于性能追踪。
- 发送 `chat.send` WebSocket 命令。

因此界面响应很快，即使 Agent 子进程还没有启动。

### 2. WebSocket 路由命令

WebSocket 协议定义在 `src/shared/protocol.ts`。

协议有三类客户端消息：

- `subscribe`：订阅聊天、侧边栏、Git、终端等数据。
- `unsubscribe`：取消订阅。
- `command`：执行发送消息、创建项目、提交 Git 等操作。

服务端通过 `src/server/ws-router.ts` 把 `chat.send` 转交给 `AgentCoordinator`。

### 3. AgentCoordinator 做发送前准备

核心协调器是 `src/server/agent.ts`。

它会依次：

1. 新聊天则先创建聊天记录。
2. 确定 provider、模型、推理强度和计划模式。
3. 给新聊天生成一个基于首条消息的临时标题。
4. 将真实用户消息写入 transcript。
5. 写入 `turn_started` 事件。
6. 在后台调用模型生成更合适的标题。
7. 启动或复用 Claude/Codex 会话。
8. 把当前聊天登记到内存中的 `activeTurns`。
9. 通知 WebSocket 路由重新推送快照。

### 4. Provider 返回流式事件

Claude 或 Codex 返回的文本、工具调用、文件修改、token 用量等事件，都会转换成统一的 `TranscriptEntry`：

```text
system_init
user_prompt
assistant_text
tool_call
tool_result
context_window_updated
compact_boundary
result
interrupted
```

这些类型定义在 `src/shared/types.ts`。

每个事件都先写入会话 transcript，然后服务器派生新的聊天快照并推给浏览器。

### 5. 前端重新水合工具调用

前端在 `src/client/lib/parseTranscript.ts` 中将：

```text
tool_call(id=123)
...
tool_result(toolId=123)
```

组合成一条完整的工具消息。这样 UI 可以显示：

- 执行的命令及结果。
- 读取或编辑了哪些文件。
- Todo/计划执行进度。
- AskUserQuestion 选项和回答。
- MCP、子 Agent 和 Web 搜索信息。

## 四、Claude 和 Codex 的接入差异

Kanna 使用了一个统一的 `HarnessTurn` 抽象，把两种完全不同的上游接口隐藏在协调器后面。

### Claude

Claude 通过 `@anthropic-ai/claude-agent-sdk` 的 `query()` 接入。

实现特点：

- 每个聊天尽量复用一个长生命周期 Claude query。
- 使用异步 prompt queue 给同一个会话继续发送消息。
- 保存 SDK 返回的 `session_id`，用于恢复和 fork。
- `AskUserQuestion` 和 `ExitPlanMode` 会暂停 Agent，等待浏览器响应。
- 模型和 plan permission mode 可以在复用会话中动态切换。

Claude 工具事件会由 `normalizeClaudeStreamMessage()` 转换成统一 transcript。

### Codex

Codex 接入位于 `src/server/codex-app-server.ts`。

Kanna 会为聊天启动：

```bash
codex app-server
```

然后通过标准输入输出发送一行一个 JSON 的 JSON-RPC 消息：

```text
initialize
thread/start、thread/resume 或 thread/fork
turn/start
turn/interrupt
```

Codex 发回的通知包括：

- `item/started`
- `item/completed`
- `turn/plan/updated`
- `thread/tokenUsage/updated`
- `thread/compacted`
- `turn/completed`

Kanna 再将这些通知转换成和 Claude 相同的 transcript 类型。

Codex 的计划模式不是直接复用 Claude 的实现。Codex 计划回合结束后，Kanna 会合成一个 `ExitPlanMode` 工具调用；用户批准后，再自动启动一个普通执行回合。

### Provider 的重要规则

聊天首次发送后，provider 会被固定在聊天记录上。后续消息即使带了另一个 provider 参数，协调器也优先使用聊天原有 provider。

如果要切换 provider，通常应该新建聊天。

## 五、消息排队、插话和取消

一个聊天同一时刻只允许有一个 active turn。

用户在 Agent 正在运行时继续发送，消息会进入持久化队列，而不是并行执行。当前回合结束后，协调器自动启动下一条消息。

“Steer/插话”的处理方式是：

1. 取消当前回合。
2. 将排队消息标记为 steered。
3. 给消息附加系统提示，告诉 Agent 这是用户在执行过程中追加的信息。
4. 立即启动新回合。

取消操作会先在 UI 层立即删除 active 状态，再以最多五秒的 best-effort 方式中断上游进程。因此即使 SDK 中断卡住，界面也不会一直停留在运行状态。

此外，Codex 可能在发出最终结果后仍有后台输出。Kanna 将这种状态称为 `draining`，允许用户在 UI 中单独停止剩余流。

## 六、WebSocket 的响应式快照机制

Kanna 没有让浏览器自己维护完整业务状态，而是采用订阅式快照：

```text
浏览器订阅 chat:123
        ↓
服务器从 EventStore + activeTurns 派生 ChatSnapshot
        ↓
状态变化时推送新快照
```

可订阅主题包括：

- `sidebar`
- `chat`
- `project-git`
- `local-projects`
- `terminal`
- `update`
- `keybindings`
- `app-settings`

服务端使用两个优化：

- 16ms 内发生的多次状态变化会合并广播。
- 每个连接保存上一次快照的 JSON 签名，相同快照不会重复发送。

聊天默认只加载最近 200 条 transcript；更早历史通过游标分页读取。

前端 `src/client/app/socket.ts` 还实现了：

- 15 秒心跳检查。
- 25 秒无消息后判断连接可能失效。
- 最长 5 秒的渐进重连退避。
- 页面重新聚焦、恢复可见或网络恢复时主动检查连接。
- 重连后自动恢复全部订阅。

## 七、存储原理

数据目录由 `src/shared/branding.ts` 定义：

```text
生产：~/.kanna/
开发：~/.kanna-dev/
```

当前实际结构大致是：

```text
~/.kanna/
├── data/
│   ├── projects.jsonl
│   ├── chats.jsonl
│   ├── queued-messages.jsonl
│   ├── turns.jsonl
│   ├── snapshot.json
│   ├── sidebar-order.json
│   ├── settings.json
│   └── transcripts/
│       └── <chat-id>.jsonl
├── keybindings.json
└── llm-provider.json
```

`src/server/event-store.ts` 使用串行 `writeChain`，保证同一个进程内的文件写入顺序。

元数据采用事件形式，例如：

```text
project_opened
chat_created
chat_renamed
chat_provider_set
turn_started
turn_finished
turn_failed
session_token_set
```

启动时先加载 `snapshot.json`，再重放快照之后的 JSONL 事件。事件日志超过 2 MB 时写入新快照并清空元数据日志。

这里有一个值得注意的源码现状：README 仍将 `messages.jsonl` 描述为当前消息存储，但当前实现已经迁移为 `transcripts/<chat-id>.jsonl`。`messages.jsonl` 主要用于旧版本迁移，不再是新消息的主要写入位置。

所以 Kanna 现在并不是“所有数据都严格事件溯源”：

- 项目、聊天、回合等元数据是事件日志。
- transcript 是每聊天一个追加文件。
- 设置、快捷键、侧边栏顺序是独立 JSON 文件。

这是一种实用型的 Event Sourcing/CQRS 混合设计。

## 八、终端、Git 和项目发现

### 嵌入式终端

`src/server/terminal-manager.ts` 使用：

- Bun 原生 `Bun.Terminal` 创建 PTY。
- 系统默认 shell。
- `@xterm/headless` 保存服务端终端状态。
- `@xterm/addon-serialize` 在新订阅者连接时恢复屏幕。
- WebSocket event 实时推送增量终端输出。

关闭终端时会尽量杀死整个进程组，避免 shell 启动的子进程残留。

该功能目前仅支持 macOS/Linux。

### Git 工作区

`src/server/diff-store.ts` 直接调用本地 `git` 和可选的 `gh` 命令，实现：

- 工作区 diff 和文件变更统计。
- 查看 patch。
- 初始化 Git。
- 创建、切换、同步和合并分支。
- 拉取远程、推送、发布分支。
- GitHub 仓库创建与 PR/分支信息。
- 选中文件提交。
- 丢弃和忽略文件。
- AI 生成 commit message。

Git 状态主要保存在内存中，并通过独立的 `project-git` 订阅推送，不属于 EventStore 的聊天历史。

### 项目自动发现

`src/server/discovery.ts` 会扫描：

- `~/.claude/projects`
- `~/.codex/session_index.jsonl`
- `~/.codex/sessions`
- `~/.codex/config.toml`

只保留当前仍存在的本地目录，然后按规范化路径去重。因此 Kanna 可以显示用户以前在 Claude Code 或 Codex 中使用过的项目。

## 九、标题和 Commit Message 的快速模型链

Kanna 有一套独立的 `QuickResponseAdapter`，用于短小的结构化任务，而不是正式聊天。

调用顺序是：

```text
用户配置的 OpenAI/OpenRouter/自定义接口
    ↓ 失败
Claude Haiku
    ↓ 失败
Codex 小模型
    ↓ 失败
本地规则兜底
```

它目前用于：

- 生成聊天标题。
- 生成 Git commit subject/body。

例如标题生成失败时，会直接截取用户首条消息作为本地标题，不影响正式聊天运行。

## 十、文件、分享和安全边界

上传文件保存在项目内部：

```text
<project>/.kanna/uploads/
```

导出的独立会话保存在：

```text
<project>/.kanna/exports/
```

附件路径会被追加到模型 prompt，让 Agent 能直接读取真实文件。

安全方面需要特别注意：

- 默认只绑定 `127.0.0.1`，这是合理的本地安全默认值。
- `--remote` 或 `--host 0.0.0.0` 会向局域网开放服务。
- `--share` 会通过 Cloudflare tunnel 暴露服务。
- 只有显式提供 `--password` 时才启用认证。
- 密码会换成内存 session token，Cookie 使用 `HttpOnly` 和 `SameSite=Strict`。
- 服务重启后内存 session 失效，需要重新登录。
- Codex 会以 `approvalPolicy: "never"` 和 `sandbox: "danger-full-access"` 启动。
- Claude 默认是 `acceptEdits` 权限模式。

因此 Kanna 的计划确认界面不是一个通用的命令安全沙箱；运行中的 Agent 对项目和本机工具拥有很高权限。公开分享时最好始终同时启用强密码。

普通聊天记录默认保存在本地，但有两个明确的网络出口：

- Analytics 默认开启，只发送版本、启动模式、项目/聊天操作等事件，不发送 transcript 内容；可在设置中关闭。
- 用户主动使用独立分享功能时，会将导出的会话和选择打包的附件上传到 `kanna.sh`。

## 十一、架构优点与当前边界

项目做得比较好的地方包括：

- Claude/Codex 事件被统一成同一种 transcript，前端复杂度显著降低。
- 会话 token 持久化，支持恢复和 fork。
- 乐观 UI、WebSocket 快照与工具结果水合配合得比较完整。
- 本地 JSONL 存储没有数据库部署成本。
- Git、终端和聊天处在同一项目上下文中。
- Provider 失败时，标题等辅助功能有多级回退。

当前边界包括：

- 它是单机、单进程、本地用户工具，不适合直接当多用户服务部署。
- active turn、终端和子进程状态只在内存中；服务重启后只能通过 session token 恢复上下文，不能恢复正在执行的任务。
- 每个活跃 Codex 聊天可能拥有自己的 `codex app-server` 子进程，大量并行聊天会增加资源占用。
- 快照去重虽然减少了网络发送，但仍需先构建并序列化快照；历史很大时可能成为性能热点。
- `ws-router.ts` 和 `agent.ts` 已经比较庞大，项目自己的 `docs/refactor-todo.md` 也记录了路由拆分、工具类型注册表等重构计划。
- README 的消息存储说明落后于当前源码。
- LICENSE 是 MIT，但版权声明中的姓名与许可正文中的姓名/公司不一致，发布前值得核对。

## 十二、当前验证结果

分析过程中没有修改项目业务代码。

当前工作区没有安装 `node_modules`。执行 `bun test` 后，Bun 报告：

- 279 项测试。
- 241 项通过。
- 38 项在模块加载阶段失败。
- 失败原因是缺少 `react`、`zustand`、`file-type`、Claude SDK 等依赖。
- 没有发现已经成功加载的测试出现断言失败。

因此可以确认大量纯逻辑测试是通过的，但在执行 `bun install` 之前，不能把当前 checkout 认定为“完整测试通过”状态。

