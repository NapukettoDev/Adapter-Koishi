# koishi-plugin-adapter-napuketto 设计

> **定位**：NapukettoQQ 的 Koishi 适配器——把 NapukettoQQ（自研 QQ NT `wrapper.node` 协议层）
> 嵌入 Koishi，让 Koishi 直接驱动 QQ，无需 NapCat、无需独立进程、无 WebUI 依赖。
> **配套**：主仓库 `docs/architecture.md`（分层/ADR/红线）、`docs/STATUS.md`（现状 + 决策点）、
> `packages/kernel/docs/design.md`（核心装配）、`packages/loader/docs/design.md`（引导）。
> **新对话先读 `docs/HANDOVER.md`（施工交接，2026-08-08 深夜）** → 主仓库 STATUS → AGENTS.md
> → architecture.md → 本文件（已实现模块有 ✅ 标注）。

---

## 1. 边界

- **做**：koishi 插件壳（`apply` 生命周期、配置 schema、登录交互）、自建宿主子进程编排、
  事件翻译（kernel 事件 → koishi session）、动作调用（koishi → kernel API）。
- **不做**：不直接触碰 `wrapper.node` / session / 原生 listener（kernel 唯一原生交互层）；
  不做协议语义翻译（adapter 包负责）；不做媒体转码（media 包负责）。

依赖方向（遵循主仓库硬约束；2026-08-27 起 adapter/network 成为真实运行时依赖，§5.14）：

```
koishi-plugin-adapter-napuketto
  ├─ koishi（peer，宿主提供）
  ├─ @napuketto/kernel（装配 + 登录 + 事件通道 + API）
  ├─ @napuketto/loader（自建宿主引导：dlopen + stub + O3MiscService 激活）
  ├─ @napuketto/media（语音 silk 转码）
  ├─ @napuketto/adapter（协议语义：OB11 动作容器——子进程侧经 loader 动态 import 消费）
  └─ @napuketto/network（EventBroadcaster——子进程侧经 loader 动态 import 消费）
```

**关键决策（2026-08-08）**：嵌入走**子进程 IPC**（方案二），不在 koishi 进程内 dlopen。
理由见 §5.2。

## 2. 为什么是「子进程 + IPC」而不是「进程内 dlopen」

NapukettoQQ 的自建宿主（路线 A）是**标准 Node 进程**（stub QQNT.dll 转发 napi_* → node.exe +
`process.dlopen(wrapper.node)`）。koishi 也是标准 Node 进程——两个选择：

| 方案 | 形态 | 稳定性 | 事件延迟 | 多账号 |
|---|---|---|---|---|
| **一：进程内** | koishi 进程内 `NapukettoCore.create()` + dlopen | QQ 原生层崩溃 = koishi 一起挂 | 最低 | 每账号一 Core 实例（ADR-015） |
| **二：子进程 IPC**（选定） | spawn `self-host.cjs` 子进程，stdin/stdout 或 IPC 通道通信 | 子进程崩了重启，koishi 无恙 | 略高 | 每账号一子进程（同 supervisor 模式） |

**选定方案二，理由**：
1. **复用现有链路**：`self-host.cjs`（loader 包已有）就是「spawn 标准 node → dlopen →
   O3MiscService → 登录 → session → 协议装配」的现成脚本，子进程方案**零改造**接入；
   进程内方案要把脚本式改为 API 式（`process.exit` → 回调），改造量大且风险高。
2. **稳定性隔离**：QQ 原生层（wrapper.node 的 C++ 代码）不稳定因素多，崩溃/卡死都不该
   拖垮 koishi 主进程。子进程崩溃可由插件拉起重试，符合 koishi 生态的「适配器隔离」惯例。
3. **多账号天然支持**：每账号一个子进程，与 cli supervisor 完全同构，多账号状态互不污染。

**代价**：事件/调用走 IPC 有序列化开销（可接受）；登录交互（QR 码）需通过 IPC 转发
（见 §6.4）。

## 3. 总体架构

```
┌────────────────────────────── koishi 主进程 ──────────────────────────────┐
│  koishi-plugin-adapter-napuketto（本插件）                                  │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │ apply(ctx, config)                                                    │ │
│  │  ├─ 创建 NapukettoBot（koishi Bot 子类，注册平台）                       │ │
│  │  ├─ 创建 NapukettoDriver（驱动子进程生命周期：spawn / IPC / 重启）        │ │
│  │  └─ 事件桥：kernel 事件 → ctx.emit('message', ...)                      │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │ IPC（stdin/stdout JSON 或 node:child_process IPC）
┌──────────────────────────────▼───────────────────────────────────────────┐
│  Napuketto 自建宿主子进程（每账号一个）                                      │
│  @napuketto/loader self-host.cjs                                           │
│  ├─ dlopen wrapper.node（stub QQNT.dll 转发）                              │
│  ├─ O3MiscService 激活事件分发                                             │
│  ├─ 登录（快速 / QR）→ session READY                                       │
│  ├─ NapukettoCore 装配 → 业务 service 全部 READY                            │
│  └─ 协议装配（adapter core + 事件通道）                                     │
└────────────────────────────────────────────────────────────────────────────┘
```

## 4. 目录结构（规划）

```
apps/koishi-plugin-adapter-napuketto/
├── src/
│   ├── index.ts              # 插件入口：默认导出 NapukettoBot（平台注册）；usage/Config 挂类上（namespace 合并，见 §5.11）
│   ├── constants.ts          # 协议共享常量（PRIVATE_PREFIX / CHANNEL_TYPE / BOT_STATUS，2026-08-14）
│   ├── bot.ts                # NapukettoBot：koishi Bot 子类（平台注册、message 发送）
│   ├── bot/                  # Bot 集成（§5.11，2026-08-14 拆分）
│   │   ├── index.ts          #   出口（barrel）
│   │   ├── bot.ts            #   NapukettoBot（类主体：构造/生命周期/动作方法）
│   │   ├── message.ts        #   NapukettoMessageEncoder（koishi 元素 → internal.sendMessage）
│   │   ├── launch.ts         #   launch 工厂（launchSelfHost 组装 + 包入口解析）
│   │   ├── console-entry.ts  #   控制台前端入口注册（packageRoot + addEntry，模块级去重）
│   │   ├── login-panel.ts    #   NapukettoLoginPanel（面板装配/reload 去重/指令上行）
│   │   ├── session.ts        #   applySessionFields 纯函数（可选字段条件赋值 + elements）
│   │   └── launch.test.ts    #   单测（配置解析纯函数，不真实 spawn）
│   ├── driver/               # 驱动层（§5.7，已实现 2026-08-08）
│   │   ├── index.ts          #   出口（barrel）
│   │   ├── types.ts          #   DriverOptions/DriverEvents/DriverState/ChildProcessLike
│   │   ├── backoff.ts        #   指数退避纯函数
│   │   ├── heartbeat.ts      #   HeartbeatMonitor（心跳健康监控独立类，2026-08-14 拆分）
│   │   ├── driver.ts         #   NapukettoDriver：spawn/IPC/重启（心跳由 heartbeat.ts 负责）
│   │   └── *.test.ts         #   单测（FakeChild + MemoryLinePair 注入，15 用例）
│   ├── ipc/                  # IPC 协议层（§5.6，已实现 2026-08-08）
│   │   ├── index.ts          #   出口（barrel）
│   │   ├── types.ts          #   消息类型联合 + payload 类型（协议契约，loader 侧复用）
│   │   ├── codec.ts          #   JSON 行编解码（encode/decode）
│   │   ├── errors.ts         #   IpcError（协议级错误：TIMEOUT / CLOSED / 远端错误码）
│   │   ├── pending.ts        #   PendingRequests（请求-响应匹配独立类，2026-08-14 拆分）
│   │   ├── transport.ts      #   IpcLineTransport + ChildProcessIpcTransport
│   │   ├── client.ts         #   NapukettoIpcClient（线路处理 + 心跳 + 事件分发）
│   │   └── index.test.ts     #   单测（内存双端注入，不依赖真实子进程）
│   ├── login/                # 登录交互层（§5.8，已实现 2026-08-08）
│   │   ├── index.ts          #   出口（barrel）
│   │   ├── types.ts          #   LoginObserver / LoginView / LoginSnapshot
│   │   ├── machine.ts        #   NapukettoLoginState：状态机 + QR 缓冲
│   │   └── machine.test.ts   #   单测（8 用例：QR 全流程/快速直通/缓冲/重置）
│   ├── console/              # 控制台登录面板（§5.12，2026-08-09）
│   │   ├── index.ts          #   出口（barrel，仅 re-export 有消费者符号）
│   │   ├── types.ts          #   LoginPanelPayload（DataService 下行形状）
│   │   ├── payload.ts        #   快照 → payload 纯函数映射（可单测）
│   │   ├── provider.ts       #   NapukettoLoginProvider（DataService + relogin listener）
│   │   └── payload.test.ts   #   单测（纯函数映射）
│   ├── database/             # 数据库操作集中管理（§5.13，2026-08-09）
│   │   ├── index.ts          #   NapukettoDatabase（channel/user 原子预热）
│   │   ├── serial-queue.ts   #   SerialQueue（per-key 串行队列独立类，2026-08-14 拆分）
│   │   └── __tests__/        #   单测
│   ├── events/               # 事件桥（§5.9，已实现 2026-08-08，地基验证点）
│   │   ├── index.ts          #   出口（barrel）
│   │   ├── types.ts          #   EventBridgeOptions / NapukettoSessionFields
│   │   ├── elements.ts       #   canonical → koishi h()（依赖注入，可单测）
│   │   ├── adapt.ts          #   RawMessage → session 字段（群聊/私聊/临时会话）
│   │   ├── bridge.ts         #   NapukettoEventBridge：kernel 事件 → dispatch
│   │   └── *.test.ts         #   单测（17 用例，mock h 注入不依赖 koishi 运行时）
│   ├── actions/              # 动作桥（§5.10，已实现 2026-08-08）
│   │   ├── index.ts          #   出口（barrel）
│   │   ├── types.ts          #   RequestFn 传输抽象 / NapukettoInternalOptions / PeerTarget
│   │   ├── elements.ts       #   koishi 元素 → canonical（反向映射，纯函数）
│   │   ├── channel.ts        #   channelId → Peer 参数（群聊/私聊/临时会话，纯函数）
│   │   ├── internal.ts       #   NapukettoInternal：koishi bot.internal 封装
│   │   └── *.test.ts         #   单测（mock request 注入，不依赖 koishi 运行时）
│   ├── bot/                  # Bot 集成（§5.11，已实现 2026-08-08，**端到端验证点**）
│   │   ├── index.ts          #   出口（barrel）
│   │   ├── bot.ts            #   NapukettoBot：koishi Bot 子类（平台注册、装配、动作方法）
│   │   ├── message.ts        #   NapukettoMessageEncoder：koishi 元素 → internal.sendMessage
│   │   ├── launch.ts         #   launch 工厂（launchSelfHost 组装 + 包入口解析）
│   │   └── launch.test.ts    #   单测（配置解析纯函数，不真实 spawn）
│   └── config.ts             # Config schema（koishi Schema）
├── client/                   # 控制台前端（§5.12，2026-08-09）
│   ├── index.ts              #   入口：注册 plugin-details slot → Settings 组件
│   ├── settings.vue          #   扫码登录面板（状态分发 + 共享状态；2026-08-14 拆分）
│   ├── components/           #   面板子组件（2026-08-14 拆分，fallow template 复杂度）
│   │   ├── QrCodePanel.vue   #     waiting_scan：二维码 + 过期遮罩 + 刷新/打开链接
│   │   └── StatusSection.vue #     idle/scanned/logged_in/failed：文案 + 重新登录
│   ├── types/                #   前端类型声明（koishijs-client.d.ts / shims.d.ts）
│   └── tsconfig.json         #   前端独立 tsconfig（@koishijs/client/global 类型）
├── scripts/
│   └── build-client.mjs      # client → dist 构建（vite，等价 @koishijs/client yakumo）
├── docs/
│   └── design.md             # 本文件
├── package.json
├── tsconfig.json
├── biome.json
└── tsdown.config.ts
```

