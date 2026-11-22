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

payload 形状（`src/console/model.ts`）：

```ts
interface LoginPanelPayload {
  state: "idle" | "waiting_scan" | "scanned" | "logged_in" | "failed"
  selfId: string
  message?: string      // 人类可读文案（loginStateMessage）
  image?: string        // 完整 data URI：data:image/png;base64,...
  qr?: { pngBase64: string; qrcodeUrl: string }
  self?: { uin: string; uid: string; nick: string }
  lastError?: string
}
```

`toLoginPanelPayload()` 是纯函数：状态文案映射 + 条件展开字段 + 从 `pngBase64` 拼 `image`。

二维码外链只保留 `http` / `https`：`sanitizeQrCodeUrl()` 解析 `qrcodeUrl`，其他协议（`javascript:` /
`data:` / `file:` 等）或无法解析的值会被丢弃；此时 `qr` 字段不出现，二维码图片仍照常展示。前端
`openQrUrl()` 在 `window.open` 前再校验一次协议。

## 鉴权

登录数据包含二维码（等价于登录凭证），三个控制事件会驱动 QQ 重新登录，因此面板统一要求
**管理员**权限等级：

- `LOGIN_PANEL_AUTHORITY = 3`（Koishi 权限系统 3 级 = 管理员），由 `src/console/model.ts`
  的 `loginPanelAccessOptions()` 生成唯一的鉴权选项；
- `DataService` 构造选项带 `authority`：数据推送（`refresh()` → `broadcast`）和连接时拉取
  （`Client.refresh()` 读取服务的 `options`）都走同一门槛；
- 三个 `ctx.console.addListener(..., loginPanelAccessOptions())` 使用同一选项。

门槛由 `@koishijs/plugin-auth` 的 `console/intercept` 判定：客户端未登录、令牌过期或
`client.auth.authority` 低于 `authority` 时，控制台拒绝推送和事件调用。provider 的 `get()` 与
三个控制回调额外按同一门槛复核已登录客户端（`passesLoginPanelAuthority()`，纵深防御）：
复核失败时 `get()` 返回不含二维码 / 登录账号 / 错误详情的脱敏快照，控制回调直接返回，不发送 IPC。

**未启用 `@koishijs/plugin-auth` 时**：控制台没有 `console/intercept` 拦截器，`authority` 门槛
不生效，任何能打开控制台的客户端都能读取登录数据并触发控制事件。面板只在客户端带 `auth` 时执行
本地复核，不会因为“未登录”而额外封锁，以免无鉴权插件的部署直接失去面板。公网或多用户共用的
控制台必须启用鉴权插件。

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
- selfId：从 `inject("manager.settings.config")` 取，用于拼 store key。
- 数据：`store["napuketto-login-<selfId>"]`；没有数据时显示加载态。
- 过期：本地 2 分钟计时（纯 UI 辅助）；kernel 过期会自动推新码，`pngBase64` 变化即复位计时。
- 刷新：`send(.../refresh-qr)`，loading 最多 3s 兜底复位。
- 打开登录链接：`openQrUrl()` 只接受 `http` / `https` 协议后才调用 `window.open`；与后端
  `sanitizeQrCodeUrl()` 同一原则。
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
