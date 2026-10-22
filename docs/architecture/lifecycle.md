# 生命周期

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
                 └─ NapukettoDriver.start()
                      └─ launch() → spawn self-host.cjs
                           ├─ status: booting → dlopening → logging → sessioning
                           ├─ login: 快速登录 / QR 登录
                           ├─ status: ready（session READY + kernel services）
                           └─ driver ready → Bot.handleReady()
                                ├─ clientRef = 新 client
                                ├─ login.onReady()
                                ├─ 账号一致性校验
                                ├─ Bot.online()
                                └─ getLogin()（同步昵称/头像等 user 字段）
```

`Bot.start()` 用 `this.isActive` 防重复；`setupDriver()` 只在第一次创建 driver。子进程启动是
fire-and-forget，失败通过 driver 事件回到 `offline()`。

## driver 状态机

```
idle ──start()──▶ spawning ──launch 成功──▶ booting ──status.ready──▶ ready
                     │                        │
                     │ launch/spawn 失败       └─ 心跳超时 / 子进程退出
                     ▼                        ▼
                  failed ◀──重试达上限── restarting ──退避──▶ booting
stop() ──▶ stopping ──退出或 5s 超时──▶ stopped
```

| 状态 | 含义 |
| :--- | :--- |
| `idle` | 未启动；`start()` 只在此状态生效 |
| `spawning` | 首次启动，正在执行 launch |
| `booting` | 子进程已 spawn，等待 `status.ready`（期间收到任意 boot 阶段 status 仍保持） |
| `ready` | session 与 kernel services 就绪 |
| `restarting` | 崩溃/失联后等待退避计时 |
| `stopping` / `stopped` | 主动停止中 / 已停止 |
| `failed` | 启动失败或重启次数达到上限 |

要点：

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

1. 取 driver 当前 client 写入 `clientRef`（重启后 client 是**新实例**，动作桥通过引用间接更新）。
2. `login.onReady()`。
3. **账号一致性校验**：实际登录 `uin` 必须等于配置 `selfId`。实际 uin 缺失或为空串时视为尚未拿到
   `selfInfo`，先放行；后续 `logged_in` 携带 `selfInfo` 时会再次校验。
4. `online()`。
5. `getLogin()` 拉取/同步自身信息（失败只 warn）。

账号不一致时的处置见 `src/bot/utils/identity.ts`：

- 置 `identityMismatch` 闸门；后续所有 kernel 消息**拒绝派发**。
- 输出可操作错误（把 `selfId` 改成实际 uin，或换回配置账号重新扫码）。
- 停止 driver 并 `offline()`。

为什么必须拒绝上线，而不是"将就用实际 uin"：数据目录按配置 `selfId` 命名，另一个账号的数据会
写进同一目录；同时 koishi 的 `channel.assignee` / `binding` 会按实际 uin 落库。事后换回正确账号时，
koishi 的受理人闸门（`channel.assignee !== session.selfId` 时静默 return）会把这些频道的群消息
全部丢弃，且 assignee 不会自动修复。

**软重登补位校验**：ready 态的 `control login` 会重跑子进程装配链，但 driver 的 ready 幂等守卫
不会再次触发 `onReady`。因此 driver 事件层在收到携带 `selfInfo` 的 `logged_in` 时调用
`handleLoggedIn()`，再执行一次同样的校验；同账号通过并刷新昵称，换账号则拒绝上线。
初次引导也会在 ready 之前经过这里一次（同账号幂等）。

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

1. `driver.stop()`：置 `stopping`、清重试计时器、停心跳。
2. client 存活时发 `control stop`；等待子进程退出，最多 5s，超时 `kill()`。
3. `finishStop()`：清计时器、关 client（pending 全部 reject）、状态置 `stopped`。
4. `super.stop()`：把 Bot 置为 offline。

## 重新登录与强制扫码

控制台面板的"重新登录 / 扫码登录 / 刷新二维码"最终由
`src/bot/login-actions.ts` 的纯函数决策，`src/bot/login-panel.ts` 执行：

| 当前登录状态 | 操作 | 通道 |
| :--- | :--- | :--- |
| `idle` / `waiting_scan` / `scanned` | 重新登录 | `control login { uin }`，原地重登，不重启子进程 |
| `logged_in` | 重新登录 | `control login { uin }`，**软重登**：清理旧装配面后用新登录结果重跑装配链 |
| `failed` 或 IPC client 不可用 | 重新登录 | 回落 `control restart`（整进程重启，可靠路径） |
| `idle` / `waiting_scan` / `scanned` / `logged_in` | 扫码登录 | `control login { uin, qr: true }`，原地出码 / 切扫码流 |
| `failed` | 扫码登录 | 置一次性 `qrOnly` 标记 + `control restart`；下次 spawn 读 `NAPUTO_QR_ONLY=1` 跳过快速登录 |
| 任意（`waiting_scan` 时有效） | 刷新二维码 | IPC 动作 `login.refreshQr`，由 kernel 重新出码，不重启子进程 |

其余状态下若 IPC client 实际不可用，控制指令发送失败会回落到普通 `control restart`；这条回落路径
不置 `qrOnly` 标记，不保证重启后直接出码。

`qrOnly` 是一次性标记：launch 解析时消费并清零，因此崩溃退避重启不会重复强制扫码。
`control login` 的 `uin` 取配置 `selfId`；若登录成了其他账号，由账号一致性校验拒绝上线。