## 5. 关键设计决策

### 5.1 依赖形态：bundle 自包含

- 源码 **ESM**（NodeNext + verbatimModuleSyntax，与主仓库一致，TS7.0 + ES2025）
- 产物 **CJS bundle**（tsdown `format: ['cjs']`，koishi loader 用 `require()` 加载）
- **发布形态（2026-08-09 产品化修订）**：`@napuketto/kernel` / `@napuketto/loader`（及
  `@napuketto/media`）为 **dependencies（真实安装，不 bundle）**——子进程要的是磁盘
  真实文件（self-host.cjs / stub QQNT.dll / kernel 入口），bundle 后资产丢失；
  **2026-08-27 起 `@napuketto/adapter` / `@napuketto/network` 同为 dependencies**——
  子进程侧 OB11 动作桥需要磁盘上的 adapter 子路径入口（§5.14），插件自身编译期
  仍零 import（类型面用本包宽松结构描述，不绑 adapter d.mts）
- 开发态：`exports.development` 条件（NODE_ENV=development 直载 `src/index.ts`，
  esbuild-register 转译 + Node24 `require(esm)`），改源码即时生效；配合主仓库
  `linkWorkspacePackages: true`，`~0.0.x` 版本范围在 workspace 内解析到本地源码

### 5.2 子进程 IPC（核心决策）

```
koishi 插件                         Napuketto 子进程
   │  spawn('node', [self-host.cjs])   │
   │ ────────────────────────────────→ │  dlopen wrapper.node + stub
   │                                   │  O3MiscService 激活
   │  ← 状态事件 { type:'boot', ... }  │
   │  ← 登录状态 { type:'login', ... } │  登录（快速/QR）
   │  ← READY { type:'ready' }         │  session READY + 协议装配
   │  ← 消息事件 { type:'event', ... } │  收到消息
   │  动作请求 { type:'action', id }   │
   │ ────────────────────────────────→ │  kernel API 调用
   │  ← 动作响应 { type:'result', id } │
```

- **通道**：`node:child_process` 的 IPC（`fork` 或 spawn + `stdio: ['pipe']`），JSON 行协议
- **消息格式**：`{ type, id?, payload }`；请求-响应用 `id` 匹配（Promise 等待）
- **心跳**：子进程定期发 `ping`，插件超时未收 → 判定失联 → 重启（指数退避）
- **崩溃**：子进程退出码非 0 → 插件记录错误 → 按策略重启（可配置次数）
- **启动前准备（2026-08-23 WSL 事故后新增）**：Linux 首次启动会下载 313MB QQ 安装包 +
  Windows 版 node.exe（wine 场景）——`buildLaunch` 把 loader 的 `onStage` 阶段回调
  接 logger.info（下载/校验/解包/提取/win-node/spawn 全程可见，不再静默 5 分钟）；
  wine 缺失时 loader 预检抛可读错误（apt 指引），driver 侧再挂 child 'error' 监听兜底
  ——此前 spawn ENOENT 异步 'error' 无监听者 = `uncaughtException` 崩掉整个 koishi。

### 5.3 事件翻译：kernel 事件 → koishi session

kernel 事件通道（NTEventChannel，`{ service, name, args }`）→ koishi `ctx.emit`：

| kernel 事件 | koishi 事件 |
|---|---|
| `Msg/onRecvMsg`（私聊） | `message.private` / `message` |
| `Msg/onRecvMsg`（群聊） | `message.group` / `message` |
| `Msg/onRecvMsg`（临时会话） | `message.private`（临时会话归类） |
| 群通知（GroupBridge） | `notice` 系列（群成员增减、禁言等） |
| 请求类（加群/加好友） | `request` 系列（可选，先不做） |

翻译层需要：
- **会话标识映射**：kernel `Peer`（`{ chatType, peerUid }`）→ koishi `Session`（`{ platform, selfId, userId, channelId, guildId }`）
- **消息元素映射**：kernel canonical 元素（text/at/face/image/voice/reply）→ koishi 元素语法（`<at id=""/>`、`<img src=""/>` 等）

### 5.4 动作调用：koishi → kernel API

koishi Bot 动作 → IPC 请求 → 子进程内 kernel API：

| koishi 动作 | kernel API |
|---|---|
| `sendMessage(channelId, content)` | `apis.msg.sendMessage` |
| `deleteMessage(messageId)` | `apis.msg.recallMessage` |
| `getMessage / getMessageList` | `apis.msg.fetchMessages` |
| `markAsRead` | `apis.msg.markRead` |
| 其他 | kernel apis/ 各域（group / friend / user / file / system） |

**关键**：koishi 元素语法 → kernel canonical 元素（反向映射，与 §5.3 对称）。

### 5.5 登录交互

- **快速登录**：子进程自动尝试历史票据快速登录，状态经 IPC 上报
- **QR 登录**：kernel 支持 `qrCodePath` 落盘二维码图片；插件读图路径 → koishi 控制台
  展示（koishi 的 `ctx.console` 或消息形式），扫码成功状态实时推送
- 登录状态机：`idle → booting → logging → ready / failed`，插件可查询/重连

### 5.6 IPC 协议层细节（`ipc.ts`，实现顺序第 1 步）

**传输**：JSON 行协议，走子进程 stdin/stdout（`spawn('node', [self-host.cjs], { stdio: ['pipe','pipe','pipe'] })`）：

| 流 | 方向 | 用途 |
|---|---|---|
| stdout | 子进程 → 插件 | IPC 消息流（readline 按行解析） |
| stdin | 插件 → 子进程 | IPC 消息流 |
| stderr | 子进程 → 插件 | 日志兜底（崩溃堆栈等原始输出） |

每行一条 JSON 消息，`\n` 结尾；`encodeIpcMessage` / `decodeIpcMessage` 保证不丢行。
**消息信封**：`{ v: 1, type, id?, payload }`——`v` 协议版本（解码校验）、`type` 判别字段、
`id` 请求 id（仅 action/result）、`payload` 消息体。

**消息清单**（type 判别联合，`IpcMessage`）：

| type | 方向 | payload | 说明 |
|---|---|---|---|
| `status` | 子→父 | `{ phase, message?, error? }` | 引导阶段：booting/dlopening/logging/sessioning/ready/failed |
| `login` | 子→父 | `{ state, selfInfo? }` | 登录状态（kernel `LoginState`）+ selfInfo |
| `qr` | 子→父 | `{ pngBase64, qrcodeUrl }` | 二维码（kernel `QrCodeData`，koishi 控制台展示用） |
| `event` | 子→父 | `{ service, name, args }` | kernel 事件（NTEventChannel 形状，翻译层消费） |
| `result` | 子→父 | `{ ok, value? } \| { ok, error }` | 动作响应（error 携带 kernel 错误码/消息） |
| `log` | 子→父 | `{ level, message }` | 结构化日志转发（pino level） |
| `ping` | 双向 | — | 心跳 |
| `pong` | 双向 | — | 心跳应答 |
| `action` | 父→子 | `{ action, params? }` | 动作请求（koishi → kernel API） |
| `control` | 父→子 | `{ command, ... }` | 控制指令：stop / restart / login（`{ uin?, qr? }`） |

