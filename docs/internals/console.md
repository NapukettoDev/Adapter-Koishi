# 控制台登录面板

在 Koishi 控制台的**插件详情页**内嵌登录面板：实时显示登录状态、二维码、登录账号，支持重新登录、
强制扫码与刷新二维码。后端是 `DataService` 推送，前端只读 store + 发 WebSocket 事件，**零 HTTP
请求**。

涉及代码：`src/console/`、`src/bot/login-panel.ts`、`src/bot/utils/console-entry.ts`、`client/`。

## 数据流

```
子进程 qr/login 消息
  → driver onQr/onLogin
  → NapukettoLoginState（状态机 + 快照）
  → NapukettoLoginPanel.push()
  → toLoginPanelPayload(snapshot, selfId)
  → NapukettoLoginProvider.update(payload) → DataService.refresh()
  → console broadcast「data」→ 浏览器 store['napuketto-login-<uin>']
  → settings.vue computed 读取并渲染

前端按钮 → send('napuketto-login-<uin>/relogin' | '/qr-login' | '/refresh-qr')
  → provider 的 console listener → bot 层发 IPC control / action
```

## 后端 Provider

`NapukettoLoginProvider extends DataService<LoginPanelPayload>`：

- serviceId / store key：`napuketto-login-<selfId>`（按 QQ 号隔离，支持多账号）。
- `super(ctx, serviceId, { immediate: true })`：`immediate` 让服务值由调用方注册（见“面板装配”），
  避免 DataService 自动 `set` 与调用方重复。
- `update(payload)`：保存快照并 `void refresh()`（推送不阻塞状态回调）。
- `get()`：前端 PULL 时返回当前快照（控制台连接/刷新时调用）。
- 构造函数注册三个上行事件：

| 事件名 | 前端动作 | bot 层行为 |
| :--- | :--- | :--- |
| `napuketto-login-<uin>/relogin` | 重新登录 | 按登录状态走 `control login` 或 `control restart` |
| `napuketto-login-<uin>/qr-login` | 扫码登录 | 登录期 `control login qr=true`；否则一次性 `qrOnly` + 重启 |
| `napuketto-login-<uin>/refresh-qr` | 刷新二维码 | IPC 动作 `login.refreshQr`（不重启子进程） |

**日志必须注入 bot logger，不能用 provider 自己的 ctx logger**：DataService 构造会把 fork ctx 的
runtime name 改成 `console.services.<serviceId>`，reggol 按名字查日志等级，插件 `logLevel` 对它无效，
INFO 诊断会一直刷屏。因此 `get()` / `update()` 的诊断日志走注入 logger 且为 debug 级。

payload 形状（`src/console/types.ts`）：

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

## 面板装配

`NapukettoBot` 构造时创建 `NapukettoLoginPanel` 并调用 `panel.setup(ctx)`：

1. `ctx.inject(["console"], fork => …)`：等 console 服务就绪；未启用 console 插件时回调不触发，
   插件其余功能不受影响（但 `@koishijs/plugin-console` 包本身是 peer，需要可解析）。
2. `registerConsoleEntry(fork)`：注册前端入口（见下节）。
3. **reload 去重**：从 `fork.root.get("console.services.<serviceId>")` 取已有 provider。root store
   不随插件 dispose 自动清理，同 selfId 已注册则复用，避免重复注册报错。
4. 新建 provider（注入 `selfId`、bot logger、三个上行回调），并 `fork.root.set(...)` 拿到 dispose。
5. `fork.console.ctx.on("console/connection", () => push())`：客户端连接瞬间重推一次。登录是自动启动的，
   二维码/状态可能在客户端连接前就推完，被 `DataService.refresh()` 的“无订阅者直接返回”丢弃；
   PULL 只能拿到最后一次快照，连接回放保证首屏有数据。
6. `fork.on("dispose", () => { disposeService(); offConnection(); })`。
7. 立即 `push()` 当前快照。

`push()` 在 provider 尚未装配时只打 debug 日志并跳过；装配后 `snapshot → payload → update`。

