# koishi-plugin-adapter-napuketto

## 0.0.36

### Patch Changes

- fix(console): 登录面板诊断日志改走 bot logger（debug 级），修复调低「日志等级」仍刷屏
  
  - 根因：`NapukettoLoginProvider extends DataService` 时 `this.ctx.logger` 的名字被改成
    `console.services.<serviceId>`；reggol 按名字查 `Logger.levels`，插件 `logLevel`
    设置的是 `onebot`，对前者无效，provider 的 INFO 诊断（`get()` / `update()`）因此
    无论日志等级调到多低都持续输出。
  - 修复：provider 改为注入 bot logger；`get()`（前端每次 PULL 都触发）与 `update()`
    降为 debug，默认 `logLevel=debug` 可见，调成 `info`/`error`/`silent` 即静音。

## 0.0.34

### Patch Changes

- Updated dependencies [b7651ae]
- Updated dependencies [3665e63]
  - @napuketto/loader@0.0.35
  - @napuketto/kernel@0.2.0
  - @napuketto/media@0.0.5
  - @napuketto/adapter@0.3.2

## 0.0.33

### Patch Changes

- 8ce2cd8: fix(deps): @napuketto/media ~0.0.2 → ~0.0.4——修复收方向语音解码与生产加载
  
  - media 旧范围钉死漏掉 0.0.3 / 0.0.4：0.0.3 补 CJS 入口（koishi 适配器生产加载报 ERR_PACKAGE_PATH_NOT_EXPORTED）；0.0.4 新增 decodeSilkToWav（插件 voice-decode 直接 import，旧范围下生产环境收方向语音解码不可用）
  - @napuketto/adapter ~0.3.1、@napuketto/loader ~0.0.34 相对已发 0.0.32 前移（发布后的依赖刷新入库）
  - @koishijs/plugin-console 改声明为 peerDependencies、@koishijs/client 移入 devDependencies（依赖整理；koishi 宿主常驻 console，不新增安装负担）

## 0.0.32

### Patch Changes

- Updated dependencies [524e5dc]
  - @napuketto/adapter@0.3.0
  - @napuketto/loader@0.0.32

## 0.0.31

### Patch Changes

- Updated dependencies [e4bdcb3]
- Updated dependencies [d424c67]
  - @napuketto/adapter@0.2.0
  - @napuketto/kernel@0.1.1

## 0.0.30

### Patch Changes

- Updated dependencies [30eeeed]
- Updated dependencies [c36bac0]
- Updated dependencies [08119ae]
  - @napuketto/loader@0.0.31
  - @napuketto/kernel@0.1.0
  - @napuketto/adapter@0.1.0

## Unreleased

### Patch Changes

- feat: ready 态软重登（2026-09-08 A2）——登录面板「重新登录/扫码登录」在
  logged_in（ready）态改走 `control login`（loader 端清理旧装配面后重跑装配链，
  不再整进程重启）；failed/登录期行为不变。软重登换账号防线：driver ready
  幂等守卫下 onReady 不再重触发，checkIdentity 改由 logged_in 登录消息面补位
  （driver-events `onLoggedIn` → bot.handleLoggedIn）——换账号登录拒绝上线
  （同 2026-08-20 事故防线），同账号通过并同步昵称刷新。
- feat: 收方向语音解码（T6）——koishi 收到 QQ 语音（silk v3，canonical voice.path 为
  NT 相对路径不可播）先解析本地 silk 文件（绝对路径直用 / homedir Documents/Tencent
  Files/nt_qq/global 候选基准）解码为 WAV 落 tmpdir 再派发；全程 fail-soft，解析/解码
  失败原样透传不阻塞消息；bridge 派发路径异步化（adaptRawMessageWithMedia）。
- feat: 发送侧 URL 媒体下载（T3）——img/audio 的 http(s) src 先下载到本地临时文件
  再走本地路径发送（downloadRemoteMedia：30MB 上限 + 15s 超时 + 流式大小检查，
  单元素失败回退占位文本 `[图片: url]`/`[语音: url]` 并打 warn，不阻塞其余元素）；
  下载后语音继续走 silk 归一化链。