**请求-响应匹配**（`NapukettoIpcClient.request`）：
- 单调递增 `nextId`；下行 `{ type: "action", id, payload }`
- 内部 pending Map：`id → { resolve, reject, timer }`；`result` 按 `id` 匹配
- 超时（默认 60s，可配）reject `IpcError("TIMEOUT")` 并清理；迟到 result 忽略
- result.error 反序列化为 `IpcError(code, message)`（协议边界错误码是宽松 string，
  不伪造 `KernelErrorCode`；插件侧按需映射 koishi 错误）

**心跳**：子进程每 15s 发 `ping`（self-host 改造时实现，§7）；插件收到自动回 `pong`，
并记录 `lastPingAt`/`lastSeenAt`（epoch ms）。driver 用 `lastSeenAt` 超时（默认 45s）判定失联
→ 重启（指数退避，§6.2）。插件也可主动 `sendPing()` 探活（观察 `lastPongAt` 是否前进）。

**通道抽象**（可独立单测，`src/ipc.test.ts` 用内存双端）：
- `IpcLineTransport`：`write(line)` / `onLine(cb)` / `onClose(cb)` / `close()`
- `ChildProcessIpcTransport`：包装 ChildProcess（stdout readline 收行 + stdin 发行）
- `MemoryLinePair`：测试用内存双端（left/right 互写）
- `NapukettoIpcClient`：传输 + 编解码 + 请求-响应 + 心跳 + 事件分发
  （`on(type, handler)`，泛型收窄到具体消息类型）

**健壮性**：解码失败（非法行/未知 type/v 不匹配）记日志跳过，不崩通道；`close()` 时
pending 全部 reject（`KernelError("CLOSED")`）。

### 5.7 驱动层细节（`driver.ts`，实现顺序第 2 步）

**形态**：`src/driver/` 目录（单文件 ≤300 行约束）：

| 文件 | 职责 |
|---|---|
| `types.ts` | DriverOptions / DriverEvents / DriverState / ChildProcessLike / DriverLauncher |
| `backoff.ts` | 指数退避纯函数（attempt → delayMs，可单测） |
| `driver.ts` | `NapukettoDriver`：spawn / IPC / 重启 / 健康检查 |
| `index.ts` | barrel |

**依赖注入（可单测，不依赖真实子进程）**：

```ts
export interface DriverOptions {
    launch: DriverLauncher;                    // 启动子进程（默认 launchSelfHost 组装，测试注入假 child）
    createTransport?: (child) => IpcLineTransport; // 默认 ChildProcessIpcTransport，测试注入内存双端
    events: DriverEvents;                      // 事件回调（status/login/qr/event/log/ready/exit/error）
    restart?: { maxRetries?: number; backoffMs?: number; backoffFactor?: number };
    heartbeatTimeoutMs?: number;               // 默认 45s
}
export type DriverLauncher = () => { child: ChildProcessLike; cleanup?: () => void };
```

driver **不直接 import loader**（launch 封装隔离，`launchSelfHost({ ipc: true, stdio: ['pipe','pipe','pipe'] })`
在 apply() 层组装注入）——只管子进程生命周期，与传输/IPC 解耦。

**状态机**：

```
idle → spawning → booting（收到 status）→ ready / failed
         └── 崩溃 / 失联（心跳超时）→ restarting（退避）→ spawning ...
stop → stopping → stopped（stop 后不再重启）
```

- status.phase 驱动 booting/ready/failed 迁移；`ready` 时回调 `events.onReady(client)`（上层在
  onReady 里拿新 client 重新接 events/actions——重启后 client 实例会换）
- 每次 spawn 建新 transport + 新 `NapukettoIpcClient`（旧 client 随子进程退出 closed）

**心跳健康检查**：
- 定时器（1s）读 `client.seenAt`；超过 `heartbeatTimeoutMs`（默认 45s）→ 判定失联 → kill + 重启
- **spawn 后立即监控**（兜 dlopen / 登录卡死挂起——wrapper 原生层卡住不发任何消息）

**重启策略**：
- `maxRetries` 默认 3（0 = 不重启）；`backoffMs` 默认 1000 × factor 2（1s/2s/4s）
- 达到上限 → `failed`；`stop()` 后不再重启（stopping 标志）

**stop()**：置 stopping → 发 control stop（优雅退出）→ 等 exit 5s → kill → 清理定时器 + client.close()

**ChildProcessLike**（宽松子进程面，测试可伪造）：`{ stdout, stdin, once('exit'), kill, pid? }`；
`ChildProcessIpcTransport` 构造时断言收窄。

### 5.8 登录交互层细节（`login.ts`，实现顺序第 3 步）

**定位**：登录状态在子进程内驱动（self-host bootstrap 登录），插件侧只做**状态观察 +
QR 展示 + 交互**。driver 的 `onLogin`（kernel LoginState）+ `onQr`（QrCodeData）已透出——
登录层消费这两个回调。

**形态**：`src/login/` 目录（单文件 ≤300 行约束）：

| 文件 | 职责 |
|---|---|
| `types.ts` | `LoginObserver`（driver 回调装配）+ `LoginView`（UI 回调：状态/QR 变化）+ LoginStatus 快照 |
| `machine.ts` | `NapukettoLoginState`：状态机（观察 driver onLogin/onQr → 迁移 + 通知） |
| `index.ts` | barrel |

**状态机**（与 kernel `LoginState` 对齐：idle/waiting_scan/scanned/logged_in/failed）：

```
idle → waiting_scan（收到 QR / polling started）→ scanned（用户已扫码）
     → logged_in（onQRCodeLoginSucceed，携带 selfInfo）
     └→ failed（登录失败 / QR 过期）
```

- **快速登录**（无 QR 阶段）：driver 直接 `onLogin(logged_in)` → logged_in（不经过 waiting_scan）
- **QR 缓冲**：`onQr` 先于 `onLogin(waiting_scan)` 到达（IPC 乱序）→ 内部暂存最新 QR，
  迁移到 waiting_scan 时随状态通知一起送出
- **每次 spawn 重置**：driver 重启（崩溃/失联）→ 新 client → 登录层状态归 idle
  （driver.onExit 或 onReady 重置）

**登录 UI 视图**（koishi 控制台展示，本轮定义接口，apply() 层接 console）：

```ts
export interface LoginView {
    onStateChange?(state: LoginState, self?: SelfInfo): void;  // 状态变化
    onQrChange?(qr: QrCodeData): void;                          // 二维码更新（刷新/过期重取）
}
```

**QR 展示形态**：`qr.pngBase64` → payload 内拼成完整 data URI `image` 字段 →
koishi 控制台 `<img :src="image">`；`qr.qrcodeUrl` 兜底链接（控制台不可用时发消息）。
本轮定义 `LoginObserver` 装配，UI 渲染（console 组件）留给 §6.5 Bot 集成后。

**错误**：`failed` 时经 `view.onStateChange` 通知 + 记录最近错误（`lastError`），
apply() 层可查（driver 已按重启策略兜底）。

### 5.9 事件桥细节（`events.ts`，实现顺序第 4 步，**地基验证点**）

**定位**：driver 已把 kernel 事件 `{ service, name, args }` 透出（onEvent）——事件桥做
**kernel 事件 → koishi session** 翻译并 `bot.dispatch(session)`。**验证点：koishi 里能
收到 QQ 消息。**

**形态**：`src/events/` 目录（单文件 ≤300 行约束）：

| 文件 | 职责 |
|---|---|
| `types.ts` | `NapukettoSession`（宽松 Session 构造面）+ EventBridgeOptions / 回调 |
| `elements.ts` | canonical 元素 → koishi `h()` 元素（纯函数，可单测） |
| `adapt.ts` | kernel `RawMessage` → koishi session 字段（纯函数，可单测） |
| `bridge.ts` | `NapukettoEventBridge`：订阅 driver onEvent → 翻译 → dispatch |
| `index.ts` | barrel |

**会话标识映射**（napcat/onebot 同构骨架，§9.1）：

| 场景 | session.type | userId | channelId | guildId | isDirect |
|---|---|---|---|---|---|
| 群聊（chatType=2） | `message.group` | senderUin | groupCode | groupCode | false |
| 私聊（chatType=1） | `message.private` | senderUin | `private:` + senderUin | — | true |
| 临时会话（chatType=100） | `message.private` | senderUin | `private:` + senderUin | groupCode | true |

- `senderUin`（RawMessage 直接带，无需 uid→uin 查询——群聊/私聊的发送者 QQ 号）
- `peerUin`（RawMessage 直接带：群号 / 对端 QQ 号）→ channelId/guildId
- **selfId**：登录账号 uin（onReady 时从 login 快照取，随事件桥初始化）

**元素映射**（canonical → koishi `h()`）：

| canonical | koishi |
|---|---|
| `{ type: "text", text }` | `h.text(text)` |
| `{ type: "at", target }` | `h.at(target)`（target 为 "all" → `h.at("all")`） |
| `{ type: "image", url?/path }` | `h("img", { src })`（**koishi 标准元素是 img**，onebot 实证；url 优先，path 兜底） |
| `{ type: "face", id }` | `h("face", { id })`（emoji 元素，QQ 表情码） |
| `{ type: "voice", url?/path }` | `h.audio(url ?? path)` |
| `{ type: "reply", messageId }` | `h.quote(messageId)`（引用） |
| 其他（video/file/forward/json/xml/unknown） | 降级 `h.text("[type]")` 占位（后续扩充） |

**桥装配**（apply() 层）：

```ts
const bridge = new NapukettoEventBridge({
    driverEvents: { onEvent: (payload) => bridge.handle(payload) }, // driver 事件源
    dispatch: (session) => bot.dispatch(session),                  // koishi Bot.dispatch
    selfId: () => login.snapshot.self?.uin ?? config.selfId ?? "",
});
```

