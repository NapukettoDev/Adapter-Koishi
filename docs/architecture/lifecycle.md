# 生命周期

Bot 启停和轮次管理由 `src/bot/lifecycle.ts` 的 `BotLifecycleController` 负责。

本篇描述一个 `NapukettoBot` 从实例化到上/下线的完整时序：driver 状态机、登录状态机、
就绪与账号校验、崩溃恢复，以及控制台发起的重新登录。进程与协议细节见
[子进程运行时](../internals/runtime.md)。

## 启动时序

```
Koishi 加载插件
  └─ 默认导出 NapukettoBot（平台 "onebot"）
       └─ 按 bots 配置实例化：constructor(ctx, config)
            ├─ selfId / logger / user 初始化
            ├─ 登录状态机、控制台面板、数据库预热器、事件桥、动作桥装配
            └─ Koishi ready → Bot.start()
                 ├─ status = CONNECT
                 ├─ 复位上一轮登录快照、账号闸门与 clientRef
                 ├─ 等待进行中的 stop 与旧 driver 确认退出（如有）
                 └─ 创建本轮 driver → NapukettoDriver.start()
                      └─ launch() → spawn self-host.cjs
                           ├─ status: booting → dlopening → logging → sessioning
                           ├─ login: 快速登录 / QR 登录
                           ├─ status: ready（session READY + kernel services）
                           └─ driver ready → BotLifecycleController.handleReady()
                                ├─ 关闭动作/派发闸门，记录 driver 轮次
                                ├─ 登录快照已有身份 → 校验
                                ├─ 缺失身份 → login.getSelf 补拉（限定当前驱动与登录轮次）
                                ├─ 校验通过 → login.onReady + clientRef + Bot.online()
                                └─ getLogin()（异步结果绑定登录轮次）
```

`Bot.start()` 用 `this.isActive` 防重复。每次 `start()` 都是独立轮次：即使上一轮是正常 `stop()`，
也创建新的 driver，而不是复用停在 `stopped` 的旧实例。真正创建 driver 时递增轮次号，旧 driver 的迟到
回调（`onExit` / `onError` / `onReady` / 登录消息等）因轮次不匹配被丢弃，不会把新一轮置为
offline 或写入旧账号。stop 递增独立的停止序号，让尚未完成的 start 放弃创建 driver，同时保留
本轮 driver 在停止期间的 `onExit` / `onError` 语义。子进程启动是 fire-and-forget，失败通过
driver 事件回到 `offline()`。

登录状态另有一个自增 `generation`（`NapukettoLoginState`）：软重登会复用同一 driver，
仅靠 driver 轮次无法区分前后两次登录。快照中的身份与异步 `getLogin` / `getSelf` 结果都
绑定该代次；软重登开始、宿主重启、stop 或 exit 都会自增，旧代次的结果直接丢弃。

## driver 状态机

```
idle ──start()──▶ spawning ──launch 成功──▶ booting ──status.ready──▶ ready
                     │                        │
                     │ launch/spawn 失败       └─ 心跳超时 / 子进程退出
                     ▼                        ▼
                  failed ◀──重试达上限── restarting ──退避──▶ booting
stop() ──▶ stopping ──退出或 5s 超时──▶ stopped ──start()──▶ spawning（新一轮）
```

| 状态 | 含义 |
| :--- | :--- |
| `idle` | 未启动；`start()` 直接开始本轮 |
| `spawning` | 首次启动，正在执行 launch |
| `booting` | 子进程已 spawn，等待 `status.ready`（期间收到任意 boot 阶段 status 仍保持） |
| `ready` | session 与 kernel services 就绪 |
| `restarting` | 崩溃/失联后等待退避计时 |
| `stopping` / `stopped` | 主动停止中 / 已确认退出；`stopped` 可再次 `start()` 开始新一轮 |
| `failed` | 启动失败或重启次数达到上限（含停止超时未确认退出） |

要点：

- **stopped 可重启**：确认退出后 client、host、账号目录所有权与计时器都已释放；
  `start()` 复位重启计数并重新 spawn。`failed`、`stopping` 等状态不会被 `start()` 抢占。
