# 架构总览

## 定位

`koishi-plugin-adapter-napuketto` 是 NapukettoQQ 的 Koishi 适配器。它把 NapukettoQQ 自研的
QQ NT `wrapper.node` 协议层嵌进 Koishi：Koishi 直接驱动 QQ，不需要 NapCat 之类的外部协议端，
不需要独立的 WebUI，也不需要额外端口。

插件本身不接触 `wrapper.node`。每个 QQ 账号由一个自建宿主子进程负责原生层（dlopen、
`O3MiscService`、登录、session 装配），插件只负责进程编排与两端语义翻译。

## 边界

| 做 | 不做 |
| :--- | :--- |
| koishi 插件壳：平台注册、配置 schema、Bot 生命周期 | 不直接 `dlopen` / 访问 `wrapper.node`（kernel 是唯一的原生交互层） |
| 自建宿主子进程的启动、就绪、心跳、崩溃重启、停止 | 不做 QQ 协议语义解析（`@napuketto/adapter` 负责） |
| kernel 事件 → koishi session 的翻译与派发 | 不做媒体编解码实现（`@napuketto/media` 负责） |
| koishi 动作 → kernel / OneBot 11 动作的调用 | 不提供 HTTP / WebSocket 服务，不监听网络端口 |

## 运行时拓扑

```
Koishi 主进程（Node）
└─ NapukettoBot × N（每个 bots 配置项一个）
   ├─ NapukettoDriver ── spawn ──▶ 自建宿主子进程（每账号一个）
   │                              self-host.cjs → dlopen wrapper.node
   │                              → 登录 → session → kernel services READY
   ├─ NapukettoIpcClient ◀──────▶ stdin/stdout：JSON 行协议（v1）
   ├─ 事件桥：kernel event → koishi session → bot.dispatch
   ├─ 动作桥：koishi 动作 → IPC action → kernel API / OB11
   ├─ 登录状态机 + 控制台面板（可选）
   └─ 数据库预热（可选）
```

**关键决策：子进程 IPC，而不是进程内 dlopen。** 理由：

1. **稳定性隔离**：原生层崩溃、卡死只影响子进程；driver 按策略重启，Koishi 主进程不受影响。
2. **复用现有引导链**：`@napuketto/loader` 的 `launchSelfHost` + `self-host.cjs` 已是完整链路
   （stub QQNT.dll、下载/解包、wine 分支、登录、session、协议装配），子进程方案直接复用。
3. **多账号同构**：每个 bot 一个子进程，状态、数据目录、IPC 通道互不污染。

代价是事件与动作要过一层 JSON 序列化，并需要心跳/状态重同步来处理子进程静默或协议行损坏。

## 依赖方向

| 包 | 角色 | 使用位置 |
| :--- | :--- | :--- |
| `koishi`（peer） | Bot / MessageEncoder / Schema / Universal 类型 | `src/bot/`、`src/config.ts`、`src/index.ts` |
| `@koishijs/plugin-console`（peer） | `DataService` 与控制台前端运行时 | `src/console/provider.ts`、`client/` |
| `@napuketto/kernel` | 数据根/配置路径解析、`RawMessage` / `CanonicalElement`、`LoginState` / `QrCodeData`、`KernelError`、`toCanonicalElements` | `src/bot/launch.ts`、`src/events/`、`src/actions/`、`src/ipc/transport.ts` |
| `@napuketto/loader` | `launchSelfHost`、QQ 文件解析、stub 目录、IPC 消息 schema、原生噪音过滤 | `src/bot/launch.ts`、`src/ipc/` |
| `@napuketto/media` | silk 编解码、视频信息/抽帧 | `src/actions/media.ts`、`src/events/voice-decode.ts` |
| `@napuketto/adapter` / `@napuketto/network` | **不在插件源码中 import**；仅把磁盘入口路径传给子进程，由 loader 在子进程内动态装配 OneBot 11 动作面 | `src/bot/launch.ts`（`resolveEntry`） |

依赖方向单向：插件 → 上游包；上游包不知道适配器存在。`@napuketto/*` 是真实 `dependencies`
（构建时 external，不打包），因为子进程运行时要读磁盘上的 `self-host.cjs`、stub DLL 和 kernel 入口。

## 目录结构

