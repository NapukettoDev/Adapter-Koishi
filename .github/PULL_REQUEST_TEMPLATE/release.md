# PR 说明（发布）

> 标题 `build(release): ……`；本模板只管版本 bump 与发布面字段——真正发版在合并 `main` 后由
> release.yml 自动完成（registry 无该版本 → prepare → `release` environment 审批 → OIDC 发布），
> 不走 PR 手工发包。空章节写「无」。

## 1. 改了什么

<!-- 改的是发布链哪一环（detect / prepare / publish）、version bump、CHANGELOG，还是发布面字段。 -->

## 2. 发布面影响

- 版本：`package.json` 的 `version`（旧 → 新）：
- 影响的字段：`files` / `exports` / `main` / `types` / `peerDependencies` / `publishConfig`
- 是否影响 `dist`（控制台前端）与 `lib`（CJS bundle）的产物名 —— 控制台产物文件名不可改（`console-entry.ts` 按清单复制，改名即 404）：
- 是否需要同步 bump `@napuketto/*` 依赖范围（`~` 范围，见发布流程「与其他仓的关系」）：
- npm 信任配置 / `release` environment 是否变化（OIDC claim 必须与 `--file release.yml --environment release` 一致）：

## 3. 验证

- [ ] `pnpm check` 全绿（biome + tsc，含 `client/tsconfig.json`）
- [ ] `pnpm test` 全绿
- [ ] `pnpm build && pnpm build:client` 通过
- [ ] `pnpm pack --dry-run` 核对发布内容：含 `lib` / `client` / `dist`，**不含 `src`**
- [ ] 需要预演 npm 侧打包视图时用 `npm publish --dry-run`（只读，不会真正发布）
- [ ] `CHANGELOG.md` 已加对应版本条目（合并即触发发布，条目不能事后补）

## 4. 版本与变更记录

<!-- 发布类 PR 必带：version bump（按语义化版本）+ CHANGELOG 条目。 -->

## 5. 影响面与风险

<!-- 发布面回归的后果（下游解析失败 / 缺控制台产物 / require 失败）、是否需要下游重新安装、
     回滚方式（registry 已发布版本不可撤回，只能发新补丁版本）。 -->

## 6. 关联

<!-- 相关 issue / 上一个发布 PR；无则写「无」。 -->
