# 开发与构建

## 环境

- Node 24（CI 基线）、pnpm 12.4.1（`packageManager` 字段；corepack 可钉住）。
- TypeScript 7（`devDependencies`）。
- 单包工程，根包即唯一 workspace；`pnpm-workspace.yaml` 只承载 pnpm 12 的构建审批/发布龄等设置。
- 单元测试不需要真实 QQ、真实子进程或 wine。

## 常用命令

| 命令 | 作用 |
| :--- | :--- |
| `pnpm install` | 安装依赖（`pnpm-lock.yaml`；CI 用 `--frozen-lockfile`） |
| `pnpm dev` | `tsdown --watch`，只重建 `lib/`（不含控制台前端） |
| `pnpm build` | `tsdown` 构建 `lib/index.cjs` + `lib/index.d.cts` |
| `pnpm build:client` | Vite 构建控制台前端到 `dist/index.js` / `dist/index.css` |
| `pnpm check` | `biome check .` + 根 `tsc --noEmit` + `tsc -p client/tsconfig.json` |
| `pnpm test` | `vitest run` 全量单测 |
| `pnpm lint:client` | ESLint 检查 `.vue`（当前不可用，见下） |
| `pnpm test:coverage` | 脚本存在，但仓库未安装 `@vitest/coverage-*` provider，需先补齐依赖 |

只跑某个测试文件：`pnpm exec vitest run src/events/__tests__/adapt.test.ts`。

## 产物与依赖形态

```
src/index.ts ──tsdown──▶ lib/index.cjs + lib/index.d.cts
client/index.ts ──vite──▶ dist/index.js + dist/index.css
```

- `tsdown.config.ts` 设置 `deps.bundle: false`：`@napuketto/*` 与 koishi 生态全部 external，
  运行时由 npm 安装的真实包提供。发布物不是自包含 bundle；子进程要读磁盘上的
  `self-host.cjs`、stub DLL、kernel 入口，bundle 会丢资产。
- `package.json` 的 `files` 只含 `lib`、`client`、`dist`，**`src` 不发布**。
- `exports`：
  - `types` → `lib/index.d.cts`
  - `development` → `src/index.ts`（只对仓库内开发有效；发布包没有 `src`）
  - `default` → `lib/index.cjs`
- koishi 以 `require()` 加载插件时按 Node 默认条件解析，通常走 `default`（即 `lib`）。因此：
  - 在 Koishi 里联调本仓库源码时，先 `pnpm build`（必要时再 `pnpm build:client`）；
  - 或在 bot 配置里用 `kernelEntry` / `selfHostEntry` 等覆盖入口。
- `pnpm build` 不做类型检查；`pnpm check` 才是类型门禁。CI 的顺序是
  `install → build && build:client → check → test`，因为 `tsc` 走 NodeNext 解析 `@napuketto/*`
  的 `exports`，依赖的 `dist` 类型必须先存在。

## 检查边界

| 工具 | 范围 | 说明 |
| :--- | :--- | :--- |
| Biome | `**/src/**/*.{ts,tsx,mts,cts,js,mjs,cjs,jsx}` | 4 空格、100 列、双引号、尾逗号；`client/` 与根配置文件不在范围内 |
| `tsc`（根） | `src/**` | strict 全家桶 + `exactOptionalPropertyTypes` + `verbatimModuleSyntax` + `noUncheckedIndexedAccess` |
| `tsc`（client） | `client/**` | 独立 `client/tsconfig.json`：`moduleResolution: bundler`、`types: []`、`paths` 把 `@koishijs/client` 指向本地 shim |
| ESLint | `client/**/*.vue` | `vue/no-undef-components` 等模板语义检查；**当前不可用**——`@typescript-eslint/parser` 尚不支持 TS 7，命令直接报错。它不在 `pnpm check` 中 |
| Vitest | `src/**/__tests__` | 见下节 |

`biome.json` 的 `$schema` 版本可能落后于本地 CLI（只提示 info，不影响检查）；需要时执行
`pnpm exec biome migrate`，不要手改规则。

## 测试边界

单测**不加载 koishi 运行时**（会初始化 loader，历史上直接崩溃）。因此架构上把可测逻辑抽成纯函数/
独立类，通过接口注入依赖：