**翻译链路**：`payload.args[0]`（RawMessage）→ `adaptRawMessage` → `adaptElements` →
`session.type/elements/isDirect` 填充 → dispatch。`Msg/onRecvMsg` 的 args 是**消息数组**
（运行时实证，§5.3 注）→ 遍历逐条翻译。

**⚠️ 过滤系统占位消息**（2026-08-09 修复）：`Msg/onRecvMsg` 批量推送里可能混有
`senderUin="0"` 的系统占位消息（元素为空、无业务价值，群通知本身走
`Group/onGroupNotifiesUpdated` 专门事件）。bridge 直接跳过，不 dispatch——否则
koishi attach 会对无价值消息 `get-or-create channel`，且多条同 tick 时撞 koishi
get-or-create 的并发竞态：`UNIQUE constraint failed: channel.id, channel.platform`
（实测 2026-08-09：同批 4 条系统消息 → 1 成功 + 3 冲突。记录本身创建成功、后续
get 命中不复发，纯日志噪音，但无意义——根因是 koishi `Session.getChannel` 的
get-or-create 无互斥：并发 SELECT 全部先于首个 INSERT，随后多次 INSERT 撞唯一键）。

**⚠️ 只设 elements 不设 content**（2026-08-08 三稿修复）：satorijs `Session.content` 是
getter（`elements.join("")` 派生），**setter 会用 `h.parse(value)` 覆盖 elements**——若
adapt 层同时填 content，结构化元素（at/img/face）会被 parse 覆盖丢失，且 content 含特殊
字符时 parse 可能抛错导致 dispatch 失败（数据库无记录）。翻译层只产 `elements`（+ `isDirect`
驱动 `event.channel.type`），content 由 koishi getter 自动派生。

**本轮不做**：群通知（GroupBridge）/ 请求类 → notice/request 系列（§6.6 后续）；
消息记录（`message-deleted` 等）——先打通 message 事件（验证点）。

### 5.10 动作桥细节（`actions.ts`，实现顺序第 5 步）

**定位**：koishi Bot 动作 → IPC action 请求 → 子进程 kernel API。与事件桥（§5.9）对称：
事件桥做 kernel → koishi（收到消息），动作桥做 koishi → kernel（发出消息）。
**验证点：koishi 里能回复消息。**

**形态**：`src/actions/` 目录（单文件 ≤300 行约束）：

| 文件 | 职责 |
|---|---|
| `types.ts` | `RequestFn`（传输抽象）/ `NapukettoInternalOptions` / `PeerTarget` |
| `elements.ts` | koishi 元素 → canonical（与 events/elements.ts 对称，纯函数） |
| `channel.ts` | channelId → Peer 参数（群聊/私聊/临时会话，纯函数） |
| `internal.ts` | `NapukettoInternal`：koishi `bot.internal` 封装（`_request` 传输抽象 + 核心动作） |
| `index.ts` | barrel |

**传输抽象**（napcat `internal._request` 同构，§9.1——把 HTTP 换成 IPC 请求）：

```ts
type RequestFn = (action: string, params?: Record<string, unknown>) => Promise<unknown>;
// apply() 层注入：request = (action, params) => client.request(action, params)
```

**核心动作映射**（loader 侧动作表已就绪，§7：`msg.sendMessage/recallMessage/fetchMessages/
markRead` + `group.getGroupList` + `friend.getFriendList` + `login.getSelf`；**peerUin 自动转
uid**——注入 groupApi.uinToUid）：

| koishi 动作 | IPC action | params |
|---|---|---|
| `sendMessage(channelId, content)` | `msg.sendMessage` | `{ chatType, peerUin, elements: canonical[] }` |
| `deleteMessage(channelId, messageId)` | `msg.recallMessage` | `{ chatType, peerUin, msgIds: [messageId] }` |
| `getMessageList(channelId, before?, limit?)` | `msg.fetchMessages` | `{ chatType, peerUin, count, msgId? }` |
| `markAsRead(channelId)` | `msg.markRead` | `{ chatType, peerUin }` |
| `getGroupList()` | `group.getGroupList` | — |
| `getFriendList()` | `friend.getFriendList` | — |
| `getSelf()` | `login.getSelf` | — |

**channelId 解析**（与事件桥 §5.9 会话标识映射对称）：

| channelId | guildId | chatType | peerUin |
|---|---|---|---|
| 群号（纯数字） | — | 2（GROUP） | 群号 |
| `private:` + uin | 无 | 1（C2C） | uin |
| `private:` + uin | 有（群号） | 100（TEMP 临时会话） | uin |

**元素反向映射**（koishi → canonical，与 §5.9 对称；attrs 键名 §5.9 已确认：
`h.at` → `{ id }`、`h("img")` → `{ src }`、`h.quote` → `{ id }`、`h.audio` → `{ src }`）：

| koishi | canonical | 备注 |
|---|---|---|
| `text`（children join） | `{ type: "text", text }` | |
| `at`（attrs.id） | `{ type: "at", target }` | `id="all"` 原样 |
| `img`（attrs.src） | `{ type: "image", path }` | **koishi 标准元素是 img**（兼容旧 `image` 写法）；本地路径；**http(s) URL 透传**（internal.sendMessage 的 `downloadRemoteMedia` 下载到临时文件后发送，失败回退占位文本 `[图片: url]` + warn，2026-09-08）；**file:// URL 先 `fileURLToPath` 再统一规范化**（见下） |
| `face`（attrs.id） | `{ type: "face", id }` | |
| `audio`（attrs.src） | `{ type: "voice", path }` | 本地路径；http(s) URL 同 img 策略（下载后发送，失败回退 `[语音: url]`） |
| `video`（attrs.src） | `{ type: "video", path }` | 本地路径；http(s)/data URL 同 img 策略落盘；发送前由 `enrichVideoElements` 用 `@napuketto/media` 抽帧补 `thumbPath`/`width`/`height`/`durationSec`（见下） |
| `quote`（attrs.id） | `{ type: "reply", messageId }` | |
| 其他（p/br/file/…） | `{ type: "text", text: toString() }` | 保内容不丢 |

字符串 content（koishi 允许 `sendMessage(channelId, "纯文本")`）→ 单 text 元素；
空内容 → 空数组 → `sendMessage` 返回 `[]`（不发请求）。
`getMessageList` 返回 `{ data: RawMessage[], next: 末条 msgId }`（koishi MessageList 形状）。

**媒体路径规范化（2026-08-09 redposter 实证修复）**：`img`/`audio` 的本地路径
统一走 `normalizeMediaPath`——Windows 反斜杠 → 正斜杠（`path.replace(/\\/g, "/")`），
`file://` URL 先 `fileURLToPath` 再规范化。原因：wrapper.node 的 rich media 服务按
URL 语义解析图片路径，透传 `C:\...` 反斜杠路径读不到文件，返回 `rich media transfer
failed`（现象：发送方日志 `已缓存海报图片` 成功但 `msg.sendMessage` 失败）。正斜杠
路径无此问题（Chromium/Electron 内部按 URL 处理路径）。

**图片 data URL 物化（2026-08-25 修复）**：Koishi 控制台二维码或其他上游可能把图片
以 `data:image/...;base64,...` 形式传入。动作桥在发 IPC 前将其解码到系统临时目录，
把临时文件路径放入 canonical `image`，请求完成（成功或失败）后删除临时目录；因此
kernel/`wrapper.node` 始终收到可读取的本地文件路径，不会把整段 Base64 当作文件名。
支持 Base64 与百分号编码的图片 data URL。

**语音 silk 转码（2026-08-23 线上修复）**：`audio` → canonical `voice` 后、发 IPC
`msg.sendMessage` 前，统一经 `actions/media.ts` 的 `ensureVoiceSilk` 把语音转成
**silk v3**（QQ 语音协议格式）。背景：此前 koishi 路径不做转码，ogg/mp3 等非 silk
音频被 `MsgApi.preparePttElement` 原样复制到 `Ptt\Ori\{md5}.amr` 并上传（线上实证
`OggS` 魔数原样落盘），QQ 播放器只能解码 silk/amr → **语音发送成功但收件人无法播放**。
修复：`ensureSilk(path)` 读文件头 8 字节，`#!SILK` 前缀原样返回；否则走
`@napuketto/media` 的 `encodePcmToSilk`（ffmpeg 归一化 24000Hz 单声道 + silk-wasm
编码，产出标准 `#!SILK_V3` 头文件，实证 `ogg 1.3MB → silk 450KB`）；转码失败回落
原路径（kernel 发送兜底，不阻断）。依赖：新增 `@napuketto/media`（apps 层自由依赖，
media 与 kernel 解耦红线不涉及）。

**视频发送补全（2026-10-17）**：`video` → canonical `video` 后、发 IPC
`msg.sendMessage` 前，`actions/media.ts` 的 `enrichVideoElements` 用
`@napuketto/media` 的 `getVideoInfo`（ffprobe）与 `extractVideoFrame`（ffmpeg 抽首帧
PNG）补 `width`/`height`/`durationSec`/`thumbPath`，供 kernel 构造完整
`videoElement`（QQ 视频消息发送契约需要 thumbPath/thumbMd5/thumbWidth/thumbHeight/
fileTime）。处理链顺序：`downloadRemoteMedia`（http(s) 视频下载，上限 100MB）→
`ensureVoiceSilk` → `materializeDataUrlImages` → `materializeDataUrlVideos`
（`data:video/*;base64,…` 落盘 `.mp4` 等临时文件）→ `enrichVideoElements`；
所有临时目录在请求结束（成功或失败）后逆序清理。缩略图/元数据生成失败（ffmpeg 缺失、
非视频文件）→ 打 warn、**去掉缩略图继续发送**（不阻塞其余元素）；kernel 侧再失败会
按 `SEND_FAILED` 上抛。**验证状态**：kernel 发送侧已于 2026-10-17 18:12 在自建宿主
实测打通（kernel design.md §8.4：根因是缩略图目标路径必须用视频 md5，不能用缩略图
内容 md5；群内收到可播放视频）；本层（data URL 落盘 + ffmpeg 抽帧）已由单测覆盖，
**尚未经真实插件触发做端到端复测**——2026-10-17 18:20 的复测尝试因上游 B 站插件的
`videoParseMode` 配置问题没走到本层（见 STATUS），复测时只需确认 `thumbPath` 是真实
本地 PNG 文件、`width`/`height` 取视频宽高。

