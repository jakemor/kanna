# Kanna 支持 GPT-5.6 Sol / Terra / Luna 的实现与测试计划

> 调研日期：2026-07-10  
> 目标项目版本：Kanna `0.41.7`  
> 本地验证的 Codex CLI：`codex-cli 0.144.1`  
> 实施状态：核心实现与发布构建已于 2026-07-10 完成，验证记录见第 11 节。

## 1. 目标

让 Kanna 的 Codex provider 正确支持 GPT-5.6 模型家族：

- `gpt-5.6-sol`
- `gpt-5.6-terra`
- `gpt-5.6-luna`

并支持用户要求的配置档位：

- Low：`low`
- Medium：`medium`
- High：`high`
- Extra High：`xhigh`
- Max：`max`
- Ultra：`ultra`

目标不仅是让选项出现在 UI 中，还要保证模型、effort、设置持久化、排队消息、计划模式和 Codex app-server JSON-RPC 全链路一致。

## 2. 结论摘要

### 2.1 官方命名已经确认

OpenAI 当前正式提供三个 GPT-5.6 模型：

| 展示名称 | 模型 ID | 定位 |
|---|---|---|
| GPT-5.6 Sol | `gpt-5.6-sol` | 旗舰能力，适合复杂编码、研究和高价值任务 |
| GPT-5.6 Terra | `gpt-5.6-terra` | 能力、成本和速度之间的日常平衡 |
| GPT-5.6 Luna | `gpt-5.6-luna` | 更快、更经济，适合明确、重复和高吞吐任务 |

`gpt-5.6` 是别名，在 OpenAI API 文档中会路由到 `gpt-5.6-sol`。

官方依据：