| 设施 | 位置 | 用途 |
| :--- | :--- | :--- |
| `MemoryLinePair` / `captureAction` | `src/ipc/test-utils.ts` | 内存双端传输，捕获 action 请求 |
| `FakeChild` / `createHarness` | `src/driver/test-utils.ts` | 假子进程、spawn 记录、发送 status |
| `mockH()` | `src/events/test-utils.ts` | 模拟 satorijs `Element.toString()` 语义 |
| mock `request` | 各 `actions/__tests__` | 断言动作名与 params，不经过 IPC |
| mock `logger` | `bot/utils/__tests__/driver-events.test.ts` 等 | 断言事件接线 |

适合写单测的形态：

- 元素双向映射（`events/elements.ts`、`actions/elements.ts`）。
- channelId 解析、session 字段应用、Universal 形状转换、身份判定、重登决策。
- IPC 编解码/超时/关闭、driver 状态迁移/退避/心跳（注入假时钟或短超时）。
- 媒体管线（mock fetch / 临时目录 / 注入超时与大小上限）。
- launch 的选项解析（注入假 `resolveQq`，不真实 spawn）。

不适合放进单测的：`bot.ts`、`message.ts`、`login-panel.ts`、`assembly.ts`、`config.ts`、
`console/provider.ts`、`index.ts`——它们运行时 import koishi/console。

## 代码约定

- **模块系统**：ESM + NodeNext；相对 import 必须带 `.js` 后缀；类型导入用 `import type`。
- **可选属性**：开启 `exactOptionalPropertyTypes`，可选字段用条件展开
  `...(x !== undefined ? { x } : {})`，不要显式赋 `undefined`。
- **跨包类型**：IPC 消息类型/schema 以 `@napuketto/loader` 为唯一来源，插件侧 re-export，不复制定义。
- **依赖方向**：`driver` 不认识 loader（launch 注入）；`events`/`actions` 不 import koishi 运行时；
  `console` 之外的层不依赖控制台。
- **barrel**：`index.ts` 只 re-export 有消费者的符号；内部类型让消费方直接从 `types.js` 引入，
  避免死导出。
- **const enum**：`Universal.Channel.Type` / `Universal.Status` 在 `verbatimModuleSyntax` 下不可访问，
  用 `src/constants.ts` 或字面量（如 `type: 1` / `BOT_STATUS`）。
- **注释**：解释非显然的约束与防御原因（并发竞态、协议行撕裂、路径语义），不写日期化的施工记录。
- **红线**：不得引入 NapCat 源码/类型（GPL 与 MIT 不兼容）；不得在插件进程内 `dlopen`。

## 扩展步骤

新增配置项：

1. `src/config.ts`：接口字段 + `Schema` 描述/默认值。
2. 如有 launch 语义，更新 `src/bot/launch.ts` 与 `resolveLaunchOptions` 的参数映射。
3. 更新 [配置](configuration.md) 表格。
4. 补 launch 纯函数单测（若涉及解析）。

新增发方向动作/元素：

1. `src/actions/elements.ts` 或 `internal.ts` 增加映射/调用。
2. 确认子进程动作表已存在（loader 的 kernel 动作或 OB11 面）；不存在时需上游提供。
3. `src/actions/__tests__` 用 mock request 断言动作名与参数。
4. 更新 [动作桥](../internals/actions.md) 的映射表。

新增收方向元素：

1. `src/events/elements.ts` 正向映射；反向在 `src/actions/elements.ts`。
2. 两个方向的单测都要覆盖（避免只修一半）。
3. 更新 [事件桥](../internals/events.md) 与 [动作桥](../internals/actions.md) 的表格。

新增控制台事件：

1. `src/console/provider.ts`：`declare module` 事件名 + `ctx.console.addListener`。
2. `src/bot/login-panel.ts`：把回调接到 bot 能力。
3. `client/settings.vue` 或子组件：`send(...)` 上行。
4. 更新 [控制台面板](../internals/console.md)。

## 本地联调

1. `pnpm build && pnpm build:client`。
2. `pnpm pack` 产出 tarball；在目标 Koishi 实例里 `pnpm add file:<tarball>`。
3. 验证完切回 registry 版本（`pnpm add koishi-plugin-adapter-napuketto`），不要用 workspace link
   代替真实安装形态——发布形态与 link 形态的路径解析不同。
4. `pnpm pack --dry-run` 检查发布内容应包含 `lib`、`client`、`dist`。

CI（`.github/workflows/ci.yml`）与发布流水线（`.github/workflows/release.yml`）的顺序与门禁见
[发布流程](../operations/release.md)。
