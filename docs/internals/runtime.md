# 子进程运行时：launch、driver、IPC

本篇描述“一个 bot 如何获得并维持一个可用的子进程连接”。消息语义见
[事件桥](events.md) 与 [动作桥](actions.md)。

涉及代码：

| 层 | 文件 | 职责 |
| :--- | :--- | :--- |
| launch | `src/bot/launch.ts` | 组装 `launchSelfHost` 选项、解析包入口、每次 spawn 调用一次 |
| driver | `src/runtime/driver/driver.ts` | 子进程生命周期与状态转换 |
| heartbeat | `src/runtime/driver/supervision.ts` | 轮询最近消息时间，判定失联 |
| account lock | `src/runtime/driver/driver.ts` | 按账号目录管理宿主所有权 |
| restart | `src/runtime/driver/supervision.ts` | 重启计数、指数退避和取消 |
| resync | `src/runtime/driver/boot-resync.ts` | 引导期事件暂存、回放与状态重查 |
| termination | `src/runtime/driver/terminator.ts` | 进程监听、分级终止和退出错误 |
| ipc | `src/runtime/ipc/` | JSON 行编解码、传输、请求匹配、事件订阅 |

## launch：组装子进程

`buildLaunch(config, host)` 返回 `DriverLauncher`，driver 每次 spawn 前调用一次。它先
`resolveLaunchOptions()`，再把结果映射成 `launchSelfHost()` 参数：

```ts
{
  qq, kernelEntry, selfHostEntry?, adapterEntry?, networkEntry?, qrOnly?,
  cfgDir, cwd, configPath, extraEnv, stubDir?, linuxStubPath?, winNodePath?,
  nativeMediaPatch?, quickUin, selfHost: true, ipc: true,
  stdio: ["pipe", "pipe", "pipe"], diagnostics, log,
}
```

| 字段 | 来源/规则 |
| :--- | :--- |
| `qq` | 显式 `qqPath` 优先；Linux 缺省走 `resolveQqFiles`，探测 `/opt/QQ` 等本机安装，再查缓存或下载；Windows 缺省走 `resolveQqInstall()` |
| `kernelEntry` | `resolveEntry("@napuketto/kernel", config.kernelEntry)` |
| `selfHostEntry` | 配置覆盖；缺省由 loader 用包内 `dist/host/self-host.cjs` |
| `cfgDir` | `<dataRoot>/<selfId>`（按账号隔离） |
| `cwd` | `dataRoot`（原生层在 session 就绪前可能按 cwd 落盘，不能污染 Koishi 工作目录） |
| `configPath` | `resolveConfigPath({ dataRoot })`（项目根配置或数据根兜底） |
| `extraEnv` | `NAPUKETTO_DATA_ROOT` 与 `NAPUKETTO_DATA` 使用与 `cwd` 相同的数据根，分别供宿主引导和 OB11 缓存动作使用 |
| `stubDir` / `linuxStubPath` / `winNodePath` | 分别覆盖 Windows DLL 目录、Linux ELF stub 文件和 Windows 非 Node 宿主使用的 `node.exe`，省略时交给 loader 解析 |
| `nativeMediaPatch` | 省略时沿用 loader 默认与环境开关，显式 `true` 或 `false` 时覆盖 |
| `quickUin` | 配置 `selfId`（快速登录目标账号） |
| `qrOnly` | 本次 spawn 前 `forceQr.current === true` 时置位，并立即清零 |
| `adapterEntry` / `networkEntry` | `ob11Actions !== false` 时解析 `@napuketto/adapter` 与 `@napuketto/network`；任一失败只记录降级，子进程不挂载 OB11 面 |
| `log` / `diagnostics` | 按账号传递日志等级和显式诊断授权。宿主环境继承由 loader 白名单限制 |
| `onStage` | 适配器报告启动阶段的安全摘要 |

`resolveEntry(pkg, override)` 用 `createRequire(import.meta.url).resolve`：CJS 产物下
`import.meta.resolve` 不可用。显式 override 为相对路径时按 `process.cwd()` 展开。解析失败会抛出
带“确认依赖已安装 / 手动指定入口”的提示。