- feat: 登录面板接通 control login——重新登录在登录期（idle/waiting_scan/scanned）走
  `control login {uin}` 原地重登（不重启子进程，loader 端成功结果抢占初始登录竞速），
  ready/failed 仍走 `control restart` 整进程重启；新增「扫码登录」按钮：登录期
  `control login {uin,qr:true}` 原地强制出码，其余状态置一次性 qrOnly 标记
  （NAPUTO_QR_ONLY=1）+ 重启后直接扫码。决策/执行抽为 `login-actions.ts` 纯函数
  （含单测）；修正 launch.ts 头注释与 design.md §5.12 过时表述。

## 0.0.29

### Patch Changes

- 207d556: fix: koishi IPC 通道移植原生噪音过滤——wrapper 原生输出整行不再混入协议流

  cli 的 NATIVE_NOISE 过滤移植为 loader 共享助手 `isNativeNoiseLine`（`host/ipc/native-noise.ts` 单一来源，cli 与 koishi IPC 路径同源；IPC 协议行按 `{"v":1` 前缀构造性豁免，防载荷含噪音样文本的消息事件被误滤）。koishi 插件 `ChildProcessIpcTransport` 的 stdout/stderr 行回调接入过滤：整条原生噪音行（MMKV 刷屏 / 符号查找警告等）静默丢弃、不进 onJunkLine 撕裂诊断通道——噪音 ≠ 撕裂，协议行被插断的撕裂仍由 status 重播与脏行诊断兜底。

- Updated dependencies [207d556]
- Updated dependencies [ea754ff]
  - @napuketto/loader@0.0.28

## 0.0.28

### Patch Changes

- 02c5b13: fix: IPC 模式「能收不能发」根治——子进程 stdout 承载 JSON 行协议，却被两处 pino console 流（kernel NapukettoCore.create 与 loader kernel-services 的 createLogger）并发写入，协议行撕裂后 koishi 侧解码失败静默丢弃，恰逢 bootstrap 尾部日志密集窗口丢失 status ready，事件照常派发但发送全抛「子进程未就绪（等待驱动连接）」。四层修复：① IPC 模式（NAPUTO_IPC=1）两处 logger 关 console、改文件落盘（kernel logs/napuketto.log 原有，loader 新增 logs/loader.log），cli 输出不变；② 新增 control status 查询指令——子进程快照最近 status 并重播，防原生 printf 直写 fd 等 JS 层拦不住的残留污染；③ driver 自愈：收到 event 但状态未 ready（5s 节流）或 booting 超时（20s 定期）主动查询，ready 分支加幂等守卫防重复 onReady；④ IPC 脏行不再静默丢弃——双侧（koishi client onJunkLine debug 日志 + 子进程 boot 日志）留痕。
- Updated dependencies [02c5b13]
  - @napuketto/loader@0.0.26

## 0.0.27

### Patch Changes

- be5845c: feat: Koishi 插件 IPC 模式整表挂载 OB11 动作容器（79 动作 + ob11 事件透出）——① loader 新增 ipc-ob11 桥：检测 NAPUTO_ADAPTER_ENTRY/NAPUTO_NETWORK_ENTRY 注入时动态 import adapter/network，实例化 NapukettoOneBot11Adapter 仅 subscribeOnly()（接收链路，零网络传输/零配置文件 IO），全部动作名平铺合并进共享 IPC 动作表，OB11 事件经 broadcaster → sendEvent("ob11") 透出，装配失败 fail-soft 降级；② adapter 新增 subscribeOnly()/unsubscribeOnly() 公共方法与公开 registry（IPC 桥枚举挂载用）；③ adapter/network 根导出补 require 条件（koishi 插件 CJS 产物 createRequire.resolve 定位入口用，实际消费仍走 ESM 动态 import）；④ koishi 插件新增 @napuketto/adapter/@napuketto/network 依赖与 ob11Actions 配置（默认开），launcher 透传入口，bot.onOb11 暴露原始 OB11 事件订阅口，bot.internal.\_request("send_like", ...) 直达全部 OB11 动作（返回 OB11 标准信封）
- Updated dependencies [be5845c]
  - @napuketto/adapter@0.0.20
  - @napuketto/loader@0.0.24
  - @napuketto/network@0.0.2

