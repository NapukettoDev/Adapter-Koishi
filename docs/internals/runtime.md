# 子进程运行时：launch、driver、IPC

本篇描述“一个 bot 如何获得并维持一个可用的子进程连接”。消息语义见
[事件桥](events.md) 与 [动作桥](actions.md)。

涉及代码：

| 层 | 文件 | 职责 |
| :--- | :--- | :--- |
| launch | `src/bot/launch.ts` | 组装 `launchSelfHost` 选项、解析包入口、每次 spawn 调用一次 |
| driver | `src/driver/driver.ts` | 子进程生命周期、状态机、重启、停止、状态重查 |
| heartbeat | `src/driver/heartbeat.ts` | 轮询最近消息时间，判定失联 |
| backoff | `src/driver/backoff.ts` | 指数退避纯函数 |
| ipc | `src/ipc/` | JSON 行编解码、传输、请求匹配、事件订阅 |

## launch：组装子进程

`buildLaunch(config, host)` 返回 `DriverLauncher`，driver 每次 spawn 前调用一次。它先
`resolveLaunchOptions()`，再把结果映射成 `launchSelfHost()` 参数：

```ts
{
  qq, kernelEntry, selfHostEntry?, adapterEntry?, networkEntry?, qrOnly?,
  cfgDir, cwd, configPath, stubDir, quickUin, selfHost: true, ipc: true,
  stdio: ["pipe", "pipe", "pipe"], onStage,
}
```

| 字段 | 来源/规则 |
| :--- | :--- |
| `qq` | 显式 `qqPath` → `resolveQqInstall(path)`；Linux → `ensureQqFiles({ dataRoot, onStage })`（必要时下载到数据根，避免 wine 读 `/mnt/c` 失败）；其他平台 → `resolveQqInstall()` |
| `kernelEntry` | `resolveEntry("@napuketto/kernel", config.kernelEntry)` |
| `selfHostEntry` | 配置覆盖；缺省由 loader 用包内 `dist/host/self-host.cjs` |
| `cfgDir` | `<dataRoot>/<selfId>`（按账号隔离） |
| `cwd` | `dataRoot`（原生层在 session 就绪前可能按 cwd 落盘，不能污染 Koishi 工作目录） |
| `configPath` | `resolveConfigPath({ dataRoot })`（项目根配置或数据根兜底） |
| `stubDir` | 配置覆盖；缺省 `defaultStubDir()`（loader 包内 stub QQNT.dll） |
| `quickUin` | 配置 `selfId`（快速登录目标账号） |
| `qrOnly` | 本次 spawn 前 `forceQr.current === true` 时置位，并立即清零 |
| `adapterEntry` / `networkEntry` | `ob11Actions !== false` 时解析 `@napuketto/adapter` 与 `@napuketto/network`；任一失败只记录降级，子进程不挂载 OB11 面 |
| `onStage` | 传给 loader 与 launchSelfHost，接 bot logger.info（下载/解包/win-node/启动阶段可见） |

`resolveEntry(pkg, override)` 用 `createRequire(import.meta.url).resolve`：CJS 产物下
`import.meta.resolve` 不可用。显式 override 为相对路径时按 `process.cwd()` 展开。解析失败会抛出
带“确认依赖已安装 / 手动指定入口”的提示。

`launchSelfHost` 自 Linux/wine 分支起是 **async**；`buildLaunch` 必须 `await`，否则 child 为
`undefined`，driver 在 `child.once()` 处崩溃。

## driver：状态与事件

`NapukettoDriver` 只依赖注入的 `DriverLauncher` 与传输工厂，不 import loader。

```ts
interface DriverOptions {
  launch: () => Promise<{ child: ChildProcessLike; cleanup?: () => void }>;
  createTransport?: (child) => IpcLineTransport;
  events: DriverEvents;
  restart?: { maxRetries?; backoffMs?; backoffFactor? };
  heartbeatTimeoutMs?: number;   // 默认 45_000
  onJunkLine?: (line: string) => void;
}
```

`DriverEvents`（均已接线到 `src/bot/utils/driver-events.ts`）：

| 回调 | 触发 |
| :--- | :--- |
| `onStatus` | 收到 `status`，payload 含 boot phase |
| `onLogin` | 收到 `login`（state / selfInfo / message） |
| `onQr` | 收到 `qr` |
| `onEvent` | 收到 kernel / OB11 `event` |
| `onLog` | 收到子进程结构化 `log` |
| `onReady` | 每轮就绪（重播的 ready 被幂等守卫忽略）；上层在此更新 client 引用并 `online()` |
| `onExit` | 子进程退出（crash / stale / spawn-error） |
| `onError` | spawn 失败、boot failed、重试达上限 |