可选路径配置先经 `normalizeOptionalPath` 归一化：空串与纯空白视为省略；相对路径保留并按
`process.cwd()` 展开；路径存在时按 loader 契约校验类型（`stubDir` / `dataDir` 为目录，
`qqPath` / `linuxStubPath` / `winNodePath` / `selfHostEntry` 与入口覆盖为文件）。类型错误只点名
配置项，不回显完整路径。入口解析失败同样以配置项名报错；OB11 入口失败保持 fail-soft 降级。

`buildLaunch` 等待 `launchSelfHost()` 完成平台预检和宿主启动，再将子进程交给 driver。

## driver：状态与事件

`NapukettoDriver` 只依赖注入的 `DriverLauncher` 与传输工厂，不 import loader。
Bot 每次 `start()` 创建新的 driver 实例；driver 自身也允许在 `stopped`（已确认退出）后再次
`start()`，复位重启计数并开始新一轮。

```ts
interface DriverOptions {
  launch: () => Promise<{ child: ChildProcessLike; cleanup?: () => void }>;
  accountDir?: string;
  accountOwners?: AccountOwnerRegistry; // 可注入独立的账号锁注册表
  createTransport?: (child) => IpcLineTransport;
  events: DriverEvents;
  restart?: { maxRetries?; backoffMs?; backoffFactor? };
  heartbeatTimeoutMs?: number;   // 默认 45_000
  onJunkLine?: (line: string) => void;
}
```

`DriverEvents`（均已接线到 `src/bot/driver-events.ts`）：

| 回调 | 触发 |
| :--- | :--- |
| `onStatus` | 收到 `status`，payload 含 boot phase |
| `onLogin` | 收到 `login`（state / selfInfo / message） |
| `onQr` | 收到 `qr` |
| `onEvent` | 收到 kernel / OB11 `event` |
| `onLog` | 收到子进程结构化 `log` |
| `onReady` | 每轮就绪（重播的 ready 被幂等守卫忽略）；上层在此校验身份后才更新 client 引用并 `online()` |
| `onRelogin` | 已就绪宿主进入软重登 `sessioning`：上层清空旧身份、动作绑定与派发闸门 |
| `onReassembled` | 软重登后的 `ready`：上层重新校验身份后再恢复动作与事件 |
| `onExit` | 子进程确认退出或启动失败（crash / stale / stop / spawn-error） |
| `onError` | 启动失败、引导失败、发送信号失败、无法确认退出或重试达上限 |
| `onIpcWriteError` | 每轮首个 stdin 写入故障，记录原始错误类别 |
| `onIpcError` | 入站行超限、客户端消息订阅者异常等 IPC 诊断（warn 日志） |

已就绪宿主软重登时，`client-events` 检测 `status.sessioning`（与上次 phase 不同）并触发
`onRelogin` + `onEventSubscription`，再在随后的 `ready` 触发 `onReassembled`。这期间 driver
仍是 ready、client 仍连接，但上层必须关闭身份/动作/派发闸门，直到新会话完成身份校验。

spawn 流程：

1. `setState(spawning | restarting)`，调用 `launch()`；抛错走 `handleSpawnError`。
2. 挂 `child.on("error")` 与 `child.once("exit")`。无 PID 的启动失败和有 PID 的进程错误分别处理，
   后者仍须确认退出。
3. 新建 transport + `NapukettoIpcClient`，订阅 status/login/qr/event/log。
4. 记录 `spawnAt`，进入 `booting`，启动心跳监控。

每次 spawn 都是新的 client 实例；上层通过 `driver.currentClient` 在 `onReady` 时重新取引用。

## 心跳与状态重同步

**心跳**（`HeartbeatMonitor`）：

- 每 1s 读一次 `client.seenAt`（最近收到任何子进程消息的时间）。
- 基准时间 = `seenAt > 0 ? seenAt : spawnAt`；超过 `heartbeatTimeoutMs`（默认 45s）判定失联。
- 只在 `booting` / `ready` 状态判定。失联后断开业务 IPC 并发送 `SIGTERM`，确认退出后以
  `reason: "stale"` 进入重启退避。
