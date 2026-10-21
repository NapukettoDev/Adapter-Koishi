# koishi-plugin-adapter-napuketto

[![npm](https://img.shields.io/npm/v/koishi-plugin-adapter-napuketto?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-adapter-napuketto)
[![koishi](https://img.shields.io/badge/koishi-%5E4.18.7-4a6ee0?style=flat-square)](https://koishi.chat)
[![license](https://img.shields.io/badge/license-MIT-green?style=flat-square)](./LICENSE)

[NapukettoQQ](https://github.com/NapukettoDev/NapukettoQQ) 的 Koishi 适配器：让 Koishi 直接驱动 QQ。

它基于**自研的 QQ NT `wrapper.node` 协议层**工作——**无需 NapCat、无需 WebUI、无需独立协议端**。
每个 bot 在 Koishi 里就是一个「平台」，插件自动编排一个自建宿主子进程完成加载、登录、收发消息，
你只需要在配置里填一个 QQ 号。

## 特性

- 🚫 **零 NapCat 依赖**：自研 `wrapper.node` 协议层（MIT 许可证，无 GPL 污染），功能对齐 NapCat 的协议 + API 能力
- 🧩 **子进程隔离**：每个账号一个自建宿主子进程，原生层崩溃自动重启，不拖垮 Koishi 主进程
- 💬 **完整事件桥**：群聊 / 私聊 / 临时会话消息 → Koishi session，结构化元素映射（文本 / @ / 图片 / 表情 / 语音 / 引用）
- 🔧 **完整动作桥**：发送消息、撤回、消息历史、好友列表、群列表、登录信息等 Koishi 标准动作
- 📱 **控制台扫码登录面板**：二维码实时展示、刷新、重新登录，登录状态实时推送（需安装 `@koishijs/plugin-console`）
- ⚡ **快速登录优先**：历史票据快速登录，失败自动回落二维码登录
- 👥 **多账号天然支持**：每个 bot 一个子进程，账号状态互不污染
- 💓 **心跳健康检查 + 指数退避**：子进程失联自动重启，可按需配置

## 环境要求

- [Koishi](https://koishi.chat) `^4.18.7`
- 已安装 **QQ NT 客户端**（Windows；Linux 走 WSL / Wine 亦已适配）
- 无需 NapCat，无需手动启动 NapukettoQQ 进程（子进程由插件自动编排）

## 安装

在 Koishi 控制台的「插件市场」搜索 **`adapter-napuketto`** 安装，或手动安装：

```bash
npm install koishi-plugin-adapter-napuketto
```

> 依赖 `@napuketto/kernel` 与 `@napuketto/loader` 会随包自动安装，子进程所需的磁盘资产
> （自建宿主入口、stub QQNT.dll 等）一并提供，无需额外配置。

## 配置

本插件无需插件级配置（配置留空即可），实际配置挂在 **bots** 上——平台名为 `onebot`：

```yaml
plugins:
  adapter-napuketto: {}

bots:
  # 方式一：显式指定 QQ 号（推荐）
  onebot:3567141148:
    selfId: "3567141148"
  # 方式二：省略 selfId 的 key（仅单账号时可用）
  onebot:
    selfId: "3567141148"
```

`selfId` 为**必填项**（登录 QQ 号，同时用于数据目录账号隔离与快速登录）。其余配置项：

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `selfId` | string | **必填** | 登录 QQ 号 |
| `qqPath` | string | 自动探测 | QQ 安装路径 |
| `stubDir` | string | 包内默认 | stub QQNT.dll 目录 |
| `dataDir` | string | 自动解析 | 数据根目录 |
| `kernelEntry` | string | 自动解析 | kernel 入口覆盖（高级） |
| `selfHostEntry` | string | 包内默认 | 自建宿主入口覆盖（高级） |
| `heartbeatTimeoutMs` | number | `45000` | 子进程心跳超时（毫秒） |
| `logLevel` | string | `debug` | 日志等级：`debug` / `info` / `error` / `silent` |
| `restart.maxRetries` | number | `3` | 崩溃重启最大次数（0 = 不重启） |
| `restart.backoffMs` | number | `1000` | 首次退避基数（毫秒） |
| `restart.backoffFactor` | number | `2` | 退避因子 |

## 使用

启动 Koishi 后，插件会为每个 bot 拉起一个自建宿主子进程并尝试**快速登录**；快速登录失败时
自动进入**二维码登录**——安装 `@koishijs/plugin-console` 后，二维码会实时显示在「插件详情页」
的登录面板上，扫码成功后状态即时更新。登录面板同时提供「刷新二维码」与「重新登录」操作。

登录成功后即可像使用其他 Koishi 适配器一样收发消息：

```ts
ctx.on('message', (session) => {
  if (session.content === 'ping') {
    return session.send('pong')
  }
})
```

## 工作原理

```
┌────────────── Koishi 主进程 ──────────────┐
│  NapukettoBot（平台 napuketto）            │
│  ├─ NapukettoDriver（子进程生命周期/重启）  │
│  ├─ 事件桥：kernel 事件 → Koishi session   │
│  └─ 动作桥：Koishi 动作 → IPC 请求         │
└───────────────┬──────────────────────────┘
                │ IPC（stdin/stdout JSON 行协议）
┌───────────────▼──────────────────────────┐
│  自建宿主子进程（每账号一个）              │
│  @napuketto/loader self-host.cjs          │
│  ├─ dlopen wrapper.node（stub QQNT.dll）  │
│  ├─ 登录（快速 / 二维码）→ session READY   │
│  └─ kernel API 调用                       │
└───────────────────────────────────────────┘
```

关键设计：**子进程 + IPC**——QQ 原生层的不稳定因素（崩溃 / 卡死）被隔离在子进程内，
由 driver 的心跳检测与指数退避策略自动拉起，Koishi 主进程始终无恙。

## 开发

本仓库独立维护（独立 GitHub 仓 + 独立 lockfile/CI），直接依赖 npm 上**已发布**的
`@napuketto/*`——不再作为主仓库的 git submodule，也不进主仓库 pnpm workspace：

```bash
pnpm install
pnpm check          # biome + tsc（src 与 client 两个 tsconfig）
pnpm test           # vitest（src/**/__tests__）
pnpm build          # tsdown 构建 CJS 产物
pnpm build:client   # 构建控制台前端
```

> `pnpm lint:client`（eslint 检查 `.vue`）当前跑不了：`@typescript-eslint/parser` 对
> TS 7 有硬 guard（`typescript-eslint does not support TS 7.0`），主仓同样受影响。
> 因此 `check` 暂不含 eslint，等上游支持 TS7 后再接回。

- **发布形态**：`lib/index.cjs`（CJS bundle），运行时仅依赖 koishi（peer）
- **开发免构建**：`exports.development` 条件（`NODE_ENV=development` 直载 `src/index.ts`）
- **本地联调未发布的 `@napuketto/*`**：在主仓库 `pnpm pack` 出 tarball 后
  `pnpm add file:<tarball>`（或用 changesets 的 prerelease 版本），验证完再换回 registry
  版本。不要用 workspace link——那样测的是源码而不是发布形态。

## 许可证

[MIT](./LICENSE)