- **ready 幂等**：`control status` 会重播最近一条 status；已经 ready 时不会重复触发
  `onReady()`（避免重复 `online()` / `getLogin()`）。
- **重启计数**：每次进入 ready 清零；达到 `restart.maxRetries`（默认 3）后置 `failed` 并
  `onError`。
- **主动停止不再重启**：`stopping` 标志贯穿退出处理。

## 登录状态机

状态集合与 kernel `LoginState` 对齐：

```
idle ──onLogin(waiting_scan)──▶ waiting_scan ──onLogin(scanned)──▶ scanned
  │                                  │                              │
  │                                  └──────── onLogin(logged_in) ──┤
  └──────────── onLogin(logged_in)（快速登录直通）──────────────────┴──▶ logged_in

任意状态 ──onLogin(failed)──▶ failed（记录 lastError）
任意状态 ──onExit()──────────▶ idle（清空 qr/self/lastError）
```

- **快速登录**：子进程直接上报 `logged_in`，状态机不经过 `waiting_scan`。
- **QR 缓冲**：`qr` 消息可能先于 `login(waiting_scan)` 到达；`onQr()` 立即记录并通知二维码变化，
  QR 已保存在快照中，状态迁移到 `waiting_scan` 时随状态一起可见。`waiting_scan` 期间收到新码会再次通知。
- **onReady 兜底**：子进程 ready 代表登录已完成；若状态机尚未到 `logged_in`，补一次迁移。
- `LoginSnapshot` 是控制台面板与控制台推送的唯一数据源：`state` / `qr` / `self` / `lastError`。

## 就绪处理与账号一致性

`handleReady()` 的顺序不可交换：

1. 记录当前 driver 与登录 `generation`，关闭动作/派发闸门（`sessionReady` 仅在 ready 后成立）。
2. 快照已有 `selfInfo` 时直接校验；缺失或空串时调用当前锁定 loader/kernel 公开的
   `login.getSelf` 补拉。查询响应必须仍属于同一 driver、同一 client 与同一登录代次。
3. **账号一致性校验**：实际 `uin` 必须非空且等于配置 `selfId`。缺失、空串、空白、查询失败
   都不再放行。
4. 只有第 3 步通过后才写 `clientRef`、`login.onReady()`、`online()`；随后
   `getLogin()` 拉取/同步自身信息（失败只 warn）。
5. 查询失败/空身份进入可恢复的 `failed` 登录快照：动作与派发保持关闭，但宿主继续运行；
   后续 `logged_in` 携带正确身份，或用户重新登录/重启，都能恢复。

不一致时的处置见 `src/bot/lifecycle.ts`：

- 置 `identityMismatch` 闸门；后续所有 kernel 消息**拒绝派发**，动作桥无 client。
- 清空登录快照中的错误账号（`rejectIdentity`），不把上一轮身份留给后续事件。
- 输出可操作错误（把 `selfId` 改成实际 uin，或换回配置账号重新扫码）。
- 停止 driver 并 `offline()`。

再次 `start()` 会先复位 `identityMismatch`、登录快照、`sessionReady` 与 clientRef，因此换回正确
账号后可以恢复上线；若旧宿主尚未确认退出，`start()` 会等待其停止完成，不会在账号目录仍被
占用时启动第二个宿主。

为什么必须拒绝上线，而不是"将就用实际 uin"：数据目录按配置 `selfId` 命名，另一个账号的数据会
写进同一目录；同时 koishi 的 `channel.assignee` / `binding` 会按实际 uin 落库。事后换回正确账号时，
koishi 的受理人闸门（`channel.assignee !== session.selfId` 时静默 return）会把这些频道的群消息
全部丢弃，且 assignee 不会自动修复。

收到携带 `selfInfo` 的 `logged_in` 时，driver 事件层立即调用 `handleLoggedIn()` 校验账号并同步昵称。
这覆盖了 `ready` 前拿到登录结果和 `ready` 后补到账号信息两种顺序。若登录事件先到，进行中的
`login.getSelf` 结果会被代次自增作废，避免旧响应覆盖新身份。

## 异常、重启与状态重同步