```
src/
├── index.ts                 插件入口：默认导出 NapukettoBot，导出 Config
├── config.ts                Config 接口 + koishi Schema
├── constants.ts             PRIVATE_PREFIX / BOT_STATUS
├── bot/                     Koishi Bot 集成
│   ├── bot.ts               NapukettoBot（平台注册、生命周期、动作方法、dispatch）
│   ├── message.ts           NapukettoMessageEncoder（发送编码器）
│   ├── launch.ts            launch 工厂（launchSelfHost 组装 + 入口解析）
│   ├── login-actions.ts     重登/强制扫码决策纯函数
│   ├── login-panel.ts       控制台面板装配类
│   └── utils/
│       ├── assembly.ts      构造期组件工厂（login/panel/bridge/internal/策略）
│       ├── driver-events.ts driver 事件接线工厂
│       ├── identity.ts      账号一致性判定与拒绝动作
│       ├── session.ts       session 字段应用纯函数
│       ├── transform.ts     kernel → Universal 形状映射
│       └── console-entry.ts 控制台前端入口注册
├── driver/                  子进程生命周期
│   ├── driver.ts            NapukettoDriver（spawn/重启/停止/状态重查）
│   ├── heartbeat.ts         HeartbeatMonitor
│   ├── backoff.ts           指数退避纯函数
│   ├── types.ts             DriverOptions / DriverEvents / DriverState 等
│   └── test-utils.ts        FakeChild + createHarness
├── ipc/                     JSON 行协议（插件侧）
│   ├── client.ts            NapukettoIpcClient（线路处理/请求匹配/心跳）
│   ├── transport.ts         IpcLineTransport + ChildProcessIpcTransport
│   ├── pending.ts           PendingRequests（id/超时/批量 reject）
│   ├── subscribers.ts       SubscriberSet
│   ├── codec.ts             encode/decode（zod 校验）
│   └── errors.ts            IpcError
├── login/                   登录状态观察
│   ├── machine.ts           NapukettoLoginState
│   └── types.ts             LoginView / LoginSnapshot
├── events/                  收方向（QQ → Koishi）
│   ├── bridge.ts            NapukettoEventBridge
│   ├── adapt.ts             RawMessage → session 字段
│   ├── elements.ts          canonical → koishi 元素
│   ├── voice-decode.ts      silk → WAV
│   └── types.ts             NapukettoSessionFields / EventBridgeOptions
├── actions/                 发方向（Koishi → QQ）
│   ├── internal.ts          NapukettoInternal（bot.internal）
│   ├── elements.ts          koishi 元素 → canonical
│   ├── channel.ts           channelId → chatType/peerUin
│   ├── media.ts             语音/图片/视频发送归一化
│   └── types.ts             RequestFn / PeerTarget
├── console/                 控制台面板后端
│   ├── provider.ts          NapukettoLoginProvider（DataService）
│   ├── payload.ts           快照 → payload 纯函数
│   └── types.ts             LoginPanelPayload
└── database/                channel/user 预热
    ├── index.ts             NapukettoDatabase
    └── serial-queue.ts      per-key 串行队列

client/                      控制台前端（由 @koishijs/client 编译）
├── index.ts                 plugin-details slot 注册
├── settings.vue             面板状态分发与共享状态
├── components/              QrCodePanel / StatusSection
└── types/                   @koishijs/client 类型 shim
```

## 发布形态

- 源码：ESM + NodeNext + `verbatimModuleSyntax`；产物：`lib/index.cjs`（CJS）与 `lib/index.d.cts`。
- `tsdown` 配置 `deps.bundle: false`：`@napuketto/*` 与 koishi 生态全部保持 external，由 npm
  安装的真实包提供。**不是**单文件自包含 bundle。
- 控制台前端单独构建为 `dist/index.js` + `dist/index.css`，文件名固定，运行时由
  `src/bot/utils/console-entry.ts` 注册。
- `package.json` 的 `files` 只发布 `lib`、`client`、`dist`；`exports.development` 指向的
  `src/` 不在发布内容中，因此该条件只对仓库内开发有效。

## 能力边界

- Koishi 侧只翻译**消息事件**（`Msg/onRecvMsg`）。群通知、加群/加好友请求不会变成 koishi 的
  `notice` / `request` 事件；需要原始 OneBot 11 事件时用 `bot.onOb11()` 订阅（默认开启 OB11 动作桥）。
- 消息元素在收方向支持 `text` / `at` / `image` / `face` / `voice` / `reply`，发送方向额外支持
  `video`（补缩略图/宽高/时长）。其他类型（file、forward、json、xml、unknown）在收方向降级为
  `[type]` 占位文本。
- 不提供 Satori 动作面，也不提供 `session.onebot.*` 驼峰兼容糖；OB11 生态通过
  `bot.internal._request()` 直接用 snake_case 动作名调用。
- 媒体能力依赖 `@napuketto/media` 及其外部工具（ffmpeg/ffprobe）：语音发送前转 silk，
  收语音解码为 WAV；视频缩略图/时长生成失败时降级发送。

继续阅读：[生命周期](lifecycle.md) 了解启动到上线的完整时序，或直接看
[子进程运行时](../internals/runtime.md)。
