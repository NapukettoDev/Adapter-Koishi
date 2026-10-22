# 排障

排查前先把 `logLevel` 设为 `debug`（默认值），并确认看的是**当前账号**的日志。

## 快速定位

| 现象 | 先看 |
| :--- | :--- |
| Bot 未上线 | `[napuketto] 引导阶段:` 日志；`[W] 驱动错误`；子进程 stderr（`[napuketto 子进程]` 前缀） |
| 上线但指令无响应 | `[napuketto] dispatch:` 日志；账号一致性错误；`channel.assignee` |
| 能收不能发 | ready 是否到达；`IPC 收到无法解析的行`；状态重查日志 |
| 控制台无面板/无二维码 | 浏览器 F12 Network 的 `@plugin-` 请求；控制台是否启用 |
| 媒体发送失败 | 发送侧 warn（下载/视频）；`msg.sendMessage` 的错误码 |

## Bot 不上线

1. `start()` 之后先看 boot phase。正常序列是
   `booting → dlopening → logging → sessioning → ready`；停在某一步说明卡在该阶段。
2. 看子进程 stderr：`ChildProcessIpcTransport` 会把子进程 stderr 以
   `[napuketto 子进程] <原始行>` 转发到父进程，wine/Node 的启动错误在这里。
3. `failed` 且带 `重启次数达上限`：driver 已用尽 `restart.maxRetries`。先修根因（QQ 文件、wine、
   路径），再重启 Koishi；调大重试次数只会延长失败时间。
4. Linux/WSL 常见根因：
   - 未安装 wine → loader 预检会抛可读错误；
   - `qqPath` 指向 `/mnt/c` → wine 读 DrvFS 失败；改用数据根下的 QQ 文件或 ext4 路径；
   - 首次启动需要下载/解包 QQ 文件，观察 `onStage` 日志确认进度。
5. `spawn ENOENT` / 命令缺失：检查 `qqPath`、`stubDir`、`kernelEntry`、`selfHostEntry` 覆盖值是否
   指向真实存在的文件/目录。

## 上线但消息/指令无响应

### 账号不一致（优先检查）

日志出现“账号不一致：配置 selfId=…，实际登录 uin=…”时，插件会**主动拒绝上线**并停止 driver。
原因：数据目录按配置 `selfId` 隔离，而 koishi 的 `channel.assignee` / `binding` 会按实际 uin 落库；
错账号运行后，正确账号的群消息会被受理人闸门静默丢弃。

处理：

1. 把插件配置 `selfId` 改成实际登录的 QQ 号，或
2. 用配置的 QQ 号重新扫码登录。
3. 如果曾在错误账号下运行过，检查已有 `channel.assignee` 是否被写成错误 uin。已存在的行不会因
   `autoAssign` 自动修复。

### 消息到了但指令不触发

看 `[napuketto] dispatch:` 日志：

- `type=message`、`subtype=group|private`、`isDirect` 是否符合场景；
- `msg=` 后是否是纯文本。若显示成 `<text>…</text>` 或为空，说明元素转换异常；
- 群聊里 `@机器人` 是否真的成为 `at` 元素（`content` 里的 @ 文本不会被 koishi 当作提及）。

## 子进程反复退出 / 失联

- 心跳 45s 收不到任何消息会 kill 并重启。子进程每 15s 发 `ping`；如果连 ping 都没有，通常是原生层
  卡死（dlopen/登录），看 boot 停在哪一步。
- 子进程退出后 driver 会退避重启（1s / 2s / 4s）；每次 `onExit` 都会把 Bot 置 offline，就绪后重新
  online。
- 主动 `stop()` 最多等 5s，超时会 `kill()`；如果子进程清理很慢，日志里会先看到连接关闭。
- `IPC 收到无法解析的行（可能被并发输出撕裂）`：原生层直写 stdout 可能污染协议行。偶发可忽略；
  若伴随 ready 丢失，driver 会自动 `control status` 重查。

## “能收不能发”

事件的派发不依赖 driver 的 `ready` 状态，但动作请求依赖 IPC client 已就绪：

1. 确认状态机真的到了 `ready`（日志 `引导阶段: ready`）。若 ready 行丢失，driver 在收到 event 时会
   自动重查；booting 期间也每 20s 查一次。
2. 若日志显示 ready，但发送报“子进程未就绪”，检查是否在上一次 client 上调用动作。动作桥通过
   `clientRef` 取当前 client，正常会在每次 `onReady` 更新。
3. 发送报“未知动作”: 子进程动作表尚未合并（登录未完成或已降级），或动作名拼错。kernel 动作是点分
   命名，OB11 动作是 snake_case。

## 控制台面板

### 面板完全不出现

1. 确认安装了 `@koishijs/plugin-console` 并启用。面板通过 `ctx.inject(["console"])` 装配，未启用时
   回调不触发，插件其余功能正常。
2. **浏览器 F12 → Network**：请求 `GET /@plugin-<key>/index.js` 是否 403。
   - 403 的根因是 console 的 `serveAssets` 安全检查：入口路径必须以 console root 开头或包含
     `node_modules`。标准 npm/pnpm 安装天然通过；portal/本地路径等非标准安装会被拦截。
   - 插件会把 `dist` 复制到 `<baseDir>/data/napuketto-console/node_modules/koishi-plugin-adapter-napuketto/dist`
     并指向复制产物；日志 `非标准安装…前端产物复制到` 可确认。复制目标里必须同时有 `index.js` 与
     `index.css`。
