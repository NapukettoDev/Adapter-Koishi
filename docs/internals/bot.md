# Bot 集成

`NapukettoBot` 是插件的默认导出，注册为 koishi 平台 `onebot`。它把 driver、IPC、登录状态、
事件桥、动作桥、控制台面板与数据库预热装配成 koishi 能驱动的 Bot。

涉及代码：`src/bot/`（Bot 外壳、生命周期、派发、编码器、启动与组件装配）、`src/bot/database.ts`、`src/index.ts`。

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
7. `createDispatcher(...)` 读取原始 `autoAssign` / `autoAuthorize`（不提前求值动态配置），
   并装配数据库预热和会话派发。
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
| `onLog` | 按宿主帧级别记录安全摘要 |

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
| `getFriendList()` | `internal.getFriendList()` → `Universal.Friend` 列表，昵称为 `user.name`，备注优先用于 `nick`。跳过缺失 QQ 号的条目，非数组返回空列表。 |
| `getGuildList()` | `internal.getGroupList()` → `Universal.Guild` 列表 |
| `getGuild(guildId)` | 从群列表查找，未命中抛错 |
| `getChannel(channelId)` | `private:` → DIRECT 频道；否则按群号查 `getGuild` → TEXT 频道 |

形状转换集中在 `transform.ts`（纯函数）：`toFriendList` / `toGuildList` /
`toDirectChannel` / `toTextChannel` / `toUserFields`。