## 0.0.26

### Patch Changes

- 9c39163: 修复 Koishi 发送 Base64 图片时被当作本地文件路径的问题。

## 0.0.25

### Patch Changes

- 784036b: fix(loader): WSL 生产事故修复——① Linux spawn 前预检 wine（缺失抛可读错误 + apt 指引），并挂 child 'error' 监听兜底，此前 spawn ENOENT 异步 'error' 无监听者直接 uncaughtException 崩掉整个 koishi；② ensureQqFiles/launchSelfHost 新增 onStage 阶段回调（下载/校验/解包/提取/win-node/spawn 全程日志），首次下载 313MB 安装包不再静默；③ 下载 tmp 文件唯一化（pid+时间戳）并解包前校验存在性，修复「下载成功但 7z 解包报 No such file or directory」并发竞态；④ downloadFile 完成态 stat 校验（缺失/空文件立即报错）
- Updated dependencies [784036b]
  - @napuketto/loader@0.0.23

## 0.0.24

### Patch Changes

- fix(adapter): WSL 生产事故修复——① Linux 首次启动全程可见：`buildLaunch` 把 loader 的 `onStage` 阶段回调接 logger.info（下载 313MB 安装包/校验/解包/提取/win-node/spawn 各阶段提示），此前静默数分钟用户以为流程没生效；② spawn 前 wine 预检（loader 抛可读错误 + apt 指引），driver 再挂 child `error` 监听兜底——此前 wine 缺失时 spawn 异步 `error` 无监听者 = `uncaughtException` 崩掉整个 koishi。
- Updated dependencies
  - @napuketto/loader@0.0.23

## 0.0.23

### Patch Changes

- feat(adapter): 平台名由 `napuketto` 改为 `onebot`——大量第三方插件按 `session.platform === "onebot"` 判断平台（如各类 onebot 工具/指令插件），平台名不匹配时静默不响应。改动后 `bots` 配置键同步改为 `onebot:<uin>`（`napuketto:<uin>` 旧键失效，需迁移）。底层协议仍是自研 wrapper.node 层，仅对外平台标识对齐 onebot 生态。

## 0.0.22

### Patch Changes

- fix(adapter): 新增账号一致性校验，杜绝「事件收到、dispatch 有日志、指令零响应」的静默丢消息事故。子进程登录走「quickUin 快速登录 → QR 回退」，QR 谁扫谁就是登录账号，与插件配置 `selfId` 无关；此前实际登录 uin 与配置不一致时会被静默采用，后果是：① 数据目录按配置 `selfId` 命名，另一账号的 QQ 数据写进该目录；② koishi 侧 `session.selfId` / `channel.assignee` / `binding` 全按实际 uin 落库，事后换回正确账号后 koishi 的受理人闸门（`@koishijs/core` middleware 里 `channel.assignee !== session.selfId` 直接 return，无日志无报错）会把这些频道的**所有群消息静默丢弃**，且 `assignee` 不会自动修复（行已存在，`autoAssign` 只在缺行时生效）。现在 ready 阶段校验实际登录 uin 必须等于配置 `selfId`，不一致则拒绝上线（stop driver + offline + 可操作的 error 日志），并拒绝派发任何消息，避免污染数据目录与 koishi 落库。另：dispatch 关键日志补打 `self=`（静默丢弃的判据都跟 selfId 有关，日志缺它无法现场定位）。
- Updated dependencies
  - @napuketto/loader@0.0.19

## 0.0.21

### Patch Changes