**可单测**：`elements.ts` / `channel.ts` 纯函数直测；`internal.ts` 注入 mock request
（`vi.fn`）断言动作名 + params。koishi 主包不 import（HANDOVER §7 坑 1），类型宽松结构。

### 5.11 Bot 集成细节（`bot.ts`，实现顺序第 6 步，**端到端验证点**）

**定位**：`NapukettoBot extends Bot` 注册为 koishi 平台，把 §5.2~§5.10 全部装配起来。
**验证点：koishi 控制台收到消息 + 能回复**（事件桥 + 动作桥端到端）。

**形态**：`src/bot/` 目录（单文件 ≤300 行约束，2026-08-14 fallow 拆分 + utils 归类）：

| 路径 | 职责 |
|---|---|
| `bot.ts` | `NapukettoBot extends Bot`：平台注册、生命周期、override 动作方法、dispatch（类主体） |
| `message.ts` | `NapukettoMessageEncoder extends MessageEncoder`（元素收集 → internal.sendMessage） |
| `launch.ts` | launch 工厂（launchSelfHost 组装 + 包入口解析，纯函数可单测） |
| `login-panel.ts` | `NapukettoLoginPanel`：面板装配/reload 去重/连接回放/指令上行（deps 注入解耦） |
| `utils/assembly.ts` | 构造装配工厂（createLoginState/createPanel/createBridge/createInternal/resolveAssignPolicy，host 注入） |
| `utils/transform.ts` | kernel → koishi Universal 形状翻译纯函数（好友/群/频道/登录信息，可单测） |
| `utils/driver-events.ts` | driver 事件接线工厂（buildDriverEvents，host 注入） |
| `utils/session.ts` | `applySessionFields` 纯函数（可选字段条件赋值 + elements 特殊处理） |
| `utils/console-entry.ts` | 控制台前端入口注册（packageRoot 逐级上溯 + addEntry，模块级去重） |
| `index.ts` | barrel（只导出公共面：NapukettoBot / launch / message） |

**usage/Config 挂类上（关键决策，2026-08-14 根因修复）**：
`usage`（插件详情页说明）与 `Config`（配置 schema）通过 `export namespace NapukettoBot`
声明合并挂成类静态属性，**不放 index.ts 模块级导出**。原因：koishi loader 的
`unwrapExports = module?.default || module` 会把 `export default NapukettoBot` 解包成类本身，
丢弃模块级 `usage`/`name` 导出 → 控制台 `PackageProvider.parseExports` 读 `exports?.usage`
恒 undefined → 插件详情页不显示说明（实测 bug，提交 7513f04）。挂到类上后静态属性随类
保留。`Config` 同理（koishi bots 配置校验按 `bot.constructor.Config` 反射查找）。

**装配方式（关键决策）**：**不写 Adapter**（fork/connect 抽象为 HTTP/WS 网络服务设计）。
koishi `Bot` 构造自动注册 `ctx.on('ready', () => this.start())`——直接 override `start()`
spawn driver，`stop()` 停 driver。与 driver 的进程编排模式同构，少一层抽象。

```
koishi 框架（bots 配置实例化）
  └─ NapukettoBot(ctx, config)
       ├─ internal = NapukettoInternal({ request: clientRef 绑定 })   // 动作桥
       ├─ login = NapukettoLoginState()                                // 登录交互
       ├─ start() → NapukettoDriver({ launch: buildLaunch(config) })  // 进程编排
       │    └─ events.onReady → clientRef 更新 + 事件桥重建 + online()
       └─ 动作方法 → internal（sendMessage 走 static MessageEncoder）
```

**生命周期**：

| 钩子 | 行为 |
|---|---|
| `constructor` | `super(ctx, config, 'onebot')`；`selfId = config.selfId`（koishi `defineAccessor` 写 user.id）；internal/login 实例化；user.avatar 用 q.qlogo.cn（napcat 同款） |
| `start()` | `status = CONNECT` → 建 driver（launch 工厂）→ `driver.start()`；异常 `offline(error)` |
| driver `onReady` | `clientRef.current = driver.currentClient`；`login.onReady()`；重建事件桥（client 换实例）；`online()`；`getLogin()` 更新 user |
| driver `onExit` | `login.onExit()`（登录状态归 idle）；非 stop 时 `offline()` |
| driver `onError` | 记日志；重启达上限时 `offline(error)` |
| `stop()` | `driver.stop()` → `super.stop()`（offline） |
| `dispose()` | Bot 基类：从 ctx.bots 移除 + `stop()`（ctx dispose 自动） |

**动作方法**（走 `this.internal`，loader 动作表已就绪 §7）：

| koishi 动作 | internal | 备注 |
|---|---|---|
| `createDirectChannel(userId)` | — | 返回 `{ id: 'private:' + userId, type: DIRECT }`（napcat 同款） |
| `getMessageList(channelId, next?, dir?, limit?)` | `getMessageList` | 返回 `{ data, next }` |
| `deleteMessage(channelId, messageId)` | `deleteMessage` | |
| `getLogin()` | `getSelf` | 填 user → `toJSON()`（initialize 用） |
| `getFriendList()` | `getFriendList` | 转 `Universal.Friend` 形状 |
| `getGuildList()` | `getGroupList` | 转 `Universal.Guild` 形状 |

**MessageEncoder**（`message.ts`）：koishi `Bot.createMessage` 用 `static MessageEncoder`
实例化 → `send(content)` → `prepare()`（channel.type 补全）+ `render()`（逐个 `visit`）
+ `flush()`。visit 收到的 element 是 **h 实例**（text 内容在 `attrs.content`！napcat 实证）：
攒进数组，`flush()` 一次性 `internal.sendMessage(channelId, collected, guildId)` →
`session.app.emit('send')`。元素到 canonical 的转换复用 actions/elements.ts
（`toCanonicalElements` 宽松结构吃 h 实例，`attrs.content`/`attrs.id`/`attrs.src`）。

**launch 工厂**（`launch.ts`）：组装 `launchSelfHost`（参考 cli boot.ts）：

```ts
launchSelfHost({
  qq: resolveQqInstall(config.qqPath),           // loader
  kernelEntry: resolveEntry('@napuketto/kernel', config.kernelEntry),
  cfgDir: join(dataRoot, config.selfId),
  configPath: resolveConfigPath({ dataRoot }),   // kernel
  cwd: dataRoot,
  selfHost: true,
  ipc: true,
  stdio: ['pipe', 'pipe', 'pipe'],
  quickUin: config.selfId,
  stubDir: config.stubDir ?? defaultStubDir(),
})
```

- `resolveEntry(pkg, override)`：override 优先；否则 `import.meta.resolve`（开发态 workspace
  包已 build；生产 bundle 态需 config 覆盖，HANDOVER 记录发布形态问题）
- **IPC 模式不传 adapterEntry/networkEntry**（loader ipc-bootstrap 只用 kernel services）
- 纯函数抽离（`resolveLaunchOptions(config)`）可单测；launchSelfHost 真实 spawn 不测

**⚠️ 发布形态（记录，本轮不解决）**：`@napuketto/*` 被 bundle 进产物后 `import.meta.resolve`
失效、`launchSelfHost` 内部 `__dirname` 定位 self-host.cjs 也失效（bundle 内联）。本轮目标
= **开发态端到端验证**（exports.development 直载 src + workspace 包已 build）。生产发布需
改依赖形态（external + dependencies）或打包 self-host 资源，收尾步骤 7 处理。

**koishi 主包 import 边界**：bot.ts/message.ts/config.ts/index.ts 运行时 import koishi
（Bot 继承/MessageEncoder/Schema）——**不进单测**（HANDOVER §7 坑 1）；可单测的纯逻辑
（launch 配置解析、元素映射）独立成文件 + mock 注入。

### 5.12 控制台登录面板（`console/` + `client/`，2026-08-09）

**定位**：koishi 特有的扫码登录体验——在 Koishi 控制台的**插件详情页**内嵌登录面板：
实时显示登录状态、扫码二维码（base64 图）、登录成功账号信息，可一键重新登录。
机制参考 `koishi-plugin-adapter-bilibili-dm`（MIT，仅借鉴机制骨架，实现自研）。

**前后端数据流**（Koishi Console 标准三件套）：

```
┌─ 前端 client/settings.vue ──────────┐      ┌─ 后端 src/console/ ──────────────────┐
│ inject('manager.settings.*') 读配置  │      │ NapukettoLoginProvider               │
│ store['napuketto-login-<uin>'] 读状态│◄─────│ extends DataService（store 下行推送）│
│ send('<uin>/relogin') 发指令         │─────►│ ctx.console.addListener（指令上行）  │
│ ctx.slot(plugin-details) 挂载面板    │      │  → bot → IPC control restart（重登录）│
└─────────────────────────────────────┘      └──────────────────────────────────────┘
```

