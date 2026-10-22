# 配置

配置对象是 koishi 平台 bot 配置，平台名为 `onebot`。`selfId` 是唯一必填项。

## bots 配置

```yaml
plugins:
  adapter-napuketto: {}

bots:
  # 推荐：key 带 QQ 号，天然支持多账号
  onebot:123456789:
    selfId: "123456789"

  # 单账号也可省略 key 后缀
  # onebot:
  #   selfId: "123456789"
```

每个 `bots` 配置项对应一个 `NapukettoBot` 实例、一个自建宿主子进程、一个登录会话。
`onebot:<uin>` 只是配置键命名习惯；真正决定账号的是 `selfId`。

## 配置项

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `selfId` | `string` | **必填** | 登录 QQ 号。用于数据目录隔离、快速登录目标、`user.id` 与账号一致性校验 |
| `qqPath` | `string` | 自动探测 | QQ NT 安装路径。显式给出时不做自动探测 |
| `stubDir` | `string` | loader 包内默认 | stub QQNT.dll 目录 |
| `dataDir` | `string` | kernel 自动解析 | 数据根目录。支持 `~` 与相对路径 |
| `kernelEntry` | `string` | 依赖自动解析 | `@napuketto/kernel` 入口覆盖（高级项） |
| `selfHostEntry` | `string` | loader 包内 | 自建宿主入口覆盖（高级项） |
| `adapterEntry` | `string` | 依赖自动解析 | OB11 动作桥 adapter 入口覆盖（高级项） |
| `networkEntry` | `string` | 依赖自动解析 | OB11 动作桥 network 入口覆盖（高级项） |
| `heartbeatTimeoutMs` | `number` | `45000` | 子进程心跳超时（毫秒），超时判定失联并重启 |
| `ob11Actions` | `boolean` | `true` | 是否在子进程挂载全部 OneBot 11 动作并透出 OB11 事件 |
| `logLevel` | `debug` \| `info` \| `error` \| `silent` | `debug` | 插件日志等级 |
| `restart.maxRetries` | `number` | `3` | 子进程崩溃/失联最大重启次数；`0` = 不重启 |
| `restart.backoffMs` | `number` | `1000` | 首次退避基数（毫秒） |
| `restart.backoffFactor` | `number` | `2` | 退避乘数（1s / 2s / 4s） |

`schema` 定义在 `src/config.ts`。未显式给出的可选路径类配置由 launch 在每次 spawn 时解析；
`heartbeatTimeoutMs` / `restart` / `ob11Actions` / `logLevel` 的默认值同时存在于 schema 与运行时兜底。

## 数据与账号隔离

一次 spawn 使用以下路径：

| 值 | 解析 |
| :--- | :--- |
| 数据根 `dataRoot` | `resolveDataRoot(config.dataDir)`（kernel：显式参数 > 环境变量 > 项目根 `.napuketto` > 用户目录兜底） |
| 账号目录 `cfgDir` | `<dataRoot>/<selfId>` |
| 子进程 `cwd` | `dataRoot`（避免原生层把频道库等文件写进 Koishi 工作目录） |
| 全局配置 `configPath` | `resolveConfigPath({ dataRoot })`（`NAPKETTO_CONFIG` > 项目根探测 > 数据根兜底） |
| QQ 文件（Linux） | `ensureQqFiles({ dataRoot })`，缺失时自动下载到数据根 |

因此 `selfId` 不只是登录账号，也是账号数据边界。登录成其他 QQ 号会被判定为账号不一致并拒绝上线
（见 [生命周期](../architecture/lifecycle.md#就绪处理与账号一致性)）。

## QQ 安装

- **Windows**：缺省 `resolveQqInstall()` 自动探测本机 QQ NT；显式 `qqPath` 时直接使用。
- **Linux / WSL / Wine**：缺省 `ensureQqFiles()` 把 QQ 文件准备到数据根（ext4），首次会下载并解包；
  `onStage` 日志会显示下载/校验/解包/win-node/spawn 阶段。没有 wine 时 loader 会给出可读错误。
- WSL 下不要让 `qqPath` 指向 `/mnt/c`（DrvFS）：wine 读取会 `File not found`，导致 dlopen 失败。

## 登录

1. 子进程按 `selfId` 尝试历史票据快速登录。
2. 快速登录失败自动回退二维码登录。
3. 安装并启用 `@koishijs/plugin-console` 后，插件详情页显示实时二维码与状态，可重新登录、强制扫码、
   刷新二维码。
4. 未启用控制台时，登录仍会进行；二维码只保存在插件的登录快照中，没有展示入口。

`selfId` 同时作为 `quickUin` 传给子进程；强制扫码会跳过快速登录（一次性 `NAPUTO_QR_ONLY`）。

## 日志等级

`logLevel` 通过 reggol 设置 bot logger 的等级（debug=3 / info=2 / error=1 / silent=0）：

- 子进程 `log` 转发、driver 状态、事件转发等都是 debug 级；默认 `debug` 便于排查。
- 消息派发日志是 info 级；调成 `info` 可保留消息日志但关闭高频事件日志。
- 控制台 provider 的 `get()` / `update()` 诊断也是 debug 级，使用同一个 bot logger，因此 `logLevel`
  对它同样生效。

## 多账号

- 每个账号一个 `bots` 项、一个子进程；driver、登录状态、IPC client 完全独立。
- 控制台 serviceId 为 `napuketto-login-<uin>`，面板按当前插件配置的 `selfId` 读取对应 store。
- 控制台前端入口是模块级去重的：多个账号只注册一次 entry，但每个账号各有一个 provider。
- 账号之间不共享 `cfgDir`；不要把不同 `selfId` 指向同一账号目录。

## 运行环境

- Koishi `^4.18.7`。
- `@koishijs/plugin-console` `^5.30.11`（peer，可选启用；面板依赖它）。
- CI 使用 Node 24 + pnpm 12.4.1；仓库未声明 `engines`，以 CI 版本为验证基线。
- QQ NT 客户端：Windows 原生；Linux 通过 WSL/Wine 运行，QQ 文件由 loader 准备。