- f8c17bd: fix(adapter): 修复插件停止再启动后控制台登录面板消失——`registerConsoleEntry` 的去重 flag 改为随作用域 dispose 重置（`ctx.console.addEntry` 创建的 Entry 是作用域绑定的，插件 stop 时 console 自动移除 entry，flag 不重置则重启后不重新注册）。另优化面板观感：二维码圆角、按钮间距、面板内边距。
- 5bb12a5: refactor(adapter): IPC 协议消费 @napuketto/loader 的 zod 单一来源契约——删除本地 src/ipc/types.ts 手工镜像，codec 解码改用 IpcMessageSchema.safeParse（顺带校验 payload 形状）。
- Updated dependencies [5bb12a5]
  - @napuketto/loader@0.0.15

## 0.0.20

### Patch Changes

- e302ac2: fix(adapter): 控制台登录面板补背景色——k-comment 用 `warning` 替代 `info`（`info` 无样式规则导致背景透明），二维码/等待状态显示黄色背景与左边框，与 bilibili-dm 视觉一致。

## 0.0.19

### Patch Changes

- 4c18539: fix(adapter): 修复控制台登录面板二维码不显示——QrCodePanel 模板标签大小写不匹配（`<qrcode-panel>` 反推为 `QrcodePanel`，与 import 的 `QrCodePanel` 不匹配 → 组件被 tree-shaking 删除，二维码渲染为空自定义元素）。改 PascalCase `<QrCodePanel>` 后实测二维码正常展示。
- Updated dependencies [fa86aef]
  - @napuketto/loader@0.0.14

## 0.0.18

### Patch Changes

- fix: 修复生产环境（非 development）控制台登录面板不显示——`@koishijs/plugin-console`
  的 serveAssets 对 `/<uiPath>/@plugin-<key>/...` 有安全检查（入口文件路径必须
  startsWith(console root) 或包含 "node_modules"，否则返回 403）：非标准安装（portal/
  本地路径/桌面端等，插件路径不含 node_modules）下控制台前端入口加载失败、登录面板
  永不挂载，后端数据（waiting_scan + 二维码）虽正常推送但浏览器 F12 可见
  `GET /@plugin-<key>/index.js 403`。`registerConsoleEntry` 改为防御：prod 路径不含
  node_modules 时把 dist 产物复制到 `<数据目录>/napuketto-console/node_modules/
koishi-plugin-adapter-napuketto/dist`（路径含 node_modules → 通过安全检查），
  addEntry 指向复制产物；标准 npm/pnpm 安装（插件在 node_modules 下）行为不变，
  直接用包内 dist。另将入口注册日志从 console.log 改为 logger（koishi 日志可见）。

## 0.0.17

### Patch Changes

- ea8aa17: 修复 WSL/Linux 生产环境子进程启动失败：透传子进程 stderr（此前 code=1 退出时错误被 pipe 吞掉无从诊断），并将 QQ 原生文件定位改为按平台分支——linux 直接用数据根 ext4 缓存并缺失自动下载，避免命中 /mnt/c DrvFS 导致 wine 读不到 wrapper.node。

## 0.0.16

### Patch Changes

- fix: inject 迁入 namespace 统一元数据位置（与 Config/usage 一致，编译产物等价 static），
  修正两处回归：① 误加 `export const name` 会编译成 `NapukettoBot.name = ...` 赋值，而
  Function.name 是 writable:false——ESM 严格模式加载即抛 TypeError（实证），已移除（Bot
  子类插件名由 package.json 决定）；② inject 误标 `required` 会让 database/console 变
  强制依赖（没装数据库/控制台插件则 Bot 起不来），改回 `optional` 保持「没装也能跑」

## 0.0.15

### Patch Changes

- fix: 补全 Bot 类服务依赖声明——`static inject` 增加 `console: { required: false }`（登录面板
  依赖，与 database 同为可选增强）；Bot 子类插件（`export default`）模块级导出被 loader
  unwrapExports 丢弃，inject 必须挂类上（napcat 同构），此前 console 仅经 `ctx.inject` fork
  声明、static 层缺失

