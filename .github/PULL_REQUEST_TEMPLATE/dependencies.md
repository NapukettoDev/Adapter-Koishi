# PR 说明（依赖变更）

> 标题 `chore(deps): ……`；Dependabot 的 PR 也按此填。空章节写「无」。

## 1. 类型与范围

- [ ] 依赖升版（minor / patch）
- [ ] 依赖升版（major，已读过上游 breaking change）
- [ ] 依赖新增 / 移除 / 替换
- [ ] `@napuketto/*` 上游版本范围调整（`~` 范围，见 [发布流程](../../docs/operations/release.md)「与其他仓的关系」）
- [ ] 工程配置调整（`packageManager` / `pnpm-workspace.yaml` 的 `allowBuilds` / `minimumReleaseAgeExclude`）

涉及依赖（名 → 旧版本 → 新版本）：

## 2. 改动内容

<!-- 声明位置（package.json 的 dependencies / devDependencies / peerDependencies）+ pnpm-lock.yaml 是否随之变化。
     新增依赖写清用途与许可证；移除依赖写清原调用点迁到了哪里。 -->

## 3. 红线与纪律复核

- [ ] 许可证兼容：新增依赖为 MIT 等宽松许可，未引入 GPL 源码 / 类型（含 NapCat）
- [ ] `@napuketto/*` 仍在 `dependencies` 且被 tsdown 保持 external（`deps.bundle: false`），未被打进 `lib`
- [ ] 依赖方向未被打穿：源码不 import `@napuketto/adapter` / `@napuketto/network`（只把磁盘入口路径交给子进程）
- [ ] `package.json` 的 `files` 仍只含 `lib` / `client` / `dist`，未因新依赖扩大发布面
- [ ] 未绕过 `minimumReleaseAge`：刚发布的版本要放行时，必须写进 `pnpm-workspace.yaml` 并写明原因
- [ ] 改了 `package.json` / `pnpm-workspace.yaml` 时，`pnpm-lock.yaml` 已一并提交

## 4. 验证

- [ ] `pnpm install` 后 `pnpm-lock.yaml` 的 diff 已人工复核（版本未回退、无意外新增传递依赖）
- [ ] `pnpm audit --prod --audit-level=high` 无新增 high / critical（手工核对；本仓 CI 无 audit job）
- [ ] `pnpm check` 全绿（biome + tsc，含 `client/tsconfig.json`）
- [ ] `pnpm test` 全绿
- [ ] `pnpm build && pnpm build:client` 通过
- [ ] `pnpm pack --dry-run` 的清单仍含 `lib` / `client` / `dist`，不含 `src`
- [ ] 行为等价性证据：上游 changelog 要点 / 相关用例 / 关键路径实测（`@napuketto/*` 升版必填）

## 5. 版本与变更记录

<!-- 发布面或运行时行为变化 → bump 版本 + CHANGELOG.md 条目；纯 devDependencies / 工具链 → 「无」。 -->

## 6. 影响面与风险

<!-- 运行时兼容性（Node 24 / koishi peer 范围）、产物体积、是否需要下游重新 `pnpm install`、
     koishi 的解析路径（main / exports.default）是否变化、回滚方式。 -->

## 7. 关联

<!-- 上游 release / commit / issue 链接、Dependabot PR 编号；无则写「无」。 -->