`onOb11(listener)` 订阅 OB11 原始载荷并返回退订函数，独立于 [Koishi 事件转换](events.md#标准通知与请求)。

## dispatch 链路

kernel / OB11 事件 → 事件桥产出 `NapukettoSessionFields` → `SessionDispatcher.dispatch(fields)`：

1. `identityMismatch` 为真或 IPC 客户端未就绪 → 返回 `false`，不进入 Koishi。
2. 普通消息按需调用 `preheat(fields)` 预热 channel / user（见下节），失败不阻断。
3. `this.session({ type, subtype?, selfId, platform, timestamp, member? })`。
4. `applySessionFields(session, fields)`（见 [事件桥](events.md#session-写入规则)）。
5. 输出 info 级会话元数据和元素数量。消息正文、URL 与元素属性留在 session 中。
6. `this.dispatch(session)` 后返回 `true`。`false` 让事件桥释放消息去重登记，允许软重登
   后的重放继续派发；预热期间客户端被替换同样返回 `false`。

## 数据库预热

`NapukettoDatabase` 在 dispatch 前原子预热 channel 与 user，规避 koishi `getChannel` / `getUser`
的 check-then-act 并发竞态：多条消息同 tick 派发时，多个 SELECT 先于首个 INSERT 完成，随后
并发 INSERT 撞唯一键（`channel.id, platform` 或 `binding.pid, platform`）。

同一根上下文的多个 Bot（同一插件模块实例内）共享一份预热协调状态（per-key 串行队列 +
失败报告器），按 `(platform, channel id)` / `(platform, user id)` 协调创建路径。多个 Koishi
实例之间没有共享内存，只依赖数据库唯一键与事务。

**channel**：

1. `get("channel", { id, platform }, ["id"])` 命中直接返回（绝大多数路径零写入）。
2. 未命中 `create("channel", row)` 单条原子插入；撞 `(id, platform)` 主键时回读。命中说明另一
   路径已创建，按成功处理。
3. 全程不使用 upsert：已有行的 `assignee` / `createdAt` 不会被并发预热覆盖。

**user**：

1. `get("binding", { platform, pid }, ["aid"])` 命中直接返回。
2. 未命中在 `db.transact` 内复查 binding，再 `create("user")` + `create("binding")`。binding
   主键冲突会让输家事务回滚；输家回读赢家 binding，命中即按成功处理。
3. 绝不用 upsert 改写 binding.aid。数据库无事务能力时退化为 create user + create binding，
   并在 binding 失败时补偿删除未被引用的 user，避免重试累积孤儿行。

**策略与降级**：

| 条件 | 行为 |
| :--- | :--- |
| `autoAssign === false` | 跳过 channel 预热（保持 koishi 不落库语义） |
| `selfId` 为空 | 跳过 channel 预热（koishi 走 detached，不落库） |
| `autoAssign` 为 Eval 表达式 | 跳过 channel 预热，由 koishi 在 dispatch 时求值 |
| `autoAssign` 为函数 | 只读取不可变 session 字段时按真实值预热；读取延迟字段、改写 session、抛错或返回非 boolean 时跳过 |
| `autoAuthorize === 0` | 跳过 user 预热（detached user） |
| `autoAuthorize` 为 Eval 表达式 | 跳过 user 预热，由 koishi 在 dispatch 时求值 |
| `autoAuthorize` 为函数 | 只读取不可变 session 字段时按真实值预热；读取延迟字段、改写 session、抛错或返回非 natural number 时跳过 |
| `ctx.database` 不可用或写入失败 | 告警后跳过，由 koishi 兜底；**绝不阻塞 dispatch** |
| 同一记录键的并发预热 | 同根上下文共享串行队列（key = `channel:<platform>:<id>` / `user:<platform>:<userId>`），不同 key 并行 |

`policy.ts` 只把构造期已定字段（`selfId` / `platform` / `userId` / `channelId` / `guildId` /
`isDirect` 等）暴露给 Computed 函数。函数读取 `user` / `channel` / `guild` / `argv` / `event` 等
延迟或可被 dispatch 改写的数据、调用 session 方法或改写 session 时，代理会标记 unsafe 并让该次
预热 deferred；即使函数自己 catch 了异常也不会采用它返回的兜底值。Eval 表达式与 async 函数一律
deferred。deferred 后由 koishi 在 dispatch 时按真实 session 求值，动态返回 `false` / `0` 时自然走
detached 分支。

**并发保证范围**：

| 场景 | 机制 | 保证 |
| :--- | :--- | :--- |
| 同一进程、同根上下文多 Bot | 共享 per-key 串行队列 | 同一记录键同时只有一个创建者；后到者读到已存在记录 |
| 同一进程、不同根上下文 | 仅数据库约束 | 依赖主键冲突回读 / 事务回滚，不覆盖已有行 |
| 多个 Koishi 实例（独立进程，同库） | 主键唯一 + 原子 create / 事务回滚 | 不重复 binding、不覆盖 `assignee` / `createdAt`；输家事务回滚或补偿清理，不遗留孤儿 user；可能多一次失败尝试 |
| 不同数据库 | 无协调 | 各自独立 |

**失败告警**：按「操作 + 平台 + 错误指纹」归并。首次失败保留完整错误对象（含堆栈），后续同因
失败只计数；累计 50 次或冷却 60 秒后输出一次摘要。不同平台、不同错误类型/错误码各自成组；
无错误码时按错误消息区分，不会因为某个组先告警而吞掉后续证据。

`NapukettoDatabase` 构造时收 `ctx.root`：root 的 internal 一定含 database，且 `checkInject` 对 root
放行，避免插件作用域访问服务时反复 emit warning。

## MessageEncoder

`NapukettoMessageEncoder extends MessageEncoder`：

- `prepare()`：channel 未带 `type` 时按 channelId 补（`private:` → DIRECT=1，否则 TEXT=0）；
  非私聊时 `guildId ??= channelId`。
- `visit(element)`：把 h 实例收集到数组（text 内容在 `attrs.content`）。
- `flush()` 调用 `bot.internal.sendMessage(channelId, children, guildId)`。每个有效消息 ID 各生成一次 `send` 事件并写入 `results`，空发送结果不生成事件。

元素到 canonical 的转换复用 `src/bridge/actions/elements.ts` 的 `toCanonicalElements()`，不重复实现。

## 纯逻辑与单测边界

这些文件运行时 import koishi，**不在单测中加载**：

`src/index.ts`、`src/bot/bot.ts`、`src/bot/message.ts`、
`src/bot/assembly.ts`、`src/config.ts`、
`src/console/provider.ts`。

`src/bot/driver-events.ts` 是例外：全部为 type-only import，运行时零 koishi 依赖，可直接单测。
`src/bot/launch.ts` 不 import koishi，但 `buildLaunch` 会真实 spawn，单测只覆盖纯函数
`resolveLaunchOptions`（注入假 QQ 解析）。

可单测的纯逻辑单独成文件并通过依赖注入解耦：

| 文件 | 测试方式 |
| :--- | :--- |
| `dispatcher.ts` | 宽松 session 结构，直接断言字段 / 预热策略 |
| `policy.ts` | 注入 session 桩，验证静态值、纯函数求值与 unsafe/deferred 分支 |
| `database.ts` | 有状态假数据库验证原子 create、事务回滚、冲突回读与共享队列 |
| `failure-reporter.ts` | 注入时钟与 warn，验证去重、限频与证据保留 |
| `lifecycle.ts` | 验证账号判定与拒绝上线，注入 driver 和 Bot 验证启停重叠及旧轮次回调 |
| `transform.ts` | 断言 Universal 形状转换，无 Koishi 运行时 |
| `src/console/panel.ts` | 纯决策表 + mock executor |
| `bot/launch.ts` 的 `resolveLaunchOptions` | 注入假 `resolveQq`，不 spawn |
| `src/bridge/` 的动作与事件映射 | mock request / mock h |

配置项与默认值见 [配置](../guides/configuration.md)。