## 0.0.14

### Patch Changes

- fix: `SerialQueue` 清理链前接 catch 吞掉任务失败——任务失败时 `finally` 派生 promise 随之
  reject 被 `void` 丢弃，产生 unhandled rejection（vitest/Node 均报错）；行为不变
- test: 补全该写未写的单测（+36 用例，全量 541 通过）

  - `bot/utils/session.ts` `applySessionFields`：必填直赋 / 可选条件展开（exactOptionalPropertyTypes
    不 set undefined）/ elements 特殊处理（只设 elements 不设 content）
  - `ipc/pending.ts` `PendingRequests`：id 单调 / resolve / reject（动作名 + 错误码透传）/ 迟到响应
    忽略 / 超时 IpcError(TIMEOUT) / rejectAll 幂等 / 超时后清理
  - `driver/heartbeat.ts` `HeartbeatMonitor`：超时判定（seenAt 为准 / spawnAt 兜底 / 无参照不触发 /
    边界严格大于）/ 暂停状态跳过 / start 幂等 / stop 停止轮询
  - `bot/utils/driver-events.ts` `buildDriverEvents`：7 个事件回调的转发与日志（全 type-only import，
    运行时零 koishi 依赖，此前「不进单测」的保守结论已推翻）
  - `database/serial-queue.ts` `SerialQueue`：同 key 串行 / 异 key 并行 / 前序失败不阻塞 / 链尾清理
    防 Map 增长

## 0.0.13

### Patch Changes

- refactor: 按 fallow 静态分析重构，消灭全部死代码并拆分大文件（行为不变，全量单测 489 通过）

  - **拆分 godfile**：`bot.ts`（602 行 → 384 行）拆出 `bot/assembly.ts`（构造装配工厂，
    host 注入）、`bot/transform.ts`（kernel → Universal 翻译纯函数，新增 13 单测）、
    `bot/driver-events.ts`（driver 事件接线工厂）、`bot/console-entry.ts`（前端入口注册）、
    `bot/login-panel.ts`（控制台面板装配/指令上行）、`bot/session.ts`（session 字段赋值
    纯函数）、`src/constants.ts`（协议共享常量）；`driver.ts` 拆出 `driver/heartbeat.ts`
    （心跳监控独立类）；`ipc/client.ts` 拆出 `ipc/pending.ts`（请求-响应匹配）；
    `database/index.ts` 拆出 `database/serial-queue.ts`（per-key 串行队列）；
    `events/elements.ts` 新增 `bindKoishiH`（原 bot.ts adaptH 正名归位，对齐文档命名）
  - **前端拆分**：`settings.vue`（363 行 → 217 行）template 拆成 `client/components/QrCodePanel.vue`
    （二维码块）与 `client/components/StatusSection.vue`（状态块），fallow template 复杂度
    CRITICAL → 移除
  - **死代码清理**：`console/provider.ts` 移除 6 个无消费者导出（`LOGIN_SERVICE_PREFIX`、
    `RELOGIN_EVENT_SUFFIX`、`REFRESH_QR_EVENT_SUFFIX`、`reloginEventName`、`refreshQrEventName`、
    `LoginPanelOptions`），`console/index.ts` barrel 收窄；fallow dead files 3.2% → 0%、
    dead exports 8.6% → 0%，MI 91.4 → 92.7
  - **复杂度**：`dispatchSession` CRAP 306 → 132（预热逻辑拆 `preheat()`），`getLogin` CRAP
    110 → 消除；`dispatchSession`/`getLogin` 均不再 CRITICAL
  - **误报豁免**：`.fallowrc.jsonc` 标记 `client/**` 为动态入口（控制台 addEntry 注册，静态
    分析看不到）+ `provider.get` 为 DataService 抽象实现豁免
  - **顺带修复**：`QrCodePanel.vue` template 引用未定义的 `qrUrl`（改为 `qr?.qrcodeUrl`）
  - 前端类型声明文件迁移到 `client/types/`（`koishijs-client.d.ts`/`shims.d.ts`）

