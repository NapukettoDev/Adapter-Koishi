# Bot 集成

`NapukettoBot` 是插件的默认导出，注册为 koishi 平台 `onebot`。它把 driver、IPC、登录状态、
事件桥、动作桥、控制台面板与数据库预热装配成 koishi 能驱动的 Bot。

涉及代码：`src/bot/`（Bot 外壳、生命周期、派发、编码器、启动与组件装配）、`src/database/`、`src/index.ts`。

## 平台注册与类静态成员

```ts
export class NapukettoBot extends Bot<SatoriContext, NapukettoBotConfig> { … }
export default NapukettoBot
```

- 上下文类型 `type SatoriContext = Bot["ctx"]`：即 Bot 基类约束的正主 satorijs Context，从 koishi
  重新导出的 `Bot` 上直接取，不再直接依赖 `@satorijs/core`；运行时传入的仍是 koishi.Context。
  用 koishi 自己的 Context 会在 `exactOptionalPropertyTypes` 下触发泛型逆变不兼容。
- **不写 `Adapter`**：koishi 的 `Bot` 构造会自动注册 `ctx.on("ready", () => this.start())`，
  直接 override `start()` / `stop()` 即可；`Adapter` 的 `fork/connect` 抽象是为 HTTP/WS 网络服务
  设计的，这里用不上。
- `static MessageEncoder` 用 cast 指向 `NapukettoMessageEncoder`：koishi 基类静态成员按 satorijs
  `Bot<cordis.Context>` 声明，与 koishi `Bot<koishi.Context>` 逆变不兼容；运行时行为不变。

`Config`、`usage`、`inject` 通过 `namespace NapukettoBot` 声明合并挂到**类上**：

| 成员 | 作用 |
| :--- | :--- |
| `NapukettoBot.Config` | koishi bots 配置校验；koishi 按 `bot.constructor.Config` 反射查找 |
| `NapukettoBot.usage` | 控制台插件详情页说明 |
| `NapukettoBot.inject` | `{ optional: ["database", "console"] }` |

**为什么挂在类上**：koishi loader 的 `unwrapExports = module.default || module` 会把默认导出解包成
类本身，模块级的 `usage` / `name` 导出会被丢弃，控制台读不到说明。`inject` 同理，且必须声明为
optional：未启用数据库/控制台插件时插件仍要能跑（控制台包本身是 peer，仍由宿主提供），optional
也避免 cordis 对未声明服务访问刷 `internal/warning`。

不能写 `export const name` 合并到类上：`Function.name` 是只读属性，ESM 严格模式下加载即抛
`TypeError`。插件名由 `package.json` 决定。

## 构造期装配

`constructor(ctx, config)` 顺序：

1. `super(ctx, config, "onebot")`。
2. 通过 `ctx.logger` 创建账号 logger `onebot-<selfId>` 并设置 `logLevel`。
   reggol 按名称存储等级，独立名称保留 Koishi 的日志输出渠道和 `onebot` 的等级配置。
3. `selfId = config.selfId`（satorijs accessor 写入 `user.id`）；`user.avatar` 指向
   `q.qlogo.cn` 头像。
4. `login = createLoginState(...)`：状态变化时同步 user 的 id/name 并推送控制台面板。
5. `createLifecycle(...)`：装配启停与登录控制器，事件桥在创建驱动时读取。
6. `panel = createPanel(...)` + `panel.setup(ctx)`：控制台服务就绪后装配 provider（见
   [控制台面板](console.md)）。
7. `createDispatcher(...)` 解析 `autoAssign` / `autoAuthorize`，并装配数据库预热和会话派发。
8. `bridge = createBridge(...)`：注入 `h`、平台名、selfId getter、收向语音富化、dispatch 回调。
9. `internal = createInternal(...)`：`request` 绑定 `clientRef`，client 未就绪时抛
   “子进程未就绪”。

实例间引用通过 getter 闭包读取，例如登录回调触发时才读取面板。

## 生命周期钩子

`src/bot/lifecycle.ts` 的 `BotLifecycleController` 持有驱动与会话连接。