| 场景 | 处理 |
| :--- | :--- |
| 子进程非零退出 / 崩溃 | `onExit` → 未主动停止则 `offline()`；按退避重启 |
| 心跳超时（45s 无任何消息） | kill 子进程，按失联处理并重启（含 dlopen/登录卡死，spawn 时间是兜底基准） |
| spawn 失败（ENOENT 等） | 监听 `error`，`spawnFailed` 防 exit 双处理，置 `failed` 并 `offline(error)` |
| ready/boot status 行被并发输出撕裂丢失 | 收到 event 时若状态未 ready、或 booting 阶段每 20s，发 `control status` 请求重播（5s 节流） |
| 子进程 stdout 出现无法解析的行 | `onJunkLine` 回调（debug 日志），不静默丢弃；wrapper 原生噪音行由 loader 过滤 |

退避公式：`backoffMs × backoffFactor^(attempt-1)`，默认 1s / 2s / 4s，`maxRetries = 3`。
`maxRetries = 0` 表示不重启。

## 停止

`Bot.stop()`：

1. 递增停止序号、清 `clientRef`、立即解除 `driver` 引用：进行中的 `start()` 会放弃创建。
   清 `clientRef` 时同时调用事件桥的 `cancelPending()`，中止在途语音解码与消息适配并清空
   待派发队列；已派发的 WAV 仍由 TTL 清理，供 Koishi 继续消费。
2. `driver.stop()`：置 `stopping`、清重试计时器、停心跳。
3. client 存活时发 `control stop`；等待子进程退出，最多 5s，超时 `kill()`。
4. `resolveStop()`：清计时器、关 client（pending 全部 reject）、状态置 `stopped`。
5. `super.stop()`：把 Bot 置为 offline。

重复 `stop()` 会等待同一批停止任务；停止超时仍按 `failed` + `EXIT_TIMEOUT` 处理，不确认退出
前不会释放账号目录所有权。超时后宿主仍存活时再次 `stop()` 会重新执行有界终止，而不是立即
返回。与 `start()` 重叠时，新一轮会等待停止任务和旧 driver 结束，再创建自己的 driver。

## 重新登录与强制扫码

`src/console/panel.ts` 根据面板操作和登录状态选择通道并执行。

| 当前登录状态 | 操作 | 通道 |
| :--- | :--- | :--- |
| `idle` / `waiting_scan` / `scanned` | 重新登录 | `control login { uin }`，原地重登，不重启子进程 |
| `logged_in` / `failed` | 重新登录 | 有连接时退出旧宿主，再启动新宿主尝试快速登录，失败时回退扫码 |
| `idle` / `waiting_scan` / `scanned` | 扫码登录 | `control login { uin, qr: true }`，原地出码 / 切扫码流 |
| `logged_in` / `failed` | 扫码登录 | 置一次性 `qrOnly` 标记并请求重启宿主；新宿主直接出码 |
| IPC 不可用 | 重新登录 / 刷新二维码 | 记录告警 |
| IPC 不可用 | 扫码登录 | 记录告警并留下一次性 `qrOnly` 标记，由下次 spawn 消费 |
| 任意（`waiting_scan` 时有效） | 刷新二维码 | IPC 动作 `login.refreshQr`，由 kernel 重新出码，不重启子进程 |

`qrOnly` 是一次性标记：launch 解析时消费并清零，因此崩溃退避重启不会重复强制扫码。
`control login` 的 `uin` 取配置 `selfId`；若登录成了其他账号，由账号一致性校验拒绝上线。
请求重启宿主后，Bot 立即进入连接中，清理旧登录快照并解除业务 IPC 绑定。确认旧宿主退出后才启动
新宿主，收到新一轮 `ready` 后恢复在线。这样扫码登录使用新宿主的原生登录会话。

软重登（已就绪宿主收到 `control login`，loader 先报 `status.sessioning`）复用同一 driver：
`onRelogin` 立即清空快照身份、`clientRef` 与派发闸门，并取消旧会话的在途入站适配/解码与待派发
队列，Bot 回到连接中；装配期间收到的事件不会派发，动作请求按“未就绪”失败。新会话 `ready`
触发 `onReassembled`，重新走身份校验后才恢复 `online()` 与动作桥。
