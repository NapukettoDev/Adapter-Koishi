# koishi-plugin-adapter-napuketto 工程指南

> **上下文省流铁律（必读）**：
> 1. **按需读文档**：严禁开局通读 `docs/`！只按「文档地图」读当前改动涉及的那一篇；涉及跨层契约
>    变更时才读 `docs/architecture/`。
> 2. **禁止全量刷屏**：验证优先针对单个测试文件，用 `--reporter=dot` 压掉明细
>    （如 `pnpm exec vitest run tests/unit/bridge/events/adapt.test.ts --reporter=dot`）；严禁无脑
>    `pnpm test` 把几百行 Pass 日志灌进上下文。
> 3. **不读生成物**：`lib/`、`dist/`、`node_modules/` 是构建产物与第三方代码，不要通读；行为以
>    `src/`、`client/` 和配置文件为准，跨包契约看 `@napuketto/*` 的公开类型。

## 项目概览

`koishi-plugin-adapter-napuketto`：NapukettoQQ 的 Koishi 适配器，让 Koishi 直接驱动 QQ NT
（自研 `wrapper.node` 协议层），零外部协议端、零网络端口。每个 QQ 账号对应一个自建宿主子进程，
插件通过 stdin/stdout 的 JSON Lines（IPC v1）编排子进程，并把 kernel 事件 / 动作翻译成 Koishi
的 session / 动作。

技术栈：单包工程 + pnpm 12.4.1 + Node 24（CI 基线）+ TypeScript 7（ESM / NodeNext）+ tsdown
（CJS 产物）+ Vue 3（控制台前端）+ Biome / ESLint / Vitest；MIT，包名
`koishi-plugin-adapter-napuketto`（单包，无 changesets，版本号在 PR 中手工 bump）。

能力边界：翻译消息、撤回、群成员变动、好友与入群申请。成员变动和请求依赖 OB11 动作桥，
`bot.onOb11()` 保留原始订阅。支持的载荷与字段见 `docs/internals/events.md`。消息收方向支持
`text` / `at` / `image` / `face` / `voice` / `reply`，发方向额外支持 `video`；不提供 Satori 动作面，
不提供 `session.onebot.*` 驼峰兼容糖。

## 硬性约束（违反 = 错误）

1. **许可证与原创**：MIT。严禁引入 NapCat 或其他 GPL 源码 / 类型（GPL 与 MIT 不兼容）；实现必须原创。
2. **原生与进程边界**：插件进程**禁止** `dlopen` / 直接访问 `wrapper.node`。原生层只在自建宿主子进程内
   由 `@napuketto/loader` + `@napuketto/kernel` 装配；插件只做进程编排、登录状态观察和两端语义翻译。
   **零磁盘篡改**：不修改 QQ 安装目录的二进制。
3. **依赖方向**：
   - 插件 → `@napuketto/kernel` / `loader` / `media`（真实 `dependencies`，构建时 external，不 bundle）；
   - `@napuketto/adapter` / `@napuketto/network` **不在源码中 import**，只把磁盘入口路径交给子进程，
     由 loader 在子进程内装配 OB11 动作面；
   - `driver` 不认识 loader（launch 由 Bot 注入）；`events` / `actions` 不 import koishi 运行时；
     `bot` 组装控制台，其他层不依赖 `console`；`console` 不依赖 `bot`、`runtime` 或 `bridge`；
   - 不提供 HTTP / WebSocket 服务，不监听网络端口。
4. **IPC 契约单一来源**：消息类型、payload schema、`IPC_VERSION` 一律来自 `@napuketto/loader`，
   插件侧 `src/runtime/ipc/index.ts` 只 re-export；**禁止复制定义或自造一套协议**。