| 环节 | 机制 | 说明 |
|---|---|---|
| 数据下行 | `DataService<T>`（`@koishijs/plugin-console`） | serviceId = `napuketto-login-<uin>`，`update()` 存快照 + `refresh()` 推 store |
| 指令上行 | `ctx.console.addListener` + 前端 `send()` | `napuketto-login-<uin>/relogin`：触发重新登录 |
| UI 挂载 | `ctx.console.addEntry({ dev, prod })` + `ctx.slot({ type: 'plugin-details' })` | 开发态 dev 指 `client/index.ts`（koishi dev 动态编译）；生产态 prod 指 `dist`（vite 打包产物） |
| 插件详情识别 | `inject('manager.settings.local/config')` | 前端校验当前查看的是本插件 + 从配置取 selfId（多账号隔离） |

**登录状态源**：子进程 bootstrap 登录（快速登录失败 → 自动 QR，kernel 驱动，二维码过期
自动 refresh）→ IPC `qr`/`login` 消息 → driver `onQr`/`onLogin` → `NapukettoLoginState`
状态机 → `LoginView` 回调 → provider 推送。**无需后端轮询**（kernel 已自动驱动）。

**后端形态**（`src/console/`，单文件 ≤300 行约束）：

| 文件 | 职责 |
|---|---|
| `types.ts` | `LoginPanelPayload`（state/selfId/message?/qr?/self?/lastError?） |
| `payload.ts` | `toLoginPanelPayload(snapshot, selfId)` 纯函数（LoginSnapshot → payload，可单测） |
| `provider.ts` | `NapukettoLoginProvider extends DataService<LoginPanelPayload>`：`update()` 合并 + refresh；注册 `relogin` listener → `onRelogin` 回调 |
| `index.ts` | barrel |

**provider 装配**（bot.ts 构造，`ctx.inject(['console'])` 延迟到 console 服务就绪）：

```ts
// bot.ts（satorijs Context → koishi Context cast，运行时同实例）
const kctx = this.ctx as unknown as KoishiContext;
kctx.inject(['console'], (ctx) => {
  const provider = new NapukettoLoginProvider(ctx, {
    selfId: config.selfId,
    onRelogin: () => this.requestRelogin(),      // 见下
    onRefreshQr: () => this.requestRefreshQr(),  // IPC 直达刷新二维码
  });
  this.panelRef.current = provider;
  // 服务值注册到 root store（PULL 拉取）+ console/connection 兜底重推（PUSH 回放）
  const disposeService = ctx.root.set(`console.services.${loginServiceId(config.selfId)}`, provider);
  const offConnection = ctx.console.ctx.on('console/connection', () => this.pushLoginPanel());
  ctx.on('dispose', () => { disposeService(); offConnection(); });
  this.pushLoginPanel();                        // 立即推送当前快照
});
```

- `LoginView` 三回调（onStateChange/onQrChange/onError）统一走 `pushLoginPanel()`：
  `snapshot → toLoginPanelPayload → panelRef.update()`
- **重新登录 / 强制扫码**（2026-09-08 T2 重做；2026-09-08 A2 扩展 ready 态软重登，
  决策与执行在 `login-actions.ts` 纯函数）：
  - **重新登录**：登录期（idle/waiting_scan/scanned）→ `control login {uin}` 原地重登
    （不重启子进程；loader 端成功结果**抢占初始登录竞速**——`relogin.ts` 的
    LoginControl 相位机，快速登录风控挂起时强制扫码/重登也能走完装配链到 ready）；
    **logged_in（ready 态）→ 同样 `control login` 走软重登**（loader 端清理旧装配面
    后用新登录结果重跑装配链，2026-09-08 A2 已实现，不再整进程重启）；failed /
    client 不可用 → `control restart` 整进程重启（可靠路径）。
  - **强制扫码**：登录期/ready 态 → `control login {uin, qr:true}`（原地出码 /
    软重登切扫码流）；failed/client 不可用 → 置一次性 `qrOnly` 标记（bot.qrOnlyRef）
    + `control restart`——重启后子进程经 `NAPUTO_QR_ONLY=1` 跳过快速登录直接出码
    （标记在 spawn 时消费清零，崩溃退避重启不重复扫码）。
  - **软重登换账号的防线**（driver ready 幂等守卫下软重登完成后 onReady 不会重触发，
    `checkIdentity` 改由登录消息面补位）：loader 端软重登成功会重播
    `sendLogin("logged_in", selfInfo)`，driver-events 在收到携带 selfInfo 的
    logged_in 时调 `bot.handleLoggedIn` → `checkIdentity` 复核——换账号登录
    （软重登切号）**拒绝上线**（stop driver + offline，防数据目录与
    channel.assignee/binding 污染，同 2026-08-20 生产事故防线）；同账号通过并同步
    昵称刷新。初次引导也经此先于 ready 校验一次（幂等，等于提前发现不一致）。
- **前端入口 addEntry**（bot.ts 模块级去重）：koishi 平台插件注册 Bot 靠**默认导出 Bot 类**
  （`ctx.platform(name)` 只是平台作用域，不是注册 API）——addEntry 放 bot 构造的 console
  inject 回调里，`consoleEntryRegistered` 模块级 flag 保证多 bot 实例只注册一次；
  路径用 `import.meta.url` 定位（开发态 ESM 直载），bundle 后 `__dirname` 兜底。

**⚠️ addEntry 作用域绑定 + 去重 flag 必须随作用域 dispose 重置（2026-08-14 实证，
插件 stop/start 后面板消失根因）**：`ctx.console.addEntry()` 创建的 `Entry` 是**作用域
绑定**的（@koishijs/console `src/entry.ts`：`ctx.collect('entry', () => delete
entries[id])`）——插件 stop → 作用域 dispose → **console 自动移除 entry**。若模块级
去重 flag 不重置，插件重启后 `registerConsoleEntry` 直接 return → 不重新 addEntry →
entry 永久丢失 → 前端 slot 组件（扫码面板）消失。修复：`ctx.on("dispose", () => {
consoleEntryRegistered = false; })`——作用域销毁时重置 flag，下次插件启动可重新注册。
多 bot 场景：第一个 bot 注册（挂 dispose 重置），其余 return 不挂——但第一个的
dispose 会重置 flag，整体正确（无活跃 entry 时 flag 必为 false）。bilibili-dm 无去重
每次 apply 都 addEntry，天然无此问题。

**前端形态**（`client/`）：

| 文件 | 职责 |
|---|---|
| `index.ts` | `ctx.slot({ type: 'plugin-details', component: Settings, order: 800 })`（B站模板同款挂载点） |
| `settings.vue` | 状态机渲染：idle/waiting_scan（二维码）/scanned/logged_in/failed + 重新登录/扫码登录按钮；`LoginPanelData` 接口类型化（对齐后端 payload） |
| `shims.d.ts` | `*.vue`/`*.yaml`/`*.yml` 模块声明（替代上游 `@koishijs/client/global`——其 5.30.11 exports 映射 bug） |
| `koishijs-client.d.ts` | `@koishijs/client` 本地类型 shim（上游以 TS 源码发布，strict 下会暴露 122 条上游错误；paths 重定向隔离） |
| `tsconfig.json` | strict 全家桶 + `moduleResolution: bundler` + `paths` 重定向；`types: []`（防 node 全局泄漏）；**已纳入包级 `pnpm check`** |

前端要点（B站模板模式）：
- 数据：`store['napuketto-login-<uin>']`（Vue 响应式，`computed` 读取 + 插件名/selfId 校验）
- 二维码：后端 payload 直接给 `image`（完整 data URI）→ `<img :src="data.image">`；`qr.qrcodeUrl` 链接兜底
- 重新登录：`send('napuketto-login-<uin>/relogin', { selfId })`
- 扫码登录：`send('napuketto-login-<uin>/qr-login', { selfId })`（2026-09-08）
- 过期展示：前端做 3 分钟展示计时器（纯 UI 辅助），真正过期由 kernel 自动 refresh 推新码
- **零 HTTP 请求**：只读 store + 发 WebSocket 事件

**⚠️ 子组件标签必须与 import 名大小写一致（2026-08-14 实证，二维码不显示根因）**：
模板里写 `<qrcode-panel>`（全小写连写）但 import 的是 `QrCodePanel`——Vue SFC 编译器
做 kebab-case→PascalCase 匹配：`<qrcode-panel>` 反推为 `QrcodePanel`，与 `QrCodePanel`
**大小写不匹配**（`Qrcode` ≠ `QrCode`）→ 编译器无法静态关联 import 变量 → 降级为
`resolveComponent("qrcode-panel")` 运行时解析 → 组件未显式注册 → 渲染成**空的自定义
元素**（DOM 里 `<qrcode-panel qr="[object Object]">`，props 全字符串化），同时
tree-shaking 把未被引用的 QrCodePanel 组件定义从产物删掉（产物只有 StatusSection）。
**修复**：模板标签用 PascalCase `<QrCodePanel>`（或与 import 名完全匹配的 kebab-case）。
判别信号：dist 产物里引用是 `p("qrcode-panel")`（resolveComponent）而非 `g(变量)`；
CSS 缺失对应组件 scoped 样式（`.qrcode-container` 等）。

**client 构建**（`scripts/build-client.mjs`）：等价 `@koishijs/client` 的 yakumo client
构建（vite）：`client/index.ts` → `dist/index.js`（IIFE，`external: ['vue', 'vue-router',
'@vueuse/core', '@koishijs/client']`——运行时由 koishi console 提供全局变量）。dev 模式
（koishi dev）直接编译 `client/index.ts`，无需预构建。

**依赖**（发布形态，B站模板同款务实选择）：
- `@koishijs/plugin-console` → **dependencies**（provider 运行时 `import { DataService }`；
  放 dependencies 由 npm 自动安装 + koishi 自动加载内置插件，避免用户未装 console 时
  import 崩溃）