spawn 流程：

1. `setState(spawning | restarting)`，调用 `launch()`；抛错走 `handleSpawnError`。
2. 挂 `child.once("error")`（防止 ENOENT 无监听导致宿主 `uncaughtException`）与
   `child.once("exit")`。
3. 新建 transport + `NapukettoIpcClient`，订阅 status/login/qr/event/log。
4. 记录 `spawnAt`，进入 `booting`，启动心跳监控。

每次 spawn 都是新的 client 实例；上层通过 `driver.currentClient` 在 `onReady` 时重新取引用。

## 心跳与状态重同步

**心跳**（`HeartbeatMonitor`）：

- 每 1s 读一次 `client.seenAt`（最近收到任何子进程消息的时间）。
- 基准时间 = `seenAt > 0 ? seenAt : spawnAt`；超过 `heartbeatTimeoutMs`（默认 45s）判定失联。
- `stopping` / `failed` / `restarting` 状态下不判定。
- 失联处理：`kill()` + 以 `reason: "stale"` 走退出流程（按策略重启）。
- 子进程侧每 15s 发 `ping`，client 自动回 `pong`；因此正常空闲时 `seenAt` 持续前进。

**状态重同步**（防“能收不能发”）：

- 若收到 `event` 但状态机不在 `ready`，立即 `resyncStatus()`。
- `booting` 期间每 20s 主动查询一次；离开 booting 停表。
- `resyncStatus()` 发 `control status`，子进程重播最近一条 status；5s 节流防止事件风暴刷屏。
- 重播的 ready 被 ready 幂等守卫吸收，不会重复触发 `onReady`。

## 重启与停止

- 子进程退出且非主动停止：`restartCount >= maxRetries` → `failed` + `onError`；否则
  `restarting`，等待 `backoffDelay(attempt)` 后再次 spawn。
- `restartCount` 在每次进入 ready 时清零。
- `stop()`：置 `stopping`、清重试计时器、停心跳 → 存活 client 发 `control stop` → 最多等 5s →
  `kill()` → `finishStop()`（清计时器、`client.close()`、状态 `stopped`）。
- `start()` 只在 `idle` 生效；重复调用被忽略。

## IPC 协议

协议版本 `IPC_VERSION = 1`。消息类型、payload schema、`IPC_VERSION` 都由
`@napuketto/loader` 提供（插件侧 `src/ipc/index.ts` 直接 re-export），避免两端各写一份漂移。
编码为一行一条 JSON，`\n` 结尾。

```
{ "v": 1, "type": "action", "id": 12, "payload": { "action": "msg.sendMessage", "params": {} } }
```

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

**传输**（`src/ipc/transport.ts`）：

- `ChildProcessIpcTransport`：stdout 用 readline 逐行读取，stdin 写行。
- stdout/stderr 都先经过 `isNativeNoiseLine()` 过滤 wrapper 的原生噪音；stderr 其余内容以
  `[napuketto 子进程] ` 前缀转发到父进程 stderr（保留 wine/Node 原始报错）。
- 子进程 `close` 事件触发 transport 关闭；`stdin`/`stdout` 不是 pipe 时构造直接抛错。
- `BaseLineTransport` 统一订阅管理与 `close()` 幂等；`MemoryLinePair` 是测试用内存双端。

**客户端**（`src/ipc/client.ts`）：

- `request(action, params?, timeoutMs?)`：单调递增 id，`PendingRequests` 记录超时（默认 60s）。
- 成功 `result` resolve；失败 `result` reject 为 `IpcError("动作 <name> 失败: <message>", code)`
  （code 是协议边界的宽松 string，不伪造成 kernel 错误码）。
- 超时 → `IpcError("动作超时", "TIMEOUT")`；通道关闭 → `IpcError("IPC 通道已关闭", "CLOSED")`。
- 迟到响应直接忽略（pending 已清理）。
- `on(type, handler)` 泛型收窄并返回退订函数；`result` 只用于 pending 匹配，不派发给事件订阅者。
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

- `src/ipc/test-utils.ts`：`MemoryLinePair`（一端 write → 对端收到）、`captureAction`。
- `src/driver/test-utils.ts`：`FakeChild`（可触发 exit/error）+ `createHarness`（记录 spawn 与 pair）。
- driver/IPC 单测不启动真实子进程，也不需要 QQ 环境。