3. 确认 `pnpm build:client` 已执行、`dist/index.js` / `dist/index.css` 存在。服务端不会记录这个 403，
   只能从浏览器侧看到。
4. 插件 stop/start 后面板消失：`addEntry` 的 entry 随作用域销毁；注册器在 dispose 时重置模块级
   flag，正常情况下重启会重新注册。若仍消失，检查是否被其他插件覆盖了同名 slot/entry。

### 二维码不显示

- 打开的是否是**本插件**的详情页、配置里的 `selfId` 是否与登录账号对应（store key 为
  `napuketto-login-<selfId>`）。
- 后端是否在推送：debug 日志 `pushLoginPanel: 推送登录面板` / `get() 被调用`。没有
  `get() 被调用` 说明前端没拉到 service，通常是入口未加载或 serviceId 不匹配。
- 前端组件标签必须与 import 名大小写一致（`<QrCodePanel>`）。写错会渲染成空元素且产物里出现
  `resolveComponent("qrcode-panel")`。
- 二维码本身是 `data:image/png;base64,...`；若 `image` 缺失，检查 kernel 是否推了 `qr` 消息。

### 二维码过期/刷新

前端有 2 分钟本地遮罩（纯展示）。真正过期由 kernel 自动刷新并推新码；手动“刷新二维码”走 IPC 动作
`login.refreshQr`，不重启子进程。返回 false 表示当前不在扫码态，属正常。

## 登录与重登

- 快速登录失败会自动回退二维码，不需要手动干预。
- “重新登录”在登录期与 ready 态走 `control login`（不重启进程）；ready 态是软重登，会重跑子进程
  装配链。换账号登录会被账号一致性校验拒绝上线。
- `failed` 或 IPC client 不可用时才整进程重启。
- “扫码登录”强制跳过快速登录：下次 spawn 注入一次性 `NAPUTO_QR_ONLY=1`，崩溃重启不会重复强制扫码。

## 媒体

### 图片/语音/视频发送失败（`rich media transfer failed`）

- 本地路径必须真实存在；`file://` 会转成本地路径，Windows 反斜杠会转成正斜杠——这是 NT rich media
  服务的路径语义要求。
- 远程 URL 会先下载（图片/语音 30MB、视频 100MB、15s 超时）。失败会替换成占位文本并 warn，不会
  阻断其他元素；要发大文件请先用本地路径。
- `data:` URL 会落盘；格式非法会直接抛错（不是降级），检查上游传入的 data URI。

### 语音发送成功但对方听不到

发送前会把非 silk 音频转成 silk v3。转码失败会原样发送（当前无告警），此时 QQ 可能无法播放。
确认 `@napuketto/media` 的编码依赖（ffmpeg）可用、源文件不是损坏音频。

### 视频没有缩略图/发送失败

`enrichVideoElements` 用 ffprobe 取宽高/时长、ffmpeg 抽首帧；失败会 warn 并去掉缩略图继续发送，
但 kernel 侧仍可能因缺少视频契约字段而失败。确认 ffmpeg/ffprobe 在子进程所在环境可执行。

### 收到的语音不能播放

收向会尝试把 NT 相对路径解析到
`<home>/Documents/Tencent Files/nt_qq/global` 并解码为 WAV，失败则原样透传。检查文件是否存在、
是否为 silk；WAV 输出在系统临时目录 `napuketto-voice/`，不会被主动清理。

## 数据库唯一键告警

正常路径下 `NapukettoDatabase` 会在 dispatch 前预热 channel/user，避免
`UNIQUE constraint failed: channel.id, channel.platform` / `binding.pid, platform`。若仍出现：

- `ctx.database` 是否可用（未装数据库插件时预热会跳过并单次 warn）；
- `autoAssign` / `autoAuthorize` 是否被设为不落库（此时预热按语义跳过，由 koishi 处理）；
- 同 tick 的大量系统消息是否已被 `senderUin === "0"` 过滤。

记录通常已创建成功，后续 SELECT 命中不会复发；它主要是日志噪音，但如果伴随消息处理中断，按上面
几项检查。

## 日志与诊断

- 默认 `debug`：包含引导阶段、事件转发、子进程 log、provider 诊断。调到 `info` 可只保留消息派发与
  警告；`silent` 关闭插件日志（子进程 stderr 仍会转发）。
- 子进程自己的日志由 kernel 写在账号目录（`<dataRoot>/<selfId>`）；崩溃前的 stderr 在父进程日志里。
- 提 issue 时请附：插件版本、Koishi 版本、`@napuketto/*` 版本、平台（Windows/WSL/wine）、
  boot phase 日志、子进程 stderr、以及脱敏后的配置（至少保留 `selfId` 的位数特征）。

## 开发工具问题

- `pnpm lint:client` 报 `typescript-eslint does not support TS 7.0`：上游未兼容 TS 7，该命令当前不可用，
  也不在 `pnpm check` 内。
- `pnpm test:coverage` 需要先安装 `@vitest/coverage-v8` 或 `@vitest/coverage-istanbul`。
- Biome 提示 `configuration schema version does not match`：只是 info，按提示
  `pnpm exec biome migrate` 即可。
