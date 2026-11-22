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

## 出站媒体策略

- `remoteMediaPolicy: compatible`（默认）允许本机和 LAN 媒体服务，逐跳拒绝链路本地等特殊字面地址。
  保持这项配置的部署通常使用受信任的媒体 URL，并可用网络出口规则约束域名、代理及内网访问。
- `remoteMediaPolicy: public-only` 逐跳只允许公网目标，验证实际连接使用的地址，
  并保留 HTTPS 证书验证。`@napuketto/media` 从 0.2.3 起提供该下载入口，远程下载失败时回退为占位文本。
- `localFilePolicy: legacy`（默认）保留部署现有的本地媒体路径和 `file://` 用法。
  向低信任调用者提供标准发送时，使用 `allowlist` 和 `public-only`。空 `localMediaRoots` 拒绝所有调用方本地路径，
  仍可使用有效的 HTTP(S) 和 data URL。动作入口的授权见 [动作桥](../internals/actions.md#动作入口与调用方)。
- 受信任本地媒体用 `localMediaRoots` 显式列出专用导出目录，例如 Windows 的
  `D:/koishi/media` 或 Linux 的 `/srv/koishi/media`。相对根和相对媒体路径以 Koishi 工作目录解析。
  白名单解析链接后核对文件身份，再从已打开的句柄复制到 Koishi 的临时目录。多硬链接的文件会被拒绝。
  临时目录须由运行 Koishi 的账户控制。将配置根及其上级目录的重命名和重定向权限留给受信任进程。
  Linux 还通过 `/proc/self/fd` 核对已打开句柄的路径。Windows 使用路径复核和文件身份比对，须通过 ACL
  防止低信任主体重定向白名单中的子目录。迁移时核对导出目录、文件权限与媒体大小上限。


## 配置项

控制台把 QQ 号和日志等级放在「基础设置」。适配器的控制台入口加载后，「功能与媒体策略」
「进程保活与重启」和「运行环境与路径」默认折叠，点击各组标题展开。切换本地媒体策略到白名单模式时
可编辑目录列表。入站图片自动下载补丁可选「自动」「强制开启」或「强制关闭」，其中「自动」对应 YAML
省略 `nativeMediaPatch`。
包入口覆盖可在 YAML 中填写，控制台表单隐藏这些字段。

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `selfId` | `string` | **必填** | 登录 QQ 号，须为 5–11 位 ASCII 数字组成的字符串。用于数据目录隔离、快速登录目标、`user.id` 与账号一致性校验 |
| `qqPath` | `string` | 自动探测 | 指向 QQ 可执行文件，安装目录含 `versions/`。显式给出时优先使用 |
| `stubDir` | `string` | loader 包内默认 | Windows 的 stub `QQNT.dll` 目录 |
| `linuxStubPath` | `string` | loader 包内默认 | Linux 的 ELF stub `.so` 文件路径 |
| `winNodePath` | `string` | loader 自动解析 | Windows 上 Koishi 运行于非标准 Node 宿主时指定 `node.exe` |
| `nativeMediaPatch` | `boolean` | loader 默认开启 | 入站图片自动下载补丁。省略时遵循 loader 环境开关，显式值优先 |
| `dataDir` | `string` | kernel 自动解析 | 数据根目录。支持 `~` 与相对路径 |
| `kernelEntry` | `string` | 依赖自动解析 | `@napuketto/kernel` 入口覆盖（高级项） |
| `selfHostEntry` | `string` | loader 包内 | 自建宿主入口覆盖（高级项） |
| `adapterEntry` | `string` | 依赖自动解析 | OB11 动作桥 adapter 入口覆盖（高级项） |
| `networkEntry` | `string` | 依赖自动解析 | OB11 动作桥 network 入口覆盖（高级项） |
| `heartbeatTimeoutMs` | `number` | `45000` | 子进程心跳超时（毫秒），超时判定失联并重启。至少 5000，步进 1000 |
| `ob11Actions` | `boolean` | `true` | 是否挂载 OneBot 11 动作、原始订阅和标准成员变动 / 请求事件。消息与撤回仍通过 kernel IPC 提供 |
| `remoteMediaPolicy` | `compatible` \| `public-only` | `compatible` | 出站 HTTP(S) 媒体下载策略 |
| `localFilePolicy` | `legacy` \| `allowlist` | `legacy` | 出站本地媒体路径策略 |
| `localMediaRoots` | `string[]` | `[]` | 本地媒体白名单目录，供 `allowlist` 使用 |
| `logLevel` | `debug` \| `info` \| `error` \| `silent` | `info` | 当前账号的 Bot 日志等级 |
| `restart.maxRetries` | `number` | `3` | 子进程崩溃或失联时的最大重启次数，取 0 到 20 的整数，`0` 表示不重启 |
| `restart.backoffMs` | `number` | `1000` | 首次退避基数（毫秒），至少 100，步进 100 |
| `restart.backoffFactor` | `number` | `2` | 退避倍率，取 1 到 10，步进 0.5 |

`schema` 定义在 `src/config.ts`。未显式给出的可选路径类配置由 launch 在每次 spawn 时解析；
`heartbeatTimeoutMs` / `restart` / `ob11Actions` / `logLevel` 的默认值同时存在于 schema 与运行时兜底。

可选路径项（`qqPath` / `stubDir` / `linuxStubPath` / `winNodePath` / `dataDir` / 入口覆盖等）
按以下契约归一化：空串或纯空白视为未配置，不会解析成当前工作目录；合法的相对路径按 Koishi
工作目录展开，显式覆盖优先；路径存在时校验期望类型（`stubDir` / `dataDir` 为目录，
`qqPath` / `linuxStubPath` / `winNodePath` / `selfHostEntry` / 入口覆盖为文件）。类型不符会以
配置项名报错，不输出完整路径。OB11 入口解析失败只降级并记录配置项，不阻断启动。

## 数据与账号隔离

一次 spawn 使用以下路径：

| 值 | 解析 |
| :--- | :--- |
| 数据根 `dataRoot` | `resolveDataRoot(config.dataDir)`（kernel：显式参数 > 环境变量 > 项目根 `.napuketto` > 用户目录兜底） |
| 账号目录（driver `accountDir`、loader `cfgDir`） | `<dataRoot>/<selfId>`，为数据根的直属子目录 |
| 子进程 `cwd` | `dataRoot`（避免原生层把频道库等文件写进 Koishi 工作目录） |
| 全局配置 `configPath` | `resolveConfigPath({ dataRoot })`（`NAPKETTO_CONFIG` > 项目根探测 > 数据根兜底） |
| 子进程 `NAPUKETTO_DATA_ROOT` | 同一个 `dataRoot`，用于 Linux 的 QQ 数据及入站相对语音路径 |
| QQ 文件（Linux） | 优先复用本机安装或数据根缓存，缺失时下载官方 Linux 包 |

配置和运行时使用同一 `selfId` 格式规则。空值、空白与路径形式会在计算账号目录及探测或下载 QQ 前被拒绝。
YAML 中请给 QQ 号加引号以保留字符串原值。登录成其他 QQ 号会被判定为账号不一致并拒绝上线
（见 [生命周期](../architecture/lifecycle.md#就绪处理与账号一致性)）。

## QQ 安装

- **Windows**：缺省 `resolveQqInstall()` 自动探测本机 QQ NT；显式 `qqPath` 时直接使用。
- **Linux / WSL**：使用标准 Linux Node 和 ELF stub。loader 探测 `/opt/QQ`，也可通过 `NAPUTO_QQ_DIR` 指定官方 deb 的其他安装目录。缺失时复用数据根缓存或下载并解包，阶段日志显示进度。
- Linux / WSL 直接运行原生 ELF 宿主，无需 Wine。WSL 使用 Linux 版 QQ 文件及 Linux 文件系统上的数据目录。

## 登录

1. 子进程按 `selfId` 尝试历史票据快速登录。
2. 快速登录失败自动回退二维码登录。
3. 安装并启用 `@koishijs/plugin-console` 后，插件详情页显示实时二维码与状态，可重新登录、强制扫码、
   刷新二维码。
4. 未启用控制台时，登录仍会进行；二维码只保存在插件的登录快照中，没有展示入口。

`selfId` 同时作为 `quickUin` 传给子进程；强制扫码会跳过快速登录（一次性 `NAPUKETTO_QR_ONLY`）。

## 日志等级

`logLevel` 按 `selfId` 设置对应的 Koishi/reggol logger `onebot-<selfId>`，不同账号可独立设置。
等级为 debug=3 / info=2 / error=1 / silent=0。

- 子进程 `log` 转发、driver 状态、事件转发等使用 `debug` 级，排查时可显式开启。
- 默认 `info` 保留消息派发日志、警告和错误。
- 登录面板、控制台 provider 和收发媒体都通过对应账号的 Bot logger 将日志交给 Koishi。

## 多账号

- 每个账号一个 `bots` 项、一个子进程；driver、登录状态、IPC client 完全独立。
- 控制台 serviceId 为 `napuketto-login-<uin>`，面板按当前插件配置的 `selfId` 读取对应 store。
- 控制台前端入口是模块级去重的：多个账号只注册一次 entry，但每个账号各有一个 provider。
- 账号之间不共享 `cfgDir`；不要把不同 `selfId` 指向同一账号目录。

## 运行环境

- Koishi `^4.18.11`。
- `@koishijs/plugin-console` `^5.30.11`（peer，可选启用；面板依赖它）。
- Node.js ≥ 22.12，CI 使用 Node 24 和 pnpm 12.4.1。
- Windows 使用 PE stub `QQNT.dll`。Linux / WSL 使用 Linux 版 QQ 和 ELF stub，需要系统提供 `libgnutls.so.30`。loader 随包提供 x64 stub，其他架构须提供兼容的 `linuxStubPath`。语音转码需要 FFmpeg。