| 时机 | 行为 |
| :--- | :--- |
| `start()` | `isActive` 时直接返回；`status = CONNECT`；复位登录快照/账号闸门/clientRef；等待进行中的 stop 与旧 driver 退出；创建**新 driver** → `driver.start()`；异常 `offline(error)` |
| driver `onReady` | `login.onReady()` → 账号校验 → `clientRef = driver.currentClient` → `online()` → `getLogin()`（失败只 warn） |
| driver `onExit` | `login.onExit()`（回 idle）；非主动断开且非账号不一致时 `offline()` |
| driver `onError` | warn 日志 + `offline(error)` |
| `stop()` | 递增停止序号、解除 driver 引用；等待 `driver.stop()`、`super.stop()` 和先前的停止任务 |
| `dispose()` | 由 Bot 基类处理（从 `ctx.bots` 移除并 stop） |

每次成功进入新轮次时创建新 driver（不在 `stopped` 实例上复用）；launch 每次 spawn 由 `buildLaunch`
重新组装。同一实例正常 `stop()` 后再次 `start()` 会重新 spawn 并重新 `online()`。旧 driver 的
迟到回调由 `isCurrent` 轮次校验丢弃，不会改写新一轮状态。driver 事件接线集中在
`driver-events.ts`：

| driver 事件 | 接线 |
| :--- | :--- |
| `onStatus` | debug 日志（引导阶段） |
| `onLogin` | `login.onLogin(state, selfInfo, message)`；`logged_in` 且带 `selfInfo` 时再调 `handleLoggedIn()` |
| `onQr` | `login.onQr(qr)` |
| `onEventSubscription` | `bridge.resetMessageBaseline()` |
| `onEvent` | debug 日志 + `bridge.handle(payload)` |
| `onReady` | `handleReady()` |
| `onExit` | `login.onExit()` + 非主动断开时 `offline()` |
| `onError` | warn + `offline(error)` |
| `onLog` | debug 日志（`[napuketto 子进程]`） |

所有回调先经过 `isCurrent()` 轮次校验。停止期间仍处理本轮的退出或超时，创建新驱动后才丢弃旧驱动回调。

## 动作方法

| 方法 | 实现 |
| :--- | :--- |
| `createDirectChannel(userId)` | `{ id: "private:<userId>", type: 1, name: userId }` |
| `getMessageList(channelId, next?, dir?, limit?)` | `internal.getMessageList` → `{ data, next? }` |
| `deleteMessage(channelId, messageId)` | `internal.deleteMessage` |
| `handleFriendRequest(messageId, approve, comment?)` | OB11 `set_friend_add_request` |
| `handleGuildMemberRequest(messageId, approve, comment?)` | OB11 `set_group_add_request` |
| `getLogin()` | 优先登录快照 `self`（同步 user、`selfId`）；否则 `internal.getSelf()` 兜底 |
| `getFriendList()` | `internal.getFriendList()` → `Universal.Friend` 列表 |
| `getGuildList()` | `internal.getGroupList()` → `Universal.Guild` 列表 |
| `getGuild(guildId)` | 从群列表查找，未命中抛错 |
| `getChannel(channelId)` | `private:` → DIRECT 频道；否则按群号查 `getGuild` → TEXT 频道 |

形状转换集中在 `transform.ts`（纯函数）：`toFriendList` / `toGuildList` /
`toDirectChannel` / `toTextChannel` / `toUserFields`。