- 子进程侧每 15s 发 `ping`，client 自动回 `pong`；因此正常空闲时 `seenAt` 持续前进。

**状态重同步**（防“能收不能发”）：

- `booting` 期间收到 `event` 时先暂存，再调用 `resyncStatus()`。每个子进程最多暂存最近 256 条事件。
- `onReady` 完成客户端绑定和账号校验后，驱动按 IPC 到达顺序回放暂存事件。子进程退出或驱动停止时丢弃暂存事件。
- 事件桥在 IPC 订阅时记录历史积压基准，ready 后回放仍使用该基准。已就绪子进程进入软重登的
  `sessioning` 阶段时刷新基准，重复状态和 ready 回放不会刷新。见 [事件桥](events.md#kernel-事件入口)。
- `booting` 期间每 20s 主动查询一次；离开 booting 停表。
- `resyncStatus()` 发 `control status`，子进程重播最近一条 status；5s 节流防止事件风暴刷屏。
- 重播的 ready 被 ready 幂等守卫吸收，不会重复触发 `onReady`。

## 重启与停止

- 控制台请求重启时，driver 发送 `control restart`，立即关闭旧 IPC，复用停止流程的分级终止期限。
  确认旧宿主退出后启动新宿主。手动重启独立于崩溃重试配额，停用 Bot 会取消尚未执行的重启。
- 子进程崩溃或失联退出：`restartCount >= maxRetries` → `failed` + `onError`；否则
  `restarting`，等待 `backoffDelay(attempt)` 后再次 spawn。重复调度会先取消旧计时器，只保留
  最新一次，避免同一 driver 同时 spawn 两个宿主。
- `restartCount` 在每次进入 ready 时清零。
- 主动停止清除重启计时器并停止心跳，先给可用 IPC 发送 `control stop`，等待 5s 后发送 `SIGTERM`。
  `SIGTERM` 发出后再等 5s，仍未退出则发 `SIGKILL`。异步启动期间收到停止请求时，拿到子进程后从
  `SIGTERM` 开始处理。已在终止的进程继续使用原有期限，停止请求取消后续重启。
- 每次发出信号后仍保留旧进程的所有权。强制终止后 5s 仍无法确认退出时报告 PID 和处理建议，进入
  `failed`，禁用自动重启。迟到的退出事件只回收旧实例。启动失败但尚未创建进程时可直接释放所有权。
- `failed` 且宿主仍存活时再次 `stop()` 会重新进入有界终止流程（SIGTERM → SIGKILL → 超时），
  而不是立即返回“已停止”；确认退出前账号目录始终保留占用。
- 同一 Koishi 进程内，插件重载时，新 driver 等待正在 `stopping` / `terminating` / 仍持有进程的
  `failed` 同账号宿主退出。等待受既有终止期限约束；期限内未确认退出时，该账号保持占用，
  直到旧进程发出退出事件，新 driver 不抢占账号目录。
- Bot 的 `stop()` 在发起停止时立即解除 driver 引用并递增停止序号；重复 `stop()` 串联等待停止任务，
  `start()` 与 `stop()` 重叠时先等待停止任务与旧 driver 结束，再创建新一轮 driver。停止期间本轮
  driver 的 `onExit` / `onError` 仍会处理；新 `start()` 递增轮次后，旧 driver 的迟到回调才失效。
- 上游退出码 `78` 停止重试，检查当前账号的加载配置和 `napuketto-boot.log` 后重新启用。loader 的
  `status.phase = failed` 中，`error.code = INVALID_PARAM` 表示配置校验失败。其余状态错误仍按实际
  退出和重试策略处理，包括 `NOT_LOGIN`、`UNKNOWN` 及数据目录暂时被占用时的 `INVALID_STATE`。
- `start()` 在 `idle` 生效；`stopped` 会复位重启计数后开始新一轮。`spawning` / `booting` /
  `ready` / `restarting` / `stopping` / `failed` 下的调用被忽略，避免与自动重启或未确认退出的
  旧宿主竞争。重复 `start()` 不会产生第二个宿主。
- Bot 层每次 `start()` 使用新的 driver；旧 driver 的迟到回调按轮次号丢弃（见
  [生命周期](../architecture/lifecycle.md)）。

## IPC 协议

协议版本 `IPC_VERSION = 1`。消息类型、payload schema、`IPC_VERSION` 都由
`@napuketto/loader` 提供（插件侧 `src/runtime/ipc/index.ts` 直接 re-export），避免两端各写一份漂移。
编码为一行一条 JSON，`\n` 结尾。

```
{ "v": 1, "type": "action", "id": 12, "payload": { "action": "msg.sendMessage", "params": {} } }
```

单条物理行另有插件侧的 UTF-8 字节上限（`DEFAULT_MAX_IPC_LINE_BYTES`，16 MiB，不含行尾 LF）。
它是父进程的防御性准入限制，不是协议字段，也不改变 `IPC_VERSION` 或 loader 的消息 schema；
跨版本两端仍按 JSON 行协议互通。出站超限在本地拒绝，入站超限整行丢弃后继续处理后续行。

| type | 方向 | payload | 说明 |
| :--- | :--- | :--- | :--- |
| `status` | 子 → 父 | `{ phase, message?, error? }` | phase：`booting` / `dlopening` / `logging` / `sessioning` / `ready` / `failed` |
| `login` | 子 → 父 | `{ state, selfInfo?, message? }` | state：`idle` / `waiting_scan` / `scanned` / `logged_in` / `failed` |
| `qr` | 子 → 父 | `{ pngBase64, qrcodeUrl }` | 控制台展示 + 链接兜底 |
| `event` | 子 → 父 | `{ service, name, args }` | kernel 事件通道形状；OB11 事件用 `service: "ob11"` |
| `result` | 子 → 父 | `{ ok: true, value? }` 或 `{ ok: false, error: { code, message } }` | 动作响应 |
| `log` | 子 → 父 | `{ level, message }` | pino level |
| `ping` / `pong` | 双向 | 无 payload | 心跳 |
| `action` | 父 → 子 | `{ action, params? }` | 动作请求，带 `id` |
| `control` | 父 → 子 | `stop` / `restart` / `{ command: "login", uin?, qr? }` / `status` | 控制指令 |

## 传输与客户端

**传输**（`src/runtime/ipc/transport.ts`、`framing.ts`）：

- `ChildProcessIpcTransport`：stdout 用增量字节分帧器（`LineFramer`）收行，stdin 写行。
- 分帧器按字节块累计行长度，超过 `maxLineBytes` 时立即丢弃该行已缓冲的前缀并跳过剩余内容直到
  换行，不会为超长行持续占用内存；随后到达的有效行继续分发。UTF-8 多字节字符跨 chunk 时只在
  完整行解码，不会被截断。超限通过 `onOversizeLine` 上报 `IPC_LINE_TOO_LARGE`，driver 接 logger。
- stdout 经过 `isNativeNoiseLine()` 过滤 wrapper 的原生噪音。不能解析的 IPC 行只报告丢弃事件。
  stderr 直接排空，每次连接至多报告一次输出提示。宿主的结构化 IPC 日志只转发级别摘要，避免自由文本携带凭据、消息或二维码。
- 子进程 `close` 事件触发 transport 关闭；`stdin`/`stdout` 不是 pipe 时构造直接抛错。
- stdin 写入前不可用、已提交的写入回调报错或 stdin 发出 `error` 时，传输立即幂等关闭。
  写入回调和 stdin 错误监听在传输提前关闭后仍处理已提交写入的错误。监听保留到 stdin 关闭，
  首个错误通过 bot logger 记录（例如 `EPIPE`，预检没有底层错误时用 `IPC_STDIN_UNAVAILABLE`）。
- IPC 关闭后宿主仍由 driver 持有。退出、心跳失联、停止和重启沿用 driver 的进程确认流程。
- `BaseLineTransport` 统一订阅管理与 `close()` 幂等；关闭时移除 stdout 分帧与 stderr 监听并
  丢弃未完成行。`MemoryLinePair` 是测试用内存双端。

**客户端**（`src/runtime/ipc/client.ts`）：

- `request(action, params?, timeoutMs?)` 按「登记 pending → 编码 → 写入」顺序执行。编码、
  单行上限、在途容量或同步写入失败都会以带错误码的 `IpcError` 拒绝该请求，并清理对应定时器、
  pending 条目与 id 簿记；不会留下悬挂请求，也不会让调用方收到同步抛错。
- 同时在途请求上限默认 256，超限请求立即以 `IPC_QUEUE_FULL` 失败；容量按完成/超时/关闭实时回收。
- 错误码：成功 `result` resolve；远端失败 reject 为
  `IpcError("动作 <name> 失败: <message>", code)`（code 是协议边界的宽松 string，不伪造成
  kernel 错误码）；超时 `TIMEOUT`；通道关闭 `CLOSED`；本地编码失败 `IPC_ENCODE_FAILED`；
  出站单行超限 `IPC_LINE_TOO_LARGE`；在途容量满 `IPC_QUEUE_FULL`；同步写入抛错 `IPC_SEND_FAILED`。
- 同步发送失败会关闭通道，其余在途请求以 `CLOSED` 结束；`sendControl` 返回是否已提交，
  失败不抛错。响应在写入过程中同步到达（例如测试内存传输）仍能按 id 正确匹配。
- stdin 故障关闭通道时，所有在途请求立即以 `CLOSED` 结束，`driver.currentClient` 返回 `null`。
- 迟到响应直接忽略（pending 已清理）。
- `on(type, handler)` 泛型收窄并返回退订函数；`result` 只用于 pending 匹配，不派发给事件订阅者。
  单个订阅者抛错会被隔离，经 `onHandlerError`（driver 接 `onIpcError` logger）诊断，其余订阅者
  和后续 IPC 行继续处理。
- 收到 `ping` 自动回 `pong` 并记录 `pingAt` / `pongAt`；任何合法消息更新 `seenAt`。
- 解码失败（非法 JSON / schema 不匹配 / v 不匹配 / 未知 type）不崩通道，交给 `onJunkLine`
  （driver 接 logger.debug）。

## 子进程侧契约

`launchSelfHost(..., ipc: true)` 注入 `NAPUTO_IPC=1`，loader 的 `self-host.cjs` 打开 IPC 分支：

- **引导期**：先启动 stdin 服务端与心跳，动作表只有 `login.refreshQr`（登录中即可刷新二维码）。
- **登录成功后**：并入 kernel 服务动作表：
  - `login.getSelf`、`login.refreshQr`
  - `msg.sendMessage` / `msg.recallMessage` / `msg.fetchMessages` / `msg.markRead`
  - `group.getGroupList`、`friend.getFriendList`
  - `diag.*`（原生调用诊断，非公共 API）
- **peer 解析**：`peerUid` 直通；只给 `peerUin` 时，群聊（`chatType=2`）直接用群号，私聊/临时会话经
  `uinToUid` 转 uid。群聊 `at.target`（uin）在发送前也批量转 uid 并尽量补 `display`。
- **事件转发**：kernel 事件通道 `onAny` → `event { service, name, args }`。事件名 `Service/method`
  被拆成 `service` 与 `name`。
- **OB11 面**：同时存在 `NAPUTO_ADAPTER_ENTRY` / `NAPUTO_NETWORK_ENTRY` 时，动态 import adapter
  的 `onebot11` / `core` 子路径与 network 入口，实例化 `NapukettoOneBot11Adapter` 后只调用
  `subscribeOnly()`（不装配任何网络传输），把动作名平铺进同一张动作表，事件经 `service: "ob11"` 透出。
  失败只降级，不阻断登录。
- **控制指令**：`stop` / `restart` 触发退出；`login` 触发子进程内重登/强制扫码；`status` 重播最近
  status。

## 测试设施

- `tests/helpers/ipc.ts`：`MemoryLinePair`（一端 write → 对端收到）、`captureAction`。
- `tests/helpers/driver.ts`：`FakeChild`（可触发 exit/error）+ `createHarness`（记录 spawn 与 pair）。
- driver/IPC 单测不启动真实子进程，也不需要 QQ 环境。