重登/扫码决策见 [生命周期](../architecture/lifecycle.md#重新登录与强制扫码)：
`planRelogin()` 根据当前状态选择 `control login`（原地/软重登）或 `control restart`；
`forceQrRestart()` 置一次性 `qrOnly` 标记并重启子进程，下次 spawn 注入 `NAPUTO_QR_ONLY=1`。

## 前端入口与 403 防护

`registerConsoleEntry(ctx)`（`src/bot/utils/console-entry.ts`）：

1. `packageRoot()` 从当前模块文件逐级上溯最多 5 层，找到 `package.json` 且 `name` 匹配本包。
   bundle（`lib/index.cjs`）与源码（`src/bot/utils/...`）深度不同，不能写死相对层数。
2. `ensureServeableProd()`：prod 目录是 `<packageRoot>/dist`。
   `@koishijs/plugin-console` 的 `serveAssets` 要求入口路径以 console root 开头或**包含
   `node_modules`**，否则返回 403（浏览器动态 import 失败，面板永不挂载）。
   - 标准 npm/pnpm 安装路径天然包含 `node_modules` → 直接使用。
   - portal/本地路径/桌面端等非标准安装 → 把 `index.js` / `index.css` 复制到
     `<baseDir>/data/napuketto-console/node_modules/koishi-plugin-adapter-napuketto/dist`，
     addEntry 指向复制产物。按 size/mtime 比较，未变化不重复写盘。
3. `ctx.console.addEntry({ dev: <root>/client/index.ts, prod })`。
4. **模块级去重 flag 在作用域 dispose 时重置**：`addEntry` 创建的 entry 绑定当前作用域，插件
   stop 会移除 entry；若 flag 不重置，插件重启后不会重新注册，面板永久消失。多 bot 场景只有第一个
   实例真正注册，第一个实例 dispose 时重置 flag，整体正确。

## 前端

| 文件 | 职责 |
| :--- | :--- |
| `client/index.ts` | `ctx.slot({ type: "plugin-details", component: Settings, order: 800 })` |
| `client/settings.vue` | 共享状态：读取 store/配置、过期计时、刷新 loading、状态分发 |
| `client/components/QrCodePanel.vue` | `waiting_scan`：二维码、2 分钟过期遮罩、刷新/打开链接 |
| `client/components/StatusSection.vue` | `idle` / `scanned` 加载文案；`logged_in` / `failed` 的状态、账号信息与重登/扫码按钮 |
| `client/types/` | `@koishijs/client` 类型 shim（上游以 TS 源码发布，strict 下会暴露其错误） |

`settings.vue` 的关键逻辑：

- 插件识别：`inject("manager.settings.local")` 的 `name === "koishi-plugin-adapter-napuketto"`，
  且 `inject("manager.settings.current").disabled !== true` 才渲染。
- selfId：从 `inject("manager.settings.config")` 取，用于拼 store key。
- 数据：`store["napuketto-login-<selfId>"]`；没有数据时显示加载态。
- 过期：本地 2 分钟计时（纯 UI 辅助）；kernel 过期会自动推新码，`pngBase64` 变化即复位计时。
- 刷新：`send(.../refresh-qr)`，loading 最多 3s 兜底复位。
- 组件标签必须与 import 名大小写完全一致（如 `<QrCodePanel>`）。全小写 `<qrcode-panel>` 会被
  编译器反推为 `QrcodePanel`，与 `QrCodePanel` 不匹配，降级为运行时解析并渲染空元素。

## 构建与依赖

- `pnpm build:client`（`vite.config.client.ts`）以 `client/index.ts` 为入口，输出固定文件名
  `dist/index.js`（ESM）+ `dist/index.css`；`CLIENT_FILES` 清单与运行时复制逻辑依赖这两个名字。
- external：`vue` / `vue-router` / `@vueuse/core` / `@koishijs/client`，由控制台运行时提供。
- 开发态（Koishi dev）直接编译 `client/index.ts`，无需预构建；生产态必须存在 `dist` 产物。
- `@koishijs/plugin-console` 是 **peerDependency**：宿主 Koishi 提供运行时；未启用控制台时面板不
  出现，但登录流程与消息收发照常工作。
- `@koishijs/client` 是 devDependency，仅用于前端构建与本地类型 shim。