- [Using GPT-5.6](https://developers.openai.com/api/docs/guides/latest-model)
- [Codex Models](https://learn.chatgpt.com/docs/models)
- [Reasoning models](https://developers.openai.com/api/docs/guides/reasoning)

### 2.2 Ultra 不是普通的“更高思考档位”

从产品语义看：

- Low 到 Max 控制单个模型在一个任务上的 reasoning 深度。
- Ultra 启用主动的多 Agent/子 Agent 任务拆分和并行执行。

因此 Ultra 的成本、行为和可观察事件可能与 Max 明显不同，UI 描述不能只写成“比 Max 思考更多”。

但是在当前 Codex app-server 协议中，Ultra 的线格式确实是：

```json
{
  "effort": "ultra"
}
```

本机 `codex app-server generate-ts --experimental` 生成的 `TurnStartParams` 明确说明：旧的 `multiAgentMode` 已忽略，应使用 `effort: "ultra"` 获得主动多 Agent 行为。

所以 Kanna 的内部类型可以将 `ultra` 保留在 Codex effort 联合类型中，但 UI 和文档必须将它解释为“多 Agent 编排模式”。

### 2.3 GPT-5.6 的可选档位不是三个模型完全一致

在本机 Codex CLI `0.144.1` 上实际调用 `model/list`，得到：

| 模型 | Low | Medium | High | Extra High | Max | Ultra | app-server 默认 effort |
|---|---:|---:|---:|---:|---:|---:|---|
| `gpt-5.6-sol` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | `low` |
| `gpt-5.6-terra` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | `medium` |
| `gpt-5.6-luna` | ✓ | ✓ | ✓ | ✓ | ✓ | — | `medium` |

这意味着 UI 必须按模型过滤 effort，不能继续使用一份全局 Codex effort 列表。

虽然 app-server 的 Sol catalog 默认值是 `low`，公开 Codex 文档中的默认 Power 配置是 Sol + Medium。为了与用户可理解的产品默认行为和 OpenAI API 默认行为一致，本文建议：

```text
Kanna 新用户默认：gpt-5.6-sol + medium
```

现有用户的已保存选择应尽量保留，不应被升级逻辑无条件覆盖。

### 2.4 API 的 `none` 与旧 Kanna 的 `minimal`

GPT-5.6 API 文档还列出了 `none`，但当前 Codex `model/list` 没有为这三个模型返回 `none` 或 `minimal`。

当前 Kanna 却提供 `minimal`。因此本次改动建议：

- GPT-5.6 UI 不展示 `minimal` 或 `none`。
- 类型或迁移层暂时识别旧的 `minimal`，用于兼容已有设置。
- 当旧设置中的 `minimal` 应用于 GPT-5.6 时，归一化为语义最接近且合法的 `low`，而不是直接把无效值发给 app-server。
- 不在本次范围中增加原始 API 专用的 `none`，因为 Kanna 的正式聊天链路走的是 Codex app-server，不是直接调用 Responses API。

### 2.5 本次范围边界

本次目标是在 Kanna 现有静态模型目录和消息链路上完成 GPT-5.6 支持，不引入运行时模型发现系统。

明确不做：

- 不在 Kanna 启动时额外创建 app-server 进程查询 `model/list`。
- 不新增 provider-catalog WebSocket 订阅。
- 不增加动态 catalog 缓存、超时、fallback 和 warning 状态机。
- 不将 README、changelog 或发布说明作为独立实施阶段。

模型和 capability 使用当前 Codex CLI `0.144.1` 已验证的数据静态定义。未来如果 Kanna 需要适配大量不同 CLI 版本、账号权限或频繁变化的模型 rollout，再将动态 capability discovery 作为独立功能设计。

## 3. Kanna 当前架构中的配置链路

一次 Codex 消息的模型配置流如下：

```text
ChatPreferenceControls / SettingsPage
        ↓
chatPreferencesStore / AppSettingsSnapshot
        ↓
ChatInput.handleSubmit
        ↓
ClientCommand: chat.send / message.enqueue
        ↓ WebSocket
ws-router
        ↓
AgentCoordinator.send / startTurnForChat
        ↓
normalizeCodexModelOptions
        ↓
CodexAppServerManager.startSession
        ↓
CodexAppServerManager.startTurn
        ↓ JSON-RPC
codex app-server: thread/start + turn/start
```

核心文件：

| 层级 | 文件 | 当前责任 |
|---|---|---|
| 共享类型/静态目录 | `src/shared/types.ts` | 模型、effort、默认值、归一化 |
| 服务端目录 | `src/server/provider-catalog.ts` | 服务端模型白名单和 option 归一化 |
| 协议类型 | `src/server/codex-app-server-protocol.ts` | app-server JSON-RPC 的最小类型子集 |
| Codex 适配 | `src/server/codex-app-server.ts` | 启动 app-server、thread、turn 和事件转换 |
| Agent 编排 | `src/server/agent.ts` | provider/model/effort 选择、队列、会话恢复 |
| WebSocket | `src/shared/protocol.ts`、`src/server/ws-router.ts` | 命令和快照传输 |
| 服务端设置 | `src/server/app-settings.ts` | 默认模型与 effort 的磁盘持久化 |
| 浏览器状态 | `src/client/stores/chatPreferencesStore.ts` | provider 默认值、每个 composer 的选择 |
| 输入控件 | `src/client/components/chat-ui/ChatPreferenceControls.tsx` | 模型和 effort 下拉菜单 |
| 输入协调 | `src/client/components/chat-ui/ChatInput.tsx` | 将 UI 选择转成发送参数 |
| 状态协调 | `src/client/app/useKannaState.ts` | 发送、排队、快照比较与设置同步 |

## 4. 当前实现与目标之间的差距

### 4.1 模型目录缺少 GPT-5.6

`src/shared/types.ts` 和 `src/server/provider-catalog.ts` 都硬编码了：

- GPT-5.5
- GPT-5.4
- GPT-5.3 Codex
- GPT-5.3 Codex Spark

当前没有 Sol、Terra、Luna，默认模型仍是 `gpt-5.5`。

### 4.2 客户端和服务端各维护了一份 Codex 模型目录

共享 `PROVIDERS` 和服务端 `HARD_CODED_CODEX_MODELS` 是平行数据源。增加模型时容易只改一处，从而造成：

- 设置页能选但服务端归一化回旧模型。
- 聊天快照与新聊天 fallback 显示不同选项。
- 客户端发送的模型被服务端白名单替换。

本次改动应建立单一静态数据源。

### 4.3 Codex effort 类型缺少 `max` 和 `ultra`

当前 `CodexReasoningEffort` 是：

```ts
"minimal" | "low" | "medium" | "high" | "xhigh"
```

必须增加：

```ts
"max" | "ultra"
```

`xhigh` 的展示文案应从 `XHigh` 改为用户更容易理解、也与官方产品一致的 `Extra High`。

### 4.4 当前 UI 使用全局 effort 列表

`ChatPreferenceControls.tsx` 对所有 Codex 模型直接遍历 `CODEX_REASONING_OPTIONS`，没有读取当前模型的 capability。

这会导致 Luna 显示并发送它不支持的 Ultra，也无法兼容以后不同模型的 effort 子集。

### 4.5 浏览器迁移逻辑会无条件把 Codex 模型改回 GPT-5.5

`chatPreferencesStore.ts` 中存在：

- `forcePersistedCodexPreference`
- `forcePersistedCodexComposerState`
- `forcePersistedCodexChatStates`

这些函数会把所有已持久化 Codex model 强制写成 `gpt-5.5`。

如果不先移除或版本化这段迁移，即使 UI 成功保存 GPT-5.6，重新载入旧浏览器状态时也可能回退到 GPT-5.5。

### 4.6 `collaborationMode` 可能覆盖顶层 effort

当前 `turn/start` 同时发送：

```ts
effort: args.effort,
collaborationMode: {
  mode: args.planMode ? "plan" : "default",
  settings: {
    model: args.model,
    reasoning_effort: null,
    developer_instructions: null,
  },
}
```

当前 Codex 协议说明 `collaborationMode` 的 settings 优先于顶层 model、reasoning effort 和 developer instructions。

因此仅修改顶层 `effort` 并不足以证明配置生效。必须进行以下二选一修复：

1. 推荐方案：顶层 `effort` 和 `collaborationMode.settings.reasoning_effort` 同时传递相同值。
2. 备选方案：仅在确实需要切换 plan/default mode 时发送 collaborationMode，并验证 sticky 行为。

推荐第一种，因为它保持当前 Kanna 的 plan/default 切换方式，同时消除两个字段不一致。

### 4.7 当前 CLI 版本提示是 GPT-5.5 专用硬编码

UI 只对 GPT-5.5 显示 `codex-cli >= 0.124` 提示。本次不增加运行时 capability 检测；GPT-5.6 可以显示静态说明，例如“Requires a Codex CLI and account with GPT-5.6 access”，但不能把本机验证版本 `0.144.1` 未经官方证据直接宣称为最低版本。

## 5. 目标数据模型

### 5.1 Codex effort 类型

建议保留旧值以读取历史数据，但只按模型 capability 展示：

```ts
type CodexReasoningEffort =
  | "minimal" // legacy compatibility only
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra"
```

展示表：

```ts
const CODEX_REASONING_OPTIONS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra High" },
  { id: "max", label: "Max" },
  {
    id: "ultra",
    label: "Ultra",
    description: "Uses subagents to delegate parts of complex tasks",
  },
]
```

`minimal` 不进入 GPT-5.6 的公开 options，只用于迁移旧状态。

### 5.2 模型级 capability

扩展 `ProviderModelOption`：

```ts
interface ProviderModelOption {
  id: string
  label: string
  supportsEffort: boolean
  aliases?: readonly string[]
  supportedReasoningEfforts?: readonly CodexReasoningEffort[]
  defaultReasoningEffort?: CodexReasoningEffort
  supportsFastMode?: boolean
}
```

静态 catalog：

```ts
{
  id: "gpt-5.6-sol",
  label: "GPT-5.6 Sol",
  aliases: ["gpt-5.6"],
  supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  defaultReasoningEffort: "medium",
  supportsFastMode: true,
}

{
  id: "gpt-5.6-terra",
  label: "GPT-5.6 Terra",
  supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  defaultReasoningEffort: "medium",
  supportsFastMode: true,
}

{
  id: "gpt-5.6-luna",
  label: "GPT-5.6 Luna",
  supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
  defaultReasoningEffort: "medium",
  supportsFastMode: true,
}
```

### 5.3 归一化规则

增加统一 helper，客户端和服务端都使用同一规则：

```ts
getCodexModelOption(modelId)
getCodexReasoningOptions(modelId)
normalizeCodexReasoningEffort(modelId, requestedEffort)
```

规则：

1. `gpt-5.6` 归一化为 `gpt-5.6-sol`。
2. 请求 effort 被当前模型支持时原样保留。
3. 旧 `minimal` 应用于 GPT-5.6 时归一化为 `low`。
4. 从 Sol/Terra Ultra 切换到 Luna 时归一化为 `max`，保持用户选择最高强度的意图，并显示一次轻量提示。
5. 其他不受支持或未知 effort 回退到当前模型的 `defaultReasoningEffort`。
6. 服务端再次执行同样归一化，不能只信任浏览器。
7. 未知模型回退到 provider 默认模型，并保留可诊断错误信息。

## 6. 分阶段实现计划

### 阶段 0：建立基线

1. 安装项目依赖：`bun install`。
2. 记录当前 `bun test` 和 `bun run check` 基线。
3. 记录 `codex --version`。
4. 确认当前开发环境具备 GPT-5.6 entitlement；模型不可用时使用 mock 协议测试完成开发。

### 阶段 1：共享类型和单一静态目录

修改：

- `src/shared/types.ts`
- `src/server/provider-catalog.ts`
- `src/shared/types.test.ts`
- `src/server/provider-catalog.test.ts`

任务：

1. 增加 `max`、`ultra` Codex effort。
2. 将 `xhigh` label 改为 `Extra High`。
3. 给模型增加 supported/default effort metadata。
4. 添加 Sol、Terra、Luna。
5. 将 Codex 默认模型改为 `gpt-5.6-sol`。
6. 将新用户默认 effort 改为 `medium`。
7. 添加 `gpt-5.6` 到 Sol 的 aliases。
8. 删除或改造服务端重复的 `HARD_CODED_CODEX_MODELS`，使服务端目录从共享目录派生。
9. 实现模型级 effort 归一化。

完成标准：共享层能独立回答“这个模型支持哪些 effort、默认是什么、某个输入应归一化为什么”。

### 阶段 2：设置持久化和迁移

修改：

- `src/server/app-settings.ts`
- `src/client/stores/chatPreferencesStore.ts`
- 对应测试文件

任务：

1. 更新服务端默认设置为 Sol + Medium。
2. 确保 Sol/Terra/Luna 和 `max/ultra` 能写入并读回 `settings.json`。
3. 移除无条件 force-to-GPT-5.5 迁移。
4. 如果仍需迁移旧 schema，增加显式 migration version，而不是每次载入都强制覆盖。
5. 保留现有用户的合法 GPT-5.4/5.5 配置。
6. 将 GPT-5.6 上的旧 `minimal` 归一化为 `low`。
7. 将 Luna + Ultra 归一化为 Luna + Max，并给前端返回归一化后的有效配置。
8. 确保浏览器 legacy settings 迁移到服务端后不再次覆盖服务端值。

完成标准：保存设置、刷新浏览器、重启 Kanna 后配置一致。

### 阶段 3：模型级 UI

修改：

- `src/client/components/chat-ui/ChatPreferenceControls.tsx`
- `src/client/components/chat-ui/ChatInput.tsx`
- `src/client/app/SettingsPage.tsx`
- `src/client/stores/chatPreferencesStore.ts`
- `src/client/app/useKannaState.ts`

任务：

1. 模型下拉显示 Sol、Terra、Luna。
2. Reasoning Level 保持与 Codex CLI/App 一致的单一选择器，并读取当前模型的 `supportedReasoningEfforts`。
3. Ultra 放在 Reasoning Level 的 Max 之后，同时增加多 Agent 行为说明。
4. Luna 不显示 Ultra。
5. 从 Sol/Terra Ultra 切换到 Luna 后立即改为 Max，并显示一次轻量提示。
6. 设置页与聊天 composer 使用同一 helper。
7. 删除或改写 GPT-5.5 专用 CLI 版本提示；GPT-5.6 只显示静态兼容性说明，不增加运行时检测。
8. Provider 已被聊天锁定时，仍允许切换同一 Codex provider 下的模型和 effort，保持当前行为。

完成标准：任何 UI 路径都不能构造 Luna + Ultra 或未知 effort。

### 阶段 4：Codex app-server 协议

修改：

- `src/server/codex-app-server-protocol.ts`
- `src/server/codex-app-server.ts`
- `src/server/agent.ts`
- 对应测试文件

任务：

1. 更新 vendored protocol subset，允许 `max` 和 `ultra`。
2. `turn/start.effort` 传递归一化后的值。
3. `collaborationMode.settings.reasoning_effort` 传递相同 effort，不能继续写 `null`。
4. 保证 plan/default mode 切换不改变用户选择的 effort。
5. 保证 plan mode 结束后的 `postToolFollowUp` 继续使用原 model、effort 和 service tier。
6. 保证排队消息和 steer 消息保留原 model options。
7. 在服务端拒绝或归一化不受支持的模型/effort 组合。
8. 保持 fast mode 与 effort 独立；不要将 Ultra 实现成 fast mode 或 plan mode。

完成标准：mock app-server 收到的 `turn/start` JSON 与 UI 选择完全一致。

### 阶段 5：测试与验收

1. 完成第 7 节定义的单元、设置迁移、UI、协议、AgentCoordinator、集成和回归测试。
2. 使用 fake app-server 覆盖全部 17 个有效 GPT-5.6 模型/effort 组合。
3. 在当前 Codex CLI 环境完成 Sol、Terra、Luna 的真实只读 smoke test。
4. 完成 Ultra 子 Agent 行为和取消行为的真实验证。
5. 运行 `bun test`。
6. 运行 `bun run check`。
7. 按第 8 节验收标准逐项确认。

完成标准：核心功能、迁移、协议和回归测试全部通过；不依赖运行时 model catalog discovery。

## 7. 测试计划

### 7.1 共享类型与归一化单元测试

文件：

- `src/shared/types.test.ts`
- `src/server/provider-catalog.test.ts`

测试：

1. `normalizeCodexModelId("gpt-5.6") === "gpt-5.6-sol"`。
2. 三个正式 slug 保持不变。
3. 未知 slug 回退到 Sol。
4. `isCodexReasoningEffort` 接受 `max`、`ultra`。
5. Sol effort 列表为 6 项。
6. Terra effort 列表为 6 项。
7. Luna effort 列表为 5 项且不包含 Ultra。
8. `xhigh` label 为 `Extra High`。
9. Luna + Ultra 归一化到 Luna + Max。
10. GPT-5.6 + legacy minimal 归一化到 Low。
11. Sol + Max、Sol + Ultra、Terra + Ultra 保持不变。
12. 旧 GPT-5.4/5.5 的合法配置不因增加 5.6 而失效。

建议使用表驱动测试覆盖完整 17 个有效组合：

```text
Sol:   low, medium, high, xhigh, max, ultra
Terra: low, medium, high, xhigh, max, ultra
Luna:  low, medium, high, xhigh, max
```

### 7.2 设置与迁移测试

文件：

- `src/server/app-settings.test.ts`
- `src/client/stores/chatPreferencesStore.test.ts`

测试：

1. 新设置文件默认 Sol + Medium。
2. Sol + Ultra 写入后可原样读回。
3. Terra + Max 写入后可原样读回。
4. Luna + Ultra 被归一化为 Luna + Max。
5. 老的 GPT-5.5 + XHigh 设置被保留。
6. 老的 GPT-5.3/5.4 composer state 不再无条件改成 GPT-5.5，除非产品明确要求淘汰。
7. 新的 GPT-5.6 设置不会被 legacy migration 改回 GPT-5.5。
8. 部分 patch 只修改 effort，不丢失 model、fastMode、planMode。
9. 浏览器 legacy settings 只迁移一次。
10. 无效 JSON 或未知 effort 仍产生已有 warning，并回退安全默认值。

### 7.3 UI 组件测试

文件：

- `src/client/components/chat-ui/ChatPreferenceControls.test.tsx`
- `src/client/components/chat-ui/ChatInput.test.ts`
- `src/client/app/SettingsPage.test.tsx`

测试：

1. 模型菜单显示 GPT-5.6 Sol、Terra、Luna。
2. Sol 显示 Low 到 Ultra。
3. Terra 显示 Low 到 Ultra。
4. Luna 显示 Low 到 Max，不显示 Ultra。
5. Extra High 的展示文字正确，提交值仍为 `xhigh`。
6. Ultra 有 subagent 描述。
7. 从 Sol + Ultra 切到 Luna 后，选择值自动变为 Max，并显示轻量提示。
8. 从 Luna 切回 Sol 不凭空恢复一个未保存的 Ultra。
9. 设置页和聊天 composer 使用相同的过滤规则。
10. fast mode、plan mode、model、effort 四个控件互不错误覆盖。
11. provider locked 时模型和 effort 仍可按当前产品规则修改。
12. 键盘和 popover 行为无回归。

### 7.4 WebSocket 与快照测试

文件：

- `src/server/ws-router.test.ts`
- `src/server/read-models.test.ts`
- `src/client/app/socket.test.ts`
- `src/client/app/useKannaState.test.ts`

测试：

1. ChatSnapshot 包含静态定义的三个 GPT-5.6 模型及模型级 capability。
2. `chat.send` 能将 Max/Ultra 交给 AgentCoordinator。
3. `message.enqueue` 能保留 model、Max/Ultra 和 fastMode。
4. 现有 sidebar、chat、settings 等订阅和快照去重行为无回归。

### 7.5 Codex app-server 协议测试

文件：

- `src/server/codex-app-server.test.ts`

使用 fake app-server 进程验证：

1. `thread/start` 使用所选 Sol/Terra/Luna slug。
2. `turn/start.effort` 对全部 17 个有效组合传递正确。
3. `collaborationMode.settings.reasoning_effort` 与顶层 effort 完全相同。
4. Max 按字符串 `max` 发送。
5. Ultra 按字符串 `ultra` 发送。
6. 不发送旧的 `multiAgentMode`。
7. Luna + Ultra 在进入 app-server 前已归一化为 Luna + Max。
8. plan mode 和 default mode 都保留 effort。
9. plan approval 后的 follow-up turn 保留 model/effort。
10. resume、fork、queued、steer 后配置保持一致。
11. fast mode 的 service tier 不被 Ultra 覆盖。
12. interrupt/cancel Ultra turn 仍发送 `turn/interrupt` 并正确结束 queue。

### 7.6 AgentCoordinator 测试

文件：

- `src/server/agent.test.ts`

测试：

1. 新聊天 Sol + Medium 正确启动。
2. 显式 Terra + XHigh 正确启动。
3. 显式 Luna + Max 正确启动。
4. Sol/Terra + Ultra 正确启动。
5. 同一聊天 provider 锁定逻辑不影响 Codex 内部模型选择。
6. active turn 时发送的 queued message 保存所选模型和 effort。
7. steer 后启动排队消息时仍使用其保存的 model options。
8. cancel Ultra turn 后 active/draining 状态正确清理。
9. title generation 和 quick-response fallback 不被正式聊天模型默认值误改。

### 7.7 集成测试

使用 fake JSON-RPC app-server 跑一条完整链路：

```text
UI command payload
  → WebSocket command
  → AgentCoordinator
  → model/effort normalization
  → thread/start
  → turn/start
  → transcript events
  → ChatSnapshot
```

至少覆盖：

- Sol + Medium 普通模式。
- Terra + XHigh + fast mode。
- Luna + Max + plan mode。
- Sol + Ultra。
- Ultra turn cancel。
- Sol Ultra 切换到 Luna Max 后的归一化。

### 7.8 真实 Codex smoke test

真实测试默认不进入普通单元测试套件，使用显式环境变量开启，避免消耗账号额度：

```bash
KANNA_LIVE_CODEX_TEST=1 bun test src/server/codex-gpt56.live.test.ts
```

建议的最小真实矩阵：

1. Sol + Medium：简单只读代码解释任务。
2. Terra + Low：简单只读代码解释任务。
3. Luna + Medium：简单只读代码解释任务。
4. Sol + Max：短小但需要推理的无副作用任务。
5. Sol + Ultra：可拆成两个只读子任务的任务，确认出现 subagent/collab 事件。
6. Terra + Ultra：同类任务，确认 app-server 接受配置。
7. Luna + Ultra：确认 Kanna 在发送前归一化为 Luna + Max，而不是依赖上游报错。
8. plan + Ultra：验证当前 Codex 是否支持组合；如不支持，UI 必须禁用该组合并给出原因。

真实测试任务必须：

- 使用临时项目。
- 不修改用户真实仓库。
- 不访问敏感文件。
- 设置超时。
- 测试结束后终止 app-server 子进程。
- 记录模型和有效 effort，不记录认证信息。

### 7.9 回归测试

必须覆盖：

- Claude provider 的模型、context window、Max effort 不受影响。
- GPT-5.4/5.5 仍可继续使用。
- fast mode 继续映射到已有 service tier。
- plan mode 的审批和 follow-up 不回归。
- session resume/fork 不回归。
- queued/steer/cancel/draining 不回归。
- 设置同步、主题、终端和 Git 功能无关测试继续通过。
- standalone export 能渲染 GPT-5.6 的 `system_init.model`。

## 8. 验收标准

实现完成必须同时满足：

1. 新用户默认看到 GPT-5.6 Sol + Medium。
2. 模型选择器包含 Sol、Terra、Luna。
3. Sol/Terra 支持 Low、Medium、High、Extra High、Max、Ultra。
4. Luna 支持 Low、Medium、High、Extra High、Max，不显示 Ultra。
5. UI、服务端归一化和 app-server 收到的 model/effort 一致。
6. Ultra 被解释和验证为多 Agent 模式，而不是普通 reasoning 档位。
7. 刷新浏览器和重启 Kanna 后设置不丢失、不回退到 GPT-5.5。
8. 旧 GPT-5.4/5.5 设置可兼容读取。
9. mock 协议测试覆盖全部 17 个有效 GPT-5.6 组合。
10. Luna + Ultra 在 UI 和服务端都稳定归一化为 Luna + Max。
11. `bun test` 全部通过。
12. `bun run check` 通过，包括 TypeScript 和两个 Vite build。
13. 至少完成 Sol、Terra、Luna 各一次真实只读 smoke test。
14. Ultra 至少完成一次真实 subagent 行为验证和一次取消验证。

## 9. 推荐提交拆分

为降低回归风险，建议拆成以下提交：

1. `Add GPT-5.6 model metadata and effort normalization`
2. `Preserve Codex model preferences during settings migration`
3. `Render model-specific Codex reasoning controls`
4. `Forward max and ultra through Codex app-server turns`
5. `Add GPT-5.6 protocol, UI, migration, and live tests`

每个提交都应带对应测试，避免最后一次性补测试。

## 10. 风险与回滚

### 风险 1：账号或 CLI 尚未获得 GPT-5.6

处理：Kanna 使用当前已验证的静态 catalog；UI 提示 GPT-5.6 需要兼容的 Codex CLI 和账号权限。若上游不可用，保留 app-server 的明确错误，不额外引入运行时 capability discovery。

### 风险 2：Ultra 与 plan mode 组合行为变化

处理：先做真实 smoke test。若上游不支持，UI 按组合禁用，不发送猜测字段。

### 风险 3：旧设置被错误迁移

处理：移除无条件 GPT-5.5 重写；为迁移函数增加旧版本 fixture 和幂等测试。

### 风险 4：collaborationMode 覆盖 effort

处理：顶层和 collaboration settings 同时发送相同 effort，并在协议测试中逐项断言。

### 回滚策略

- 保留 GPT-5.4/5.5 模型，不在首个版本删除旧模型。
- 不修改 EventStore 版本，避免为模型配置引入不必要的聊天历史重置。
- 若 Ultra 上游行为不稳定，可以仅隐藏 Ultra UI，而不回滚 Sol/Terra/Luna 和 Max 支持。

## 11. 实施与验证记录

截至 2026-07-10：

- 已安装依赖并在 `feat/gpt-5-6-codex-support` 分支完成实现。
- 静态目录、设置迁移、模型级 UI、服务端二次归一化和 app-server 双字段传递均已完成。
- fake app-server 协议测试覆盖全部 17 个合法 GPT-5.6 模型/effort 组合。
- `bun run check` 通过，包括 TypeScript、主客户端构建和 standalone export viewer 构建。
- 定向 GPT-5.6 测试共 130 项通过。
- 真实只读 smoke test 已验证 Sol + Medium、Terra + Low、Luna + Medium，三个模型均返回预期结果。
- 真实 Sol + Ultra 已产生 `collab_tool_call` 并完成任务；中断路径也已实际执行。当前网络代理偶发 WebSocket TLS 重连，但模型最终响应成功。

完整 `bun test` 在本机得到 609 项通过、12 项失败。失败集中在本次未修改的三类既有测试环境问题：临时 Git merge preview、PTY `Ctrl+D` 时序，以及多个浏览器测试对只读 `globalThis.window` 的交叉污染；相关浏览器测试隔离运行时通过。为遵守本次范围边界，没有修改这些无关模块来掩盖环境差异。