## 0.0.12

### Patch Changes

- 5ad758c: fix(adapter): 修复控制台扫码登录二维码不显示——二维码改为后端拼成完整 data URI（`image` 字段）由前端 `<img :src>` 直接展示（参照 bilibili-dm 的 image 模式，不再前端拼 `data:image/png;base64,`）；并在 console 服务自身作用域监听 `console/connection`，客户端连接瞬间兜底重推最新登录快照（登录自动启动早于客户端连接，PUSH 被 broadcast 的 `!handles.length` 丢弃）
- 9c071b8: fix(adapter): 修复控制台插件详情页不显示「本插件提供了…」说明——`usage` 原在 `index.ts` 模块级导出，被 koishi loader 的 `unwrapExports`（`module?.default || module`）随 `export default NapukettoBot` 解包时丢弃；改为挂到 `NapukettoBot` 类上（namespace 声明合并），`PackageProvider.parseExports` 的 `exports?.usage` 才能读到。同时把二维码面板 `get()` 的诊断日志从裸 `console.log` 改为 `logger.info`，便于确认前端 PULL 是否触发

## 0.0.11

### Patch Changes

- d2f9245: fix(adapter): 修复控制台扫码登录二维码不显示——登录自动启动早于控制台客户端连接，二维码推送因 `broadcast` 无客户端被丢弃；改为服务值注册到 root store（`Client.refresh()` 的 PULL 能读到）并拿 `set` 返回的 dispose 函数在 bot dispose 时清理，reload 不再报 `service has been registered`

## 0.0.10

### Patch Changes

- d2f9245: fix(adapter): 修复控制台扫码登录二维码不显示——登录自动启动早于控制台客户端连接，二维码推送因 `broadcast` 无客户端被丢弃；修复服务值注册到 `ctx.root` 确保 `Client.refresh()` 的 PULL 能拉到快照，并在 `console/connection` 事件触发时兜底推送

## 0.0.9

### Patch Changes

- 98c27a3: feat(adapter): 扫码登录「刷新二维码」改为 IPC 直达（不再重启子进程）+ 超时文案

  - 前端「刷新二维码」按钮改发 `refresh-qr` console 事件 → `requestRefreshQr()`
    → IPC `login.refreshQr` 动作直达 kernel，不重启子进程（「重新登录」按钮仍保留重启语义）
  - `NapukettoLoginProvider` 新增 `refresh-qr` 事件上行；`NapukettoLoginState.onLogin`
    支持 `message`（failed 态失败原因，如「登录超时，请刷新页面重试」）
  - 前端 waiting_scan 增加「请在两分钟内…」提示，移除 3 分钟 UI 过期计时器
    （kernel 已自动刷新 + 120s 超时兜底）

- Updated dependencies [98c27a3]
- Updated dependencies [98c27a3]
  - @napuketto/loader@0.0.12
  - @napuketto/kernel@0.0.10

## 0.0.8

### Patch Changes

- fix(actions): 媒体路径统一规范化（Windows 反斜杠 → 正斜杠）——redposter 实证 `file://` 转 `fileURLToPath` 后 Windows 返回反斜杠路径，透传给 wrapper.node rich media 服务读不到文件，仍报 `rich media transfer failed`（现象：发送方日志「已缓存海报图片」成功但 `msg.sendMessage` 失败）。`mediaElement` 现对 `img`/`audio` 的本地路径（含 `file://` 转换结果）统一 `replace(/\\/g, "/")` 转正斜杠（Chromium/Electron 内部按 URL 语义处理路径），同步更新单测与 design.md §5.10

## 0.0.7

### Patch Changes