`onOb11(listener)` 订阅 OB11 原始载荷并返回退订函数，独立于 [Koishi 事件转换](events.md#标准通知与请求)。

## dispatch 链路

kernel / OB11 事件 → 事件桥产出 `NapukettoSessionFields` → `SessionDispatcher.dispatch(fields)`：

1. `identityMismatch` 为真 → 直接丢弃（不得用错账号落库）。
2. 普通消息按需调用 `preheat(fields)` 预热 channel / user（见下节），失败不阻断。
3. `this.session({ type, subtype?, selfId, platform, timestamp, member? })`。
4. `applySessionFields(session, fields)`（见 [事件桥](events.md#session-写入规则)）。
5. 输出 info 日志。只有普通消息记录渲染文本。
6. `this.dispatch(session)`。

## 数据库预热

`NapukettoDatabase` 在 dispatch 前原子预热 channel 与 user，规避 koishi `getChannel` / `getUser`
的 check-then-act 并发竞态：多条消息同 tick 派发时，多个 SELECT 先于首个 INSERT 完成，随后
并发 INSERT 撞唯一键（`channel.id, platform` 或 `binding.pid, platform`）。

**channel**：

1. `get("channel", { id, platform }, ["id"])` 命中直接返回（绝大多数路径零写入）。
2. 未命中 `upsert("channel", [row], ["id", "platform"])`：`INSERT … ON CONFLICT DO UPDATE`，
   并发安全且幂等。
3. 先 `get` 命中即返回，所以已有行不会走到 upsert；只有并发 miss 的双 upsert 可能覆盖
   `createdAt`，毫秒级差异可忽略。

**user**：

1. `get("binding", { platform, pid }, ["aid"])` 命中直接返回。
2. 未命中 `create("user", { authority, locales: [], createdAt })`（user 表无唯一键，重复创建无害）。
3. `upsert("binding", [{ aid, bid, pid, platform }], ["pid", "platform"])` 幂等合并。

**策略与降级**：

| 条件 | 行为 |
| :--- | :--- |
| `autoAssign === false` | 跳过 channel 预热（保持 koishi 不落库语义） |
| `autoAuthorize === 0` | 跳过 user 预热（detached user） |
| `autoAssign` / `autoAuthorize` 是 Computed 函数 | 构造期取 koishi 默认值（`true` / `1`） |
| `ctx.database` 不可用或写入失败 | 单次 warn 后跳过，由 koishi 兜底；**绝不阻塞 dispatch** |
| 同一 channel / user 的并发消息 | per-key 串行队列（key = `channel:<platform>:<id>` / `user:<platform>:<userId>`），不同 key 并行 |

`NapukettoDatabase` 构造时收 `ctx.root`：root 的 internal 一定含 database，且 `checkInject` 对 root
放行，避免插件作用域访问服务时反复 emit warning。

## MessageEncoder

`NapukettoMessageEncoder extends MessageEncoder`：

- `prepare()`：channel 未带 `type` 时按 channelId 补（`private:` → DIRECT=1，否则 TEXT=0）；
  非私聊时 `guildId ??= channelId`。
- `visit(element)`：把 h 实例收集到数组（text 内容在 `attrs.content`）。
- `flush()`：一次性 `bot.internal.sendMessage(channelId, children, guildId)`；把 messageId、selfId、
  channelId、guildId、isDirect 填到新的 session，`app.emit(session, "send", session)`；若有
  `event.message` 则 push 到 `results`；清空收集数组。

元素到 canonical 的转换复用 `src/actions/elements.ts` 的 `toCanonicalElements()`，不重复实现。

## 纯逻辑与单测边界

这些文件运行时 import koishi，**不在单测中加载**：

`src/index.ts`、`src/bot/bot.ts`、`src/bot/message.ts`、`src/console/login-panel.ts`、
`src/bot/assembly.ts`、`src/console/entry.ts`、`src/config.ts`、
`src/console/provider.ts`。

`src/bot/driver-events.ts` 是例外：全部为 type-only import，运行时零 koishi 依赖，可直接单测。
`src/bot/launch.ts` 不 import koishi，但 `buildLaunch` 会真实 spawn，单测只覆盖纯函数
`resolveLaunchOptions`（注入假 QQ 解析）。

可单测的纯逻辑单独成文件并通过依赖注入解耦：

| 文件 | 测试方式 |
| :--- | :--- |
| `identity.ts` | 纯判定 + 注入式拒绝动作 |
| `dispatcher.ts` | 宽松 session 结构，直接断言字段 |
| `lifecycle.ts` | 注入 driver 与 Bot 能力，验证启停重叠和旧轮次回调 |
| `transform.ts` | 仅 import type `Universal` |
| `console/login-actions.ts` | 纯决策表 + mock executor |
| `bot/launch.ts` 的 `resolveLaunchOptions` | 注入假 `resolveQq`，不 spawn |
| `actions/` / `events/` 的映射 | mock request / mock h |

配置项与默认值见 [配置](../guides/configuration.md)。
