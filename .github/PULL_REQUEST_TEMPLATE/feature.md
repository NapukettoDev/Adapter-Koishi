# PR 说明（新特性 / 功能增强）

> 标题 `feat(<模块>): ……`；写清接口变化与依赖方向，破坏性变更点名迁移方式。空章节写「无」。

## 1. 做什么 / 为什么

<!-- 目标场景与动机：解决谁的什么问题。设计先行：行为或契约变更先更新对应 docs/
     （见 docs/README.md 的文档地图），此处引用它。 -->

## 2. 对外接口

<!-- 新增 / 变更的配置项（`bots` 配置的哪个字段，见 src/config.ts）、收/发元素、控制台事件与面板交互；
     破坏性变更单独点名并给迁移方式。 -->

- 新增：
- 变更：
- 破坏性变更：无

## 3. 实现要点

<!-- 关键设计决策与被否掉的替代方案；涉及层：events / actions / driver / console / config。
     红线复核：插件进程不得 dlopen、不得直接访问 wrapper.node（原生层只在自建宿主子进程内装配）；
     events / actions 不 import koishi 运行时；不新增 Satori 动作面；源码不 import @napuketto/adapter
     与 @napuketto/network；不提供 HTTP / WebSocket 服务。 -->

## 4. 验证

- [ ] 新增用例：文件与用例名（覆盖主路径 + 边界；收 / 发两个方向都要测）
- [ ] `pnpm check` 全绿（biome + tsc，含 `client/tsconfig.json`）
- [ ] `pnpm test` 全绿
- [ ] `pnpm build && pnpm build:client` 通过
- [ ] 新配置项已落在 `src/config.ts`，schema 默认值与运行时兜底一致，并同步 `docs/guides/configuration.md`
- [ ] 事件 / 动作面变化已同步 `docs/internals/events.md` 与 `docs/internals/actions.md` 的表格
- [ ] 控制台事件变化已同步 `docs/internals/console.md`

## 5. 版本与变更记录

<!-- 新能力 → bump minor；兼容性扩展 → bump patch；0.x 阶段破坏性变更 → minor 并在 CHANGELOG 点名迁移方式。 -->

- minor

## 6. 影响面与风险

<!-- 依赖方向是否仍单向、是否引入新依赖、性能与体积影响、koishi 版本兼容性、回滚方式。 -->

## 7. 关联

<!-- 相关 issue / 上游能力 / OneBot 11 或 Koishi 文档链接；无则写「无」。 -->
