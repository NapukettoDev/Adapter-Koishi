# 控制台登录面板

在 Koishi 控制台的**插件详情页**内嵌登录面板：实时显示登录状态、二维码、登录账号，支持重新登录、
强制扫码与刷新二维码。后端是 `DataService` 推送，前端只读 store + 发 WebSocket 事件，**零 HTTP
请求**。

涉及代码：`src/console/`、`client/`。

## 数据流

```
子进程 qr/login 消息
  → driver onQr/onLogin
  → NapukettoLoginState（状态机 + 快照）
  → NapukettoLoginPanel.push() → DataService.refresh()
  → NapukettoLoginProvider.get() → toLoginPanelPayload(snapshot, selfId)
  → console broadcast「data」→ 浏览器 store['napuketto-login-<uin>']
  → settings.vue computed 读取并渲染

前端按钮 → send('napuketto-login-<uin>/relogin' | '/qr-login' | '/refresh-qr')
  → provider 的 console listener → bot 层发 IPC control / action
```

## 后端 Provider

`NapukettoLoginProvider extends DataService<LoginPanelPayload>`：

- serviceId / store key：`napuketto-login-<selfId>`（按 QQ 号隔离，支持多账号）。
- `super(ctx, serviceId, { immediate: true, authority: 3 })` 允许面板装配显式注册服务值。
  `authority` 同时约束推送与拉取。
- `get()` 在推送或连接拉取时读取当前 Bot 的快照。
- 构造函数注册三个上行事件（均带同一 `authority` 选项）：

| 事件名 | 前端动作 | bot 层行为 |
| :--- | :--- | :--- |
| `napuketto-login-<uin>/relogin` | 重新登录 | 引导期发 `control login`，已登录或失败时请求重启宿主 |
| `napuketto-login-<uin>/qr-login` | 扫码登录 | 引导期发 `control login qr=true`，已登录或失败时请求重启并强制新宿主扫码 |
| `napuketto-login-<uin>/refresh-qr` | 刷新二维码 | IPC 动作 `login.refreshQr`（不重启子进程） |

**日志必须注入 bot logger，不能用 provider 自己的 ctx logger**：DataService 构造会把 fork ctx 的
runtime name 改成 `console.services.<serviceId>`，reggol 按名字查日志等级，插件 `logLevel` 对它无效，
INFO 诊断会一直刷屏。Provider 使用当前 Bot 注入的 logger，诊断日志为 debug 级。

登录快照包含 `state`、`selfId`、`generation` 和状态文案。登录成功只交付对应账号的
`self`，失败时才交付本次 `lastError`。扫码等待期间，`image` 是唯一一份 PNG data URI，
`qrUrl` 是独立校验的 HTTP(S) 外链。图片校验 PNG 头和 Base64 格式，外链禁止携带 URL 用户信息。
收到二维码时记录本地两分钟截止时间 `qrExpiresAt`，拉取和重复广播沿用同一个截止时间。
截止后服务只交付过期时间，及时收到二维码的页面也会停止展示二维码和外链。

## 鉴权

锁文件中的官方 Console 5.30.11 和官方 Auth 4.1.7 共用 `console/intercept`。面板数据服务和三个
RPC 都声明 `authority: 3`。连接及 Auth 状态变更后的拉取由 `Client.refresh()` 逐客户端检查，
拒绝时清空对应的 store 数据。广播由 `Console.broadcast()` 逐客户端检查。RPC 由
`Client.receive()` 先检查权限，再用当前 `Client` 作为回调的 `this`。

Provider 在交付数据或执行动作时再次检查当前客户端。官方 Auth 公开的服务名是 `auth`，该服务就绪时，
缺失登录态、已登出、令牌过期或当前会话权限低于 3 均拒绝。没有接收客户端的 Provider 读取只返回脱敏快照。
RPC 要求参数中的 `selfId` 精确匹配服务所属账号，接受操作返回 `true`，未触发返回 `false`。
权限使用官方 Console 客户端持有的会话数据，管理端改权后以 Auth 更新该会话或重新登录后的权限为准。

有意在可信环境中运行无 Auth 的 Console 时，缺少 Auth 服务及客户端登录态仍可使用面板。启用官方 Auth
需要 Console 与数据库服务。`admin.enabled: false` 只关闭内置管理员账号的初始化，鉴权仍会生效。
官方 Auth 是可选部署组件，适配器无需新增运行时依赖。

## 面板装配

`NapukettoBot` 构造时创建 `NapukettoLoginPanel` 并调用 `panel.setup(ctx)`：

1. `ctx.inject(["console"], fork => …)`：等 console 服务就绪；未启用 console 插件时回调不触发，
   插件其余功能不受影响（但 `@koishijs/plugin-console` 包本身是 peer，需要可解析）。
2. `registerConsoleEntry(fork)`：注册前端入口（见下节）。
3. 账号的 Provider 在独立于 Bot 的 console 注入作用域注册。同 selfId 已有服务时复用 Provider，
   最新装配的 Bot 接管快照读取、三个控制回调和日志。装配完成后立即推送。
4. Provider 的作用域持有 `console/connection` 监听。连接时刷新数据，`Client.refresh()` 的主动拉取
   也通过同一个 Provider 读取当前 Bot 的快照。没有客户端时跳过推送。
5. Bot 的注入作用域卸载时只释放自己的绑定及入口引用。被接管的绑定无法再触发推送或销毁 Provider。
   当前绑定释放时销毁 Provider 作用域，清理数据服务和连接监听，并从 Console 的监听器表中移除
   仍由该 Provider 持有的三个控制监听器。

