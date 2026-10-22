# 发布流程

**一切发布走 `.github/workflows/release.yml`，禁止本地 `npm publish`。** 本仓是单包
（`koishi-plugin-adapter-napuketto`），没有 changesets：版本号在 PR 里手工 bump，合并进 `main`
后由 CI 判断 registry 上是否已有该版本，没有就构建、测试，并在 `release` environment 审批后走
**npm OIDC 可信发布**（无长期 token，自动 provenance）。

## 日常发布

1. 在功能 PR 中：
   - 把 `package.json` 的 `version` bump 到新版本；
   - 在 `CHANGELOG.md` 增加对应条目；
   - 合并进 `main`。
2. `release.yml` 自动触发：

| Job | 内容 |
| :--- | :--- |
| `detect` | `npm view <pkg>@<version>`：命中 → 整轮跳过；`E404` → 继续；其他错误（网络/鉴权）→ 显式失败，不能当成“未发布”重发 |
| `prepare` | `pnpm install --frozen-lockfile` → `pnpm build && pnpm build:client` → `pnpm check` → `pnpm test` → 打包工作区 artifact（排除 `node_modules` / `.git`，保留 30 天） |
| `publish` | 停在 `environment: release` 等待审批；批准后先把 npm 升级到 11（OIDC 需 ≥ 11.5.1），再在解包后的工作区执行 `npm publish --access public`（OIDC，自动 provenance） |

3. 验证：

```bash
npm view koishi-plugin-adapter-napuketto version dist.attestations --json
```

存在 `dist.attestations` 即经 OIDC 发布并带 provenance。

**重跑幂等**：发布失败的版本仍未进 registry，`workflow_dispatch` 重跑会再次尝试；已发布版本被
`detect` 跳过。

**为什么拆 `prepare` / `publish`**：npm 可信发布把发布权授给“能让 `release.yml` 在 `main` 上跑起来
的代码”。构建期可执行的内容（`package.json` 脚本、`tsdown.config.ts`、`vite.config.client.ts`）
不能与 OIDC token 同处一个 job。因此 `publish` 不跑 install、不跑任何构建脚本，只解包 artifact 并
`npm publish`；权限上 `prepare` 只有 `contents: read`，`publish` 才有 `id-token: write`。

## 一次性仓库配置

以下均为仓库/registry 设置，不在代码中：

1. **Environment**：Settings → Environments 建 `release`，勾 Required reviewers；
   Deployment branches 限制为 `main`。名字必须与 npm 信任配置的 environment claim 严格同名。
2. **npm 信任配置**（逐包）：

   ```bash
   npm login   # npm CLI ≥ 11.15
   npm trust github koishi-plugin-adapter-napuketto \
     --file release.yml --repo NapukettoDev/Adapter-Koishi \
     --environment release --allow-publish --yes
   ```

   - 新建配置必须在 **2 天内**完成首次成功发布，否则失效且不可编辑；只能
     `npm trust revoke <包名> --id <id>` 后重建。
   - 核对：`npm trust list koishi-plugin-adapter-napuketto` 应显示
     `file=release.yml` / `repo=NapukettoDev/Adapter-Koishi` / `env=release` / 仅 publish。
3. **`repository.url` 必须指向本仓**：provenance 会校验 `package.json` 的 repository 与 OIDC token
   的仓库一致；不一致会得到 `422 Failed to validate repository information`。
4. **分支规则集**（保护 `main`）：PR（1 审批 + code owner review + 只允许 squash）、merge queue、
   required linear history、required signatures、CodeQL（medium 及以上），必需状态检查：
   - `build / check / test`
   - `windows (test)`

   job name 就是 ruleset 的检查 context，改名必须同步改规则集。`ci.yml` 的 `merge_group` 触发不可
   省——merge queue 只认在队列临时 ref 上跑出来的检查。bypass 只放 Repository admin；本仓没有 CI
   向 `main` 写提交的路径，不需要 GitHub App。

## 排障

| 现象 | 原因 / 处理 |
| :--- | :--- |
| `422 Failed to validate repository information` | `repository.url` 与 `NapukettoDev/Adapter-Koishi` 不一致（改名/转移 owner 的常见坑）。改成 `git+https://github.com/NapukettoDev/Adapter-Koishi.git` 后重跑 |
| `ENEEDAUTH need auth` | OIDC 模式下不代表没登录。npm 换 token 失败时只写 verbose 日志然后静默退回无凭证发布。发布步骤已开 `NPM_CONFIG_LOGLEVEL=verbose`；看 `POST .../oidc/token/exchange/package/<包名>`：404 = 没有匹配的信任配置（没配 / claim 不符 / 已过期） |
| `E409 Cannot publish over previously staged version` | 该版本在 npm 暂存区等待批准（暂存版本不在 registry versions 里，重跑必然再 409）。到 npmjs.com 的 Staged Packages 批准或拒绝，或 `npm stage list/approve/reject` |
| `EBADDEVENGINES Invalid name "pnpm" does not match "npm"` | npm ≥ 11.5 会校验 `devEngines`；本包已改用标准 `packageManager: "pnpm@12.4.1"`（npm 忽略该字段，pnpm 由 corepack 钉住）。**不要改回 `devEngines`** |
| 发布成功但 `npm view` 404 | `npm publish` 可能只返回 202「processing」，版本要一两分钟才可见；直接查 `https://registry.npmjs.org/<包名>/<版本>` 比 packument 更快，不要立刻重发 |
| 审批拖太久后 publish 取不到 artifact | artifact 保留 30 天；过期后 `workflow_dispatch` 重跑（`detect` 会重新判断版本仍未发布） |

## 本地演练

```bash
pnpm build && pnpm build:client
pnpm check && pnpm test
pnpm pack --dry-run          # 检查发布内容
npm publish --dry-run        # 只查看 npm 侧打包视图，不会真正发布
```

不要在本地真正 `npm publish`：会绕过 environment 审批与 OIDC 信任链，且没有 provenance。

## 与其他仓的关系

- 依赖 `@napuketto/*` 使用 npm 已发布版本（`~` 范围），与本仓发布节奏独立；上游 NapukettoQQ
  发版后按需在本仓 bump 依赖范围，走正常 PR。
- 本仓不引入 changesets：单包手工 bump 已足够；CI 不向 `main` 写版本提交。
- 若发布形态或依赖形态变化（例如重新引入内部 bundle），必须同步更新
  [开发与构建](../guides/development.md) 与 [架构总览](../architecture/overview.md)。