- f6b94c2: fix(events): dispatch 前原子预热 channel，消除 koishi get-or-create 并发撞唯一键——koishi `Session.getChannel` 是 check-then-act（先 SELECT、未命中才 INSERT），多条真实消息同 tick 批量 dispatch 时并发 INSERT 撞 `(id, platform)` 复合主键报 `UNIQUE constraint failed`（实测同批 4 条 → 1 成功 + 3 冲突，框架侧根因已上报 koishijs/koishi#1545）。新增 `src/database/`（NapukettoDatabase）集中管理数据库操作：dispatch 前两段式预热（get 命中直返 / 未命中 minato upsert 幂等创建）+ per-channel 串行队列（不同 channel 并行）+ 预热失败单次告警不阻断消息 + autoAssign=false 保持 koishi 不落库语义。预热后框架 SELECT 必命中，从根上消除竞态

## 0.0.6

### Patch Changes

- fix: 包 exports 增加 require/default 条件——`@napuketto/*` 被 koishi 插件（CJS 产物）作 dependencies 消费时，`require('@napuketto/kernel')` 此前因 exports 仅声明 `import` 条件而报 `ERR_PACKAGE_PATH_NOT_EXPORTED`。补 `require`/`default` 条件指向同一 `.mjs`（无顶层 await，Node 22.12+ require(esm) 原生同步加载）；插件发布链自动追踪新版本
- Updated dependencies
  - @napuketto/kernel@0.0.4
  - @napuketto/loader@0.0.7

## 0.0.5

### Patch Changes

- a3ead3e: fix: 产品化发布形态——`@napuketto/kernel`/`@napuketto/loader` 从 devDependencies 移到 dependencies（tsdown external 不 bundle），子进程需要的磁盘资产（self-host.cjs / stub QQNT.dll / kernel 入口）由 npm 真实安装提供；`resolveEntry` 改用 `createRequire` 替代 `import.meta.resolve`（CJS 产物下失效，此前干净环境安装必然报 `{}.resolve is not a function`）。新增主仓库发布链工具 `scripts/sync-adapter-deps.ts`（Node 原生 type stripping 直跑 + vitest 单测）：发版时自动查询 registry latest 并把插件依赖范围刷成 `~latest`，自动追踪 kernel/loader 最新 0.0.x 修复（release 链已接入）
- 9f563f5: fix: client 前端 tsconfig 严格化（ES2025 + strict 全家桶 + bundler 解析），通过 paths 重定向 `@koishijs/client` 到本地类型 shim 隔离上游 TS 源码错误，并把 client 类型检查接入包级 `pnpm check`

## 0.0.4

### Patch Changes

- 6ee4b54: fix(actions): 修复 file:// 协议图片/语音发送失败（rich media transfer failed）——`mediaElement` 现将 `file://` URL（如 redposter 用 `pathToFileURL` 生成的 src）经 `fileURLToPath` 转为真实本地路径，避免带协议前缀透传给 wrapper.node

## 0.0.3

### Patch Changes

- f6666d1: fix(client): 修复前端类型报错与构建依赖——tsconfig 改用 bundler 解析、移除上游损坏的 `@koishijs/client/global` 类型引用（5.30.11 exports 映射 bug）、新增 shims.d.ts 提供 `*.vue` 模块声明、显式声明 vue devDependency 保证 vite 构建可复现

## 0.0.2（2026-08-09）

- feat: Bot 集成——NapukettoBot 注册 koishi 平台（driver 装配/事件桥/动作桥/MessageEncoder），端到端链路打通
- feat(config): selfHostEntry 自建宿主入口覆盖（发布形态方案 a）——bundle 后 \_\_dirname 定位 self-host.cjs 失效，bot 配置可显式指定入口
- fix(events): 修复 dispatch 链路三 bug——数据库无消息记录的根因
- fix(bot): 修复 Context 泛型逆变不兼容——改用 @satorijs/core 的 Context，TS 7.0 原生语言服务通过
- test: 新增单元测试覆盖 ipc/client/codec/subscribers/transport 与 channel/elements/internal
- refactor: fallow 静态分析优化——死代码 51→0、重复 63→0、MI 92.1

## 0.0.1（2026-08-08）

- 首版骨架：IPC 传输层 + NapukettoDriver 基础框架