5. **发布形态**：`tsdown.config.ts` 设置 `deps.bundle: false`，`@napuketto/*` 与 koishi 生态全部
   external——子进程运行时要读磁盘上的 `self-host.cjs`、stub `QQNT.dll`、kernel 入口，bundle 会丢资产。
   产物固定为 `lib/index.cjs` + `lib/index.d.cts`、`dist/index.js` + `dist/index.css`；控制台产物文件名
   不可改（`src/console/entry.ts` 按清单复制，改名即 404）。`files` 只发布 `lib` / `client` / `dist`，不含 `src`。
6. **配置与账号一致性**：配置 schema 唯一来源 `src/config.ts`（`selfId` 必填），schema 默认值与运行时
   兜底必须一致。`selfId` 同时是账号数据目录边界；登录成其他 QQ 号必须拒绝上线（`src/bot/lifecycle.ts`），
   严禁“将就用实际 uin”。
7. **测试边界**：单测**不加载 koishi 运行时**（会初始化 loader 并直接崩溃）。可测逻辑必须是纯函数 /
   依赖注入；`bot.ts`、`message.ts`、`assembly.ts`、`config.ts`、`console/provider.ts`、
   `index.ts` 不进单测（见 `docs/guides/development.md#测试边界`）。
8. **范围禁区**：不引入 changesets；不做本地 `npm publish`；不新增 Satori 动作面；事件转换须有
   上游载荷与 Koishi 契约依据；不为扩展协议去改 `@napuketto/network` / `kernel` 行为。

## 代码风格与红线

- **Biome（`src/` 源码与 `tests/` 下的 TypeScript）**：4 空格、LF、100 列、双引号、分号、尾逗号；`noFloatingPromises = error`；
  import 组织走 Biome assist。`client/` 与根配置文件不在 Biome 范围。
- **TS 两套 strict**（根 `tsconfig.json` / `client/tsconfig.json`）：`noUncheckedIndexedAccess`、
  `exactOptionalPropertyTypes`、`verbatimModuleSyntax`、`noUnusedLocals/Parameters`、
  `noImplicitReturns`、`noPropertyAccessFromIndexSignature`；禁止裸 `any`（特例必须注释）。
- **模块系统**：ESM + NodeNext；相对 import 必须带 `.js` 后缀；类型一律 `import type`。
- **可选属性**：`exactOptionalPropertyTypes` 下用条件展开
  `...(x !== undefined ? { x } : {})`，不要显式赋 `undefined`。
- **`const enum` 不可用**：`Universal.Channel.Type` / `Universal.Status` 在 `verbatimModuleSyntax`
  下无法访问，用 `src/shared.ts`（如 `BOT_STATUS`）或字面量。
- **barrel 最小化**：`index.ts` 只 re-export 有消费者的符号；内部类型让消费方直接从 `types.js` 引入，
  避免死导出。
- **错误与日志**：业务抛类型化错误（`IpcError` / `KernelError` 等），禁止静默吞错；日志走 bot logger
  （reggol，受 `logLevel` 控制），严禁打印票据、凭证或二维码 base64。
- **注释**：解释非显然的约束与防御原因（并发竞态、协议行撕裂、路径语义），不写日期化的施工记录。
- **前端**：`client/**/*.vue` 依赖 ESLint（`pnpm lint:client`），但该命令当前不可用
  （`@typescript-eslint/parser` 尚不支持 TS 7）；改前端以 `pnpm check` 里的 client `tsc` 为准。
- **fallow**：`.fallowrc.jsonc` 的豁免必须写明根因，不得借机放松重复 / 复杂度阈值。

## 开发工作流（省上下文模式）

1. **设计先行**：行为或契约变更先更新对应 `docs/`。文档红线（`docs/README.md`「文档原则」）：
   代码即事实、单篇单主题、只写现行机制、路径相对仓库根；**禁止**日期化进度记录、待办清单和
   超过 15 行的 JSON 样本。