面板每次操作都读取 driver 当前仍打开的 IPC 连接，引导期即可刷新二维码和发送登录指令。
业务动作和消息派发继续使用 ready 后按账号一致性校验绑定的连接。子进程替换时，面板随 driver 切换连接。

`planRelogin()` 根据当前登录状态选择原地重登或重启。宿主重启开始时，面板立即清除旧的登录快照。
需要重启才能扫码时，Bot 先置一次性 `qrOnly` 标记，再由 driver 通知旧宿主退出。
当前没有连接时，刷新和普通重登记录告警，强制扫码保留标记并告警。下次 spawn 消费标记并注入
`NAPUTO_QR_ONLY=1`。状态与指令对应关系见 [生命周期](../architecture/lifecycle.md#重新登录与强制扫码)。

## 前端入口与 403 防护

`registerConsoleEntry(ctx)`（`src/console/entry.ts`）：

1. `packageRoot()` 从当前模块文件逐级上溯最多 5 层，找到 `package.json` 且 `name` 匹配本包。
   bundle（`lib/index.cjs`）与源码（`src/console/entry.ts`）深度不同，不能写死相对层数。
2. `ensureServeableProd()`：prod 目录是 `<packageRoot>/dist`。
   `@koishijs/plugin-console` 的 `serveAssets` 要求入口路径以 console root 开头或**包含
   `node_modules`**，否则返回 403（浏览器动态 import 失败，面板永不挂载）。
   - 标准 npm/pnpm 安装路径天然包含 `node_modules` → 直接使用。
   - portal/本地路径/桌面端等非标准安装 → 把 `index.js` / `index.css` 复制到
     `<baseDir>/data/napuketto-console/node_modules/koishi-plugin-adapter-napuketto/dist`，
     addEntry 指向复制产物。按 size/mtime 比较，未变化不重复写盘。
3. 从 Koishi 根作用域创建一个依赖 `console` 的注入作用域，在其中调用
   `addEntry({ dev: <root>/client/index.ts, prod })`。入口独立于任一 Bot，并在 console 服务卸载前销毁。
4. 每个 console 的入口由其活跃 Bot 共享。Bot 的注入作用域销毁时释放一次引用，最后一个 Bot 释放时
   销毁入口。重新启用后重新注册，不同 console 服务各自管理自己的入口。

## 前端

| 文件 | 职责 |
| :--- | :--- |
| `client/index.ts` | 注册登录面板插槽与高级配置分组的表单渲染器 |
| `client/components/ConfigGroup.vue` | 默认折叠高级配置分组，展开后使用 Koishi 原生字段控件 |
| `client/settings.vue` | 共享状态：读取 store/配置、过期计时、刷新 loading、状态分发 |
| `client/components/QrCodePanel.vue` | `waiting_scan`：二维码、2 分钟过期遮罩、刷新/打开链接 |
| `client/components/StatusSection.vue` | `idle` / `scanned` 加载文案；`logged_in` / `failed` 的状态、账号信息与重登/扫码按钮 |
| `client/types/` | 控制台 `@koishijs/client` 模块的本地类型 shim（上游以 TS 源码发布，strict 下会暴露其错误） |

Koishi 原生交叉表单渲染器会给子组传入 `foldable: false`。高级分组使用独立的 `napuketto-config-group`
表单角色，由控制台入口注册折叠渲染器。编辑事件继续交给原生表单，YAML 字段沿用原有层级。

`settings.vue` 的关键逻辑：

- 插件识别：`inject("manager.settings.local")` 的 `name === "koishi-plugin-adapter-napuketto"`，
  且 `inject("manager.settings.current").disabled !== true` 才渲染。
- selfId 从 `inject("manager.settings.config")` 读取。配置、store 键和 payload 中的账号须一致。
  无数据时显示加载态。
- 扫码期使用快照的截止时间管理过期状态。刷新期间保留已有的过期提示，新二维码到达后更新截止时间。
- 三个动作共用一个可清理的等待计时器。拒绝、未触发或 RPC 失败会立即解锁并显示错误。
  新二维码、状态或登录轮次变化也会解锁。账号切换、面板禁用或卸载会清理两个计时器。
- 打开登录链接前再次校验 HTTP(S)，以 `noopener,noreferrer` 打开。过期后隐藏外链。
- 配置分组缺少描述时显示默认标题，保留传入 schema 的其他元数据以及原生字段编辑能力。
- 组件标签必须与 import 名大小写完全一致（如 `<QrCodePanel>`）。全小写 `<qrcode-panel>` 会被
  编译器反推为 `QrcodePanel`，与 `QrCodePanel` 不匹配，降级为运行时解析并渲染空元素。

## 构建与依赖

- `pnpm build:client`（`vite.config.client.ts`）以 `client/index.ts` 为入口，输出固定文件名
  `dist/index.js`（ESM）+ `dist/index.css`；`CLIENT_FILES` 清单与运行时复制逻辑依赖这两个名字。
- external：`vue` / `vue-router` / `@vueuse/core` / `@koishijs/client`，由控制台运行时提供。
- 开发态（Koishi dev）直接编译 `client/index.ts`，无需预构建；生产态必须存在 `dist` 产物。
- `@koishijs/plugin-console` 是 **peerDependency**：宿主 Koishi 提供运行时；未启用控制台时面板不
  出现，但登录流程与消息收发照常工作。
- `@koishijs/client` 不是依赖：构建时保持 external（运行时由控制台提供），类型检查走
  `client/types/` 本地 shim。
- 样式为标准 CSS（`<style scoped>`，无 SCSS 预处理器）：嵌套与 `:deep()` 由 Vue 编译器与构建链
  处理，不再需要 `sass` / `@parcel/watcher`。
