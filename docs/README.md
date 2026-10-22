# koishi-plugin-adapter-napuketto 文档

本目录是 `koishi-plugin-adapter-napuketto` 的技术文档来源。文档描述**当前代码的实际行为**，
不记录施工进度、历史交接或未落地的设计草案。

## 文档原则

- **代码即事实**：行为以 `src/`、`client/` 与配置文件为准；代码变了而文档没变视为缺陷。
- **单篇单主题**：每篇只回答一类问题，跨篇用链接而不是复制。
- **只写现行机制**：不写已废弃方案、提交记录、日期化的联调日志与待办清单。
- **保留"为什么"**：只保留理解防线/约束所必需的根因说明（例如账号一致性、并发落库）。

## 阅读路径

| 角色 | 建议顺序 |
| :--- | :--- |
| 使用者 | [configuration](guides/configuration.md) → [troubleshooting](guides/troubleshooting.md) |
| 二次开发 | [overview](architecture/overview.md) → [lifecycle](architecture/lifecycle.md) → [runtime](internals/runtime.md) → [events](internals/events.md) / [actions](internals/actions.md) → [bot](internals/bot.md) / [console](internals/console.md) |
| 维护 / 发布 | [development](guides/development.md) → [release](operations/release.md) |

## 文档地图

| 文档 | 内容 | 主要对应代码 |
| :--- | :--- | :--- |
| [architecture/overview.md](architecture/overview.md) | 定位、边界、依赖方向、目录结构、关键决策、能力边界 | `package.json`、`src/index.ts` |
| [architecture/lifecycle.md](architecture/lifecycle.md) | 从 Bot 构造到上下线：driver 状态、登录状态、就绪/重启/停止、账号一致性、重登决策 | `src/bot/bot.ts`、`src/bot/login-actions.ts`、`src/driver/`、`src/login/` |
| [internals/runtime.md](internals/runtime.md) | 子进程编排与 IPC：launch 组装、driver、心跳、退避、JSON 行协议、请求匹配 | `src/driver/`、`src/ipc/`、`src/bot/launch.ts` |
| [internals/events.md](internals/events.md) | 收方向：kernel 事件 → koishi session，元素映射，收向语音解码，OB11 原始事件 | `src/events/` |
| [internals/actions.md](internals/actions.md) | 发方向：koishi 动作 → canonical → IPC，媒体归一化，kernel/OB11 两个动作面 | `src/actions/` |
| [internals/bot.md](internals/bot.md) | `NapukettoBot` 装配、生命周期钩子、动作方法、dispatch 链路、数据库预热、MessageEncoder | `src/bot/`、`src/database/` |
| [internals/console.md](internals/console.md) | 控制台登录面板：DataService、面板装配、前端入口与 403 防护、扫码交互 | `src/console/`、`client/` |
| [guides/configuration.md](guides/configuration.md) | `bots` 配置、全部配置项与默认值、数据目录、登录方式、多账号 | `src/config.ts` |
| [guides/development.md](guides/development.md) | 环境、命令、产物与依赖形态、检查与测试边界、代码约定、扩展步骤 | `package.json`、`tsdown.config.ts`、`vite.config.client.ts` |
| [guides/troubleshooting.md](guides/troubleshooting.md) | 按现象排查：不上线、无响应、面板/二维码、媒体、子进程退出、日志 | 全仓 |
| [operations/release.md](operations/release.md) | 版本发布：CI 三阶段、OIDC 信任配置、规则集、排障 | `.github/workflows/` |

## 不在本目录的内容

- 版本变更记录：[CHANGELOG.md](../CHANGELOG.md)。
- 安装与项目介绍：[readme.md](../readme.md)。
- 上游包（`@napuketto/kernel`、`@napuketto/loader`、`@napuketto/media`、`@napuketto/adapter`）
  的内部实现：见各自仓库文档；本目录只描述适配器如何消费它们。

## 维护约定

1. 改动影响行为时，在同一个 PR 内更新对应文档；不确定归属时优先更新 `architecture/` 下的总览。
2. 新增文档前先确认能否并入现有主题；禁止为单条注意事项新建文件。
3. 文档内路径一律相对**仓库根**书写（如 `src/bot/bot.ts`），跨文档链接使用相对链接。
4. 不写"第 N 步""下一轮""待办"这类流程状态；未实现的能力写进"能力边界"并注明当前表现。