- `@koishijs/client` → **dependencies**（client 源码 dev 模式被 koishi dev 编译时需要；
  与模板一致）
- `vite` + `@vitejs/plugin-vue` → devDependencies（仅构建脚本用）
- tsdown 产物保持 external（`neverBundle` 已覆盖 `/^@koishijs\//`）

**biome 边界**：根 biome `files.includes` 只扫 `**/src/**`——`client/`（.vue/.ts）与
`scripts/*.mjs` 不在 biome 检查范围（独立构建链）；但 **`client/` 已纳入包级类型门禁**：
`pnpm check` = `biome check . && tsc --noEmit && tsc --noEmit -p client/tsconfig.json`；
`src/console/` 在 biome 范围内照常检查。

### 5.13 数据库操作集中管理（`database/`，2026-08-09）

**背景**：插件此前无自有数据库操作——channel/user 落库全在 koishi 框架内部
（`Session.getChannel`）。而 koishi 的 `getChannel` 是 check-then-act：

```ts
async getChannel(id, fields) {
    const channel = await app.database.getChannel(platform, id, fields) // ① SELECT
    if (channel) return channel
    return app.database.createChannel(platform, id, { assignee, guildId, createdAt }) // ② INSERT
}
```

多条消息同 tick dispatch（QQ 批量推送 + 群通知高频事件）时，各 session 的 ① 全部先于
首个 ② 完成 → 多个 INSERT 撞 `(id, platform)` 唯一键（2026-08-09 实测：同批 4 条消息
→ 1 成功 + 3 次 `UNIQUE constraint failed: channel.id, channel.platform`）。记录最终
创建成功、后续 SELECT 命中不复发，纯日志噪音，但会刷屏且理论上有中断消息处理链风险。
过滤系统占位消息（`senderUin="0"`，f6dd177）只能消除系统消息场景，真实消息批量到达
仍会触发。

**方案**：`NapukettoDatabase`（`src/database/index.ts`），dispatch 前原子预热 channel：

- **两段式**：先 `get('channel', { id, platform }, ['id'])` 命中直接返回（绝大多数路径
  零写入）；未命中才 `upsert('channel', row, ['id', 'platform'])`——minato upsert 是
  `INSERT ... ON CONFLICT DO UPDATE`，**并发安全幂等，不抛错**。预热后 koishi 的
  SELECT 必命中，永远走不到 createChannel，从根上消除竞态。
- **createdAt 只随新行携带**：已存在行 upsert 只 merge assignee/guildId，不刷新
  createdAt（两段式保证：命中即返回，只有并发 miss 的双 upsert 会覆盖 createdAt，
  毫秒级可忽略）。
- **per-channel 串行队列**：key = `platform:id`，同 channel 的 ensure 排队执行
  （不同 channel 并行），保证同 channel 消息 dispatch 顺序与预热顺序一致。
- **降级不阻断**：`ctx.database` 不可用或 upsert 失败 → 单次警告后跳过（koishi
  get-or-create 兜底），**绝不阻塞消息 dispatch**。
- **autoAssign 语义对齐**：`assignee = selfId`（koishi `autoAssign=true` 时的落库
  行为）；`autoAssign=false`（构造时解析 `ctx.config.autoAssign`，函数形式默认 true）
  时跳过预热，保持 koishi 不落库语义。

**服务访问（2026-08-09 修订）**：cordis 的 `provide` 把服务注册在
`ctx.root[symbols.internal]`，但 `resolveInject` 只查当前 ctx 自己的 internal——
插件 scope 的 ctx 若自身 internal 为空对象会遮蔽 root 链，`ctx.database` 解析为
undefined 并**每次访问都 emit `internal/warning`**（实测每条消息刷 `property
database is not registered`）。修复：
- `NapukettoDatabase` 构造时收 `ctx.root`（root 的 internal 一定含 database，且
  `checkInject` 对 root 直接放行——root 无 plugin runtime，**不产生 warning**）；
- `NapukettoBot` 声明 `static inject = { database: { required: false }, console:
  { required: false } }`（2026-08-14 补全：console 登录面板也是可选增强；Bot
  子类插件 `export default` 的模块级导出会被 loader unwrapExports 丢弃，inject
  必须挂类上 static。optional 依赖让 `internal/inject` 检查放行，双保险；
  不强制用户装数据库/控制台）。

**用户预热（ensureUser，2026-08-09）**：binding 冲突（`UNIQUE constraint failed:
binding.pid, binding.platform`）与 channel 冲突**同源**——`session.getUser` 也是
check-then-act，未命中走 `createUser` → `create('binding')` 撞 `(pid, platform)`
主键（即 issue #1545 的 user 侧表现）。预热：
- 先 `get('binding', { platform, pid }, ['aid'])` 命中直返；
- 未命中 → `create('user', { authority, locales: [], createdAt })` 拿 `user.id` →
  `upsert('binding', [{ aid, bid, pid, platform }], ['pid', 'platform'])` 幂等合并
  （user 表无唯一键、重复创建无害，binding 由 upsert 保证并发安全）；
- **autoAuthorize 语义**：构造时解析 `ctx.config.autoAuthorize`（函数形式默认 1）；
  `autoAuthorize=0` 时 koishi 不落库（detached user）→ 跳过预热。
- 不写 user 表 platform 列（`createUser` 依赖 login-added 迁移后才有的列；binding
  映射已足够，`getUser` 经 binding.aid 查 user，无需该列）。
- per-user 串行队列：key 前缀区分 `channel:` / `user:`（同 key 串行、异 key 并行）。

**接线**：`bot.ts` 构造时装配（`this.database`），`dispatchSession` 变 async——先
`await ensureChannel` 再 `await ensureUser` 最后 dispatch。

### 5.14 OB11 动作桥（IPC 模式整表挂载，2026-08-27）

**动机**：IPC 模式此前只挂 7 个 kernel 动作（`msg.sendMessage` 等点分域），koishi
生态里大量 OneBot 11 生态代码（`send_like` / `set_group_ban` / `get_group_msg_history`
等 79 个 snake_case 动作，含别名变体）够不着。OB11 动作容器已在 `@napuketto/adapter`
完整实现——IPC 模式把它**整表挂载**进共享 IPC 动作表，零重复实现。

**机制**（子进程侧，loader `host/ipc/ipc-ob11.ts`，装配于 `attachIpcServices` 之后）：

- 插件在 `resolveLaunchOptions` 解析 `@napuketto/adapter` / `@napuketto/network`
  磁盘入口（`resolveEntry`，同 kernelEntry 模式），经 launcher 既有的
  `adapterEntry` / `networkEntry` 选项透传 env（`NAPUTO_ADAPTER_ENTRY` /
  `NAPUTO_NETWORK_ENTRY`）。配置 `ob11Actions: false` 关闭（默认开）。
- loader IPC 分支检测到两个 env 后：动态 import adapter 的 `onebot11` / `core`
  子路径 + network 入口（assemble-protocols.ts 同款「按注入路径动态 import」，
  loader 包零静态依赖、不违反依赖方向），实例化 `NapukettoOneBot11Adapter`
  （九个 kernel api + self + groupCache + msgChannel，`ProtocolConfig` 用
  `seed=parse({})` 缺省段，不读不写任何配置文件），**只调 `subscribeOnly()`**
  （接收链路：`Msg/onRecvMsg` 维护 messageUnique + 灰色通知翻译），**不装配任何
  网络传输 / 心跳 / 生命周期广播**（无 HTTP/WS 端口）。
- 全部 OB11 动作名平铺合并进 IPC 动作表：handler = `(params) => act.handle(params)`，
  返回 OB11 标准信封 `{ status, retcode, data, message }`（zod 校验 + KernelError
  → retcode 映射在 `BaseAction.handle` 内完成，永不抛）。**动作名空间天然不冲突**：
  kernel 动作是点分命名（`msg.sendMessage`），OB11 是 snake_case（`send_like`）。
- OB11 事件经 broadcaster 挂一个仅 `send` 的桥适配器 → 现有 event 通道透出：
  `{ service: "ob11", name: <post_type>, args: [<完整 OB11 事件对象>] }`。
- **fail-soft**：入口缺失 / import 失败 → log 降级为纯 kernel 动作面，登录链路不阻断。

**调用方式**（koishi 侧，`bot.internal._request` 通用通道直通）：

```ts
// 信封语义与 OB11 HTTP/WS 完全一致
const res = await bot.internal._request("send_like", { user_id: 123456, times: 10 });
// res: { status: "ok", retcode: 0, data: null, message: "" }
const info = await bot.internal._request("get_login_info");
// info.data: { user_id, nickname }
```

**事件订阅口**（原始 OB11 事件，poke 类通知未来可用）：

```ts
bot.onOb11Event((event) => {
  // event.post_type: "message" | "notice" | "request" | "meta_event"
});
```

**已知缺口（TODO，保持原样）**：`toOb11NoticeEvent` 对 poke（戳一戳）子类型返回
null——kernel 侧探测另起对话规划；戳一戳发送/接收不在本批范围。

**明确不做**：Satori 动作面对接、koishi onebot 风格 `session.onebot.*` 驼峰兼容糖
（生态库用 `_request` 蛇形名直达，语义无损）。

## 6. 实现顺序（一个模块一个模块，每步跑 `pnpm check`）

> **设计先行**：每实现一个模块前，先在本文件补一节细节设计。

1. **IPC 协议层**（`ipc.ts`）：消息格式 + 序列化 + 请求-响应匹配 + 心跳。先定义类型，
   可独立单测。