2. **精准门禁命令**（严禁直接跑全量 `pnpm test` 或失效脚本）：
   ```bash
   pnpm install
   pnpm check                                   # biome + tsc(src) + tsc(client/tsconfig.json)
   pnpm exec vitest run <文件> --reporter=dot    # 日常单文件测试
   pnpm exec biome check --write src            # 自动修格式 / import（随后再跑 pnpm check）

   # 交卷前按 CI 顺序全量验证（CI：install → build → check → test）
   pnpm build && pnpm build:client && pnpm check && pnpm test
   pnpm pack --dry-run                          # 发布内容自检（应含 lib / client / dist，不含 src）
   ```
   已知失效 / 禁用：`pnpm test:coverage`（未安装 coverage provider）、`pnpm lint:client`（见上）、
   本地 `npm publish`（见发布流程）。
3. **扩展落点**：
   - 新配置项：`src/config.ts`（接口 + Schema）→ 涉及 launch 时同步 `src/bot/launch.ts` →
     更新 `docs/guides/configuration.md` → 补 `resolveLaunchOptions` 纯函数单测。
   - 新发向动作 / 元素：`src/bridge/actions/elements.ts` / `internal.ts` → 用 mock request 断言动作名与参数 →
     更新 `docs/internals/actions.md`；子进程动作表没有的能力需上游提供，不在本仓硬造。
   - 新收向元素：`src/shared.ts` 正向映射 + `src/bridge/actions/elements.ts` 反向映射，两个方向都要测，
     并同步 `docs/internals/events.md` 与 `actions.md` 的表格。
   - 新控制台事件：`src/console/provider.ts` → `src/console/panel.ts` → `client/settings.vue` 或子组件 →
     更新 `docs/internals/console.md`。
4. **本地联调**：`pnpm build && pnpm build:client` → `pnpm pack` → 目标 Koishi 实例
   `pnpm add file:<tarball>`。**禁止用 workspace link 代替真实安装形态**（路径解析不同），验证完切回
   registry 版本。
5. **提交**：Conventional Commits（`feat` / `fix` / `docs` / `refactor` / `chore` / `ci` / `build`），
   描述用中文，如 `fix(driver): ...`、`chore(release): 发布 x.y.z`。改动 `package.json`、
   `pnpm-workspace.yaml` 或依赖范围时，必须同步提交更新后的 `pnpm-lock.yaml`（`pnpm install` 生成，
   不要手改）。
6. **PR 与发布**：一切改动走 PR（1 审批 + CODEOWNERS + 只允许 squash + linear history）；必需状态检查是
   `build / check / test` 与 `windows (test)`，`ci.yml` 的 `merge_group` 触发不可删（job 名即 ruleset
   context，改名须同步规则集）。版本在 PR 中手工 bump 并写 `CHANGELOG.md`；合并 `main` 后由
   `release.yml` 走 npm OIDC 可信发布（`release` environment 审批），**禁止本地 `npm publish`**。

## 文档地图（按需读，禁止通读）

| 改动 / 问题 | 先读 |
| :--- | :--- |
| 整体定位、边界、依赖方向、目录结构 | `docs/architecture/overview.md` |
| 启动 → 上线、重登、账号一致性 | `docs/architecture/lifecycle.md` |
| launch / driver / 心跳 / 重启 / IPC 协议 | `docs/internals/runtime.md` |
| 收方向：kernel 事件 → koishi session、元素映射 | `docs/internals/events.md` |
| 发方向：koishi 动作 → kernel / OB11、媒体管线 | `docs/internals/actions.md` |
| Bot 装配、dispatch、MessageEncoder、数据库预热 | `docs/internals/bot.md` |
| 控制台登录面板（后端 Provider + 前端） | `docs/internals/console.md` |
| 配置项、默认值、数据目录、多账号 | `docs/guides/configuration.md` |
| 环境、命令、构建产物、检查与测试边界 | `docs/guides/development.md` |
| 按现象排障（不上线、无响应、媒体、日志） | `docs/guides/troubleshooting.md` |
| 发布流水线、OIDC、仓库设置与排障 | `docs/operations/release.md` |