2. **驱动层**（`driver.ts`）：spawn self-host 子进程 + IPC 生命周期（启动/就绪/崩溃/
   重启）。**前提**：loader 的 `self-host.ts` 支持子进程模式（见 §7 主仓库前置改造）。
3. **登录交互**（`login.ts`）：快速登录 / QR 展示 / 状态机，经 IPC 驱动子进程登录。
4. **事件桥**（`events.ts`）：kernel 消息事件 → koishi session 事件。**地基验证点**：
   koishi 里能收到 QQ 消息。
5. **动作桥**（`actions.ts`）：koishi 动作 → kernel API（sendMessage 打通「koishi 发消息」）。
6. **Bot 集成**（`bot.ts`）：NapukettoBot 注册为 koishi 平台，`message` 事件进 koishi 会话。
7. **收尾**：多账号、重连、错误上报、文档、测试、发布（changesets + koishi 市场）。

## 7. 主仓库前置改造（loader 去脚本化）

`self-host.ts`（loader 包）目前是**脚本式**（`process.exit` 直接退出）。子进程 IPC 方案
需要它**可编程化**，改造成本低：

- `process.exit(1)`（锁失败 / wrapper 缺失 / dlopen 失败）→ 抛类型化错误或发 IPC 错误消息
- 引导进度（dlopen / 登录 / session / ready）→ 事件回调（`onStatus`）
- 登录结果 / QR 码路径 → 事件回调

**不改的**：dlopen + stub + O3MiscService 激活 + 登录 + session 装配链路（已验证，
HANDOVER-V9 结论，勿重复探索）。

**✅ 已实现（2026-08-08，§7 落地）**：loader 新增 `src/host/ipc/`（NAPUTO_IPC=1 开启）：

| 文件 | 职责 |
|---|---|
| `ipc-types.ts` | 协议消息类型（与插件侧 src/ipc/types.ts 对齐，IPC_VERSION 校验防漂移） |
| `ipc-codec.ts` | JSON 行编解码（与插件侧 codec.ts 对齐） |
| `ipc-sender.ts` | 发送封装（status/login/qr/event/log/result/ping/pong；仅 IPC 模式写 stdout） |
| `ipc-actions.ts` | 动作表（msg.sendMessage/recallMessage/fetchMessages/markRead + group/friend 列表 + login.getSelf；**peerUin 自动转 uid**——注入 groupApi.uinToUid） |
| `ipc-server.ts` | stdin readline 收 action/control/ping；心跳 15s；control stop/restart 退出 |
| `ipc-bootstrap.ts` | 装配入口：enableIpc + 动作表 + 服务端 + 事件通道 onAny 转发 |

配套改动：
- **kernel**：`NTEventChannel.onAny`（全事件订阅，IPC 转发用）+ `CoreLoginOptions.onLoginProgress`
  （QR 阶段回调：二维码数据 + 状态机，IPC 转发用）
- **self-host.ts**：IPC 模式发 status（booting → dlopening → logging → sessioning → ready / failed）
- **protocols.ts** 重构：kernel 服务创建抽到 `kernel-services.ts`（IPC/协议共用），
  OB11/Satori 装配抽到 `assemble-protocols.ts`（非 IPC 模式零回归）
- **launcher.ts**：`LaunchOptions.ipc` → 注入 NAPUTO_IPC=1（koishi 插件 driver 复用）

**driver.ts 前提就绪**：spawn `launchSelfHost({ ..., ipc: true, stdio: ["pipe","pipe","pipe"] })`
→ stdout 收协议行（readline）→ stdin 发 action/control。非 IPC 路径（cli pnpm start）零改动。

## 8. 红线（继承主仓库）

- **零引入 NapCat 代码**（GPL-2.0-only 不兼容 MIT）：任何文件（含类型定义）不得来自 NapCat
- **kernel 唯一原生交互层**：插件不得 `process.dlopen` / 访问 wrapper.node
- **技术栈与主仓库一致**：TS7.0 + ES2025 + NodeNext + strict 全家桶 + biome 双引号
- **子进程方案**：不改成进程内 dlopen（§5.2 决策，除非用户推翻）

---

## 9. 参考项目（2026-08-08 调研）

> 两个开源参考：`koishi-plugin-adapter-napcat`（6.9.3-napcat.0，NapCat 官方适配器，
> MIT）+ `koishi-plugin-adapter-onebot`（Koishi 官方 OneBot 适配器）。两者是同一架构
> 谱系（napcat 基于 onebot 扩展），**照葫芦画瓢的核心是 koishi Bot/MessageEncoder/
> adaptSession 骨架**，但它们本质是「网络客户端」模式（HTTP/WS 连接外部服务），
> **不是**我们的「进程编排」模式（IPC 连接自建宿主）——传输层是唯一差异，骨架可借鉴。

### 9.1 可借鉴的骨架（napcat/onebot 同构）

```
src/
├── index.ts          # 入口：name/usage/Config/apply + declare module 扩展
├── bot/
│   ├── index.ts      # NapCatBot extends BaseBot（注册平台、协议选择）
│   ├── base.ts       # BaseBot extends Bot：Bot 生命周期 + internal 调用
│   ├── message.ts    # OneBotMessageEncoder extends MessageEncoder（发送）
│   ├── cqcode.ts     # CQCode 解析（消息元素 ↔ CQ 码）
│   └── qqguild.ts    # 频道 Bot（guild service，NapCat 特有）
├── http.ts           # HttpServer extends Adapter（HTTP 连接，action 请求 + 事件推送）
├── ws.ts             # WsClient / WsServer（WS 连接）
├── types.ts          # OneBot 类型定义
└── utils.ts          # adaptSession / adaptMessage / dispatchSession / Internal
```

**核心模式**：

| 模式 | 参考实现 | 我们的对应 |
|---|---|---|
| **Bot 子类** | `BaseBot extends Bot<C, T>`，`static inject = ['http']` | `NapukettoBot extends Bot`（§5.4） |
| **MessageEncoder** | `OneBotMessageEncoder extends MessageEncoder`（元素 → 协议格式） | 元素 → kernel canonical（§5.4） |
| **internal API 封装** | `bot.internal` = `Internal` 类，所有动作 `internal.getMsg()` 等 | `NapukettoInternal`：经 IPC 调 kernel API（§5.4） |
| **传输抽象** | `internal._request = async (action, params) => http.post(...)` | `internal._request = async (action, params) => ipc.request(action, params)` |
| **事件分发** | `dispatchSession(bot, payload)` → `adaptSession` → `bot.dispatch(session)` | `dispatchSession(bot, kernelEvent)` → 翻译 → `bot.dispatch`（§5.3） |
| **Session 扩展** | `declare module '@satorijs/core' { interface Session { onebot?: ... } }` | `declare module` 扩展 napuketto 事件字段 |
| **平台扩展** | `declare module 'koishi' { interface Events { 'onebot/...': ... } }` | `declare module` 扩展 koishi Events |

**关键洞察——`internal._request` 传输抽象**：napcat 把「动作调用」与「传输方式」解耦
（HTTP 时 `_request = http.post`），我们只需把 `_request` 换成 IPC 请求，**Bot/MessageEncoder/
adaptSession 骨架可几乎原样借鉴**（除元素格式：它们用 CQ 码，我们用 kernel canonical）。

### 9.2 关键差异（必须自研的部分）

| 维度 | napcat/onebot | 我们 |
|---|---|---|
| **NapCat 本体** | 独立进程（NapCat 服务，HTTP/WS） | 无独立进程——自建宿主子进程（`self-host.cjs`） |
| **传输** | HTTP POST / WS 连接（`http.ts`/`ws.ts`） | 子进程 IPC（`driver.ts`/`ipc.ts`） |
| **事件格式** | OneBot payload（`post_type`/`message_type` 等） | kernel 事件模型（NTEventChannel） |
| **消息元素** | CQ 码（`[CQ:at,qq=xxx]`） | kernel canonical 元素（text/at/face/image/voice/reply） |
| **登录** | 无（NapCat 自己登录） | 插件驱动子进程登录（快速/QR，§5.5） |
| **协议适配** | 只认 OneBot（`http.ts`/`ws.ts` 直连） | kernel 语义化 API（不依赖具体协议） |

**结论**：借鉴 **Bot/MessageEncoder/internal/adaptSession 骨架**（§9.1），自研 **driver/ipc
传输层 + kernel 事件/元素翻译**（§5.2/§5.3/§5.4）。napcat 的 `http.ts`/`ws.ts` 无参考价值
（传输完全不同），但 `bot/` + `utils.ts` 的骨架是极佳范本。

### 9.3 参考实现的细节要点（实现时对照）

1. **`adaptSession`**：payload → koishi `Session` 字段映射（`session.type/subtype/
   userId/channelId/guildId/isDirect`），私聊 `channelId = 'private:' + userId`，
   群聊 `guildId = channelId = group_id`——**会话标识映射照此模式**（§5.3 的 Peer → Session）。
2. **`adaptMessage`**：`message.id`、`elements`（CQ 码 → koishi 元素 `h()`）、`quote`
   （reply 元素取首 → `bot.getMessage` 拉引用）、`content = elements.join('')`。
3. **`dispatchSession`**：`bot.session()` → 填字段 → `session.setInternal` → `bot.dispatch`。
4. **Bot 生命周期**：`initialize()` 里 `getLogin()` → `online()`，失败 `offline(error)`
   ——koishi 平台注册的成败挂钩。
5. **`static inject`**：声明依赖（napcat 用 `['http']`、`['server']`），我们不用 network/
   http，可能不需要 inject（除非用到 koishi 内置服务）。
6. **`MessageEncoder`**：`forward()`（合并转发）、`flush()`（内容拼接）、`prepare()`
   （channel 类型补全）——发送链路的标准骨架。

