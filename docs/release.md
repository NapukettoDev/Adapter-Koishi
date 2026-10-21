# 发布流程（RELEASE）

> **铁律：一切发布走 `release.yml`，禁止手动 `npm publish`。** 本仓单包，
> 版本号在 PR 里手工 bump；合并进 main 后由 CI 判断 registry 上有没有该版本，
> 没有就构建、测试并在 `release` environment 审批后走 **npm OIDC 可信发布**
> （无长期 token，自动 provenance）。PR 纪律与主仓一致：一切改动走 PR。

## 1. 日常发布

1. 在功能 PR 里把 `package.json` 的 `version` bump 到新版本（同时更新
   `CHANGELOG.md`），合并进 main。
2. Release 工作流自动触发：
   - `detect`：查 registry，版本已存在 → 整轮跳过；不存在 → 继续。
   - `prepare`：`pnpm install --frozen-lockfile` → `pnpm build && pnpm build:client`
     → `pnpm check` → `pnpm test`，打包 artifact（无 OIDC token）。
   - `publish`：停在 `environment: release` 审批；批准后 `npm publish`（OIDC，
     自动 provenance）。不跑 install、不跑构建脚本。
3. 验证：`npm view koishi-plugin-adapter-napuketto version dist.attestations --json`
   —— 有 `dist.attestations` 即经 OIDC 发布并带 provenance。

重跑幂等：发布失败的版本仍未进 registry，`workflow_dispatch` 重跑会再次尝试；
已发布的版本会被 `detect` 直接跳过。

## 2. 一次性配置（仓库侧，非代码）

1. **Environment**：Settings → Environments 建 `release`，勾 Required reviewers，
   Deployment branches 限制为 `main`。名字必须与 npm 信任配置的 environment
   claim 严格同名。
2. **npm 信任配置**（逐包；本仓只有 `koishi-plugin-adapter-napuketto`）：

   ```bash
   npm login   # npm CLI ≥ 11.15
   npm trust github koishi-plugin-adapter-napuketto \
     --file release.yml --repo NapukettoDev/Adapter-Koishi \
     --environment release --allow-publish --yes
   ```

   - **两天过期**：新建配置必须在 2 天内完成首次成功发布，否则失效且不可编辑，
     只能 `npm trust revoke <包名> --id <id>` 后重建。配完当天就发。
   - 核对：`npm trust list koishi-plugin-adapter-napuketto` 应看到
     file=release.yml / repo=NapukettoDev/Adapter-Koishi / env=release / 仅 publish。
3. **`repository.url` 必须指向本仓**：provenance 会校验 package.json 的
   repository 与 OIDC token 的仓库一致；不一致时 registry 回
   `422 Failed to validate repository information`。

## 3. 排障

- **422 provenance**：`repository.url` 与 `NapukettoDev/Adapter-Koishi` 不一致
  （改过仓名/转移过 owner 的常见坑）。改成
  `git+https://github.com/NapukettoDev/Adapter-Koishi.git` 后重跑。
- **ENEEDAUTH `need auth`**：OIDC 模式下不代表没登录。npm 换 token 失败时只写
  verbose 日志然后静默退回无凭证发布。发布步骤已开 `NPM_CONFIG_LOGLEVEL=verbose`，
  看 `POST .../oidc/token/exchange/package/<包名>`：404 = 该包没有匹配的信任配置
  （没配 / claim 不符 / 已过期）。
- **E409 `Cannot publish over previously staged version`**：该版本在 npm 暂存区
  等待批准（暂存版本不在 registry 的 versions 列表里，重跑必然再 409）。到
  npmjs.com 的 Staged Packages 批准或拒绝，或 `npm stage list/approve/reject`。
- **EBADDEVENGINES `Invalid name "pnpm" does not match "npm"`**：npm ≥ 11.5 会在
  任何命令前校验 `devEngines`，本包声明 `packageManager: pnpm`（`onFail: download`
  被 npm 当作 error），于是 `npm publish` 连 OIDC 都走不到就退出。publish job 已在
  解包副本里摘掉 `devEngines`（仓库里的 `package.json` 不动）；本地演练同理，见 §4。
- **artifact 过期**：审批拖过 30 天后 publish 取不到产物，直接
  `workflow_dispatch` 重跑（detect 会重新判断版本仍未发布）。

## 4. 本地演练

```bash
pnpm build && pnpm build:client
pnpm check && pnpm test
```

包内容检查走 `pnpm pack --dry-run`（不经过 npm 的 devEngines 校验）；非要
`npm publish --dry-run` 就先临时删掉 `devEngines`，别提交那个改动。

不要在本地真正 `npm publish`：会绕过 environment 审批与 OIDC 信任链，且
provenance 缺失。

## 5. 与其他仓的关系

- 依赖的 `@napuketto/*` 用 npm 已发布版本（`~` 范围），与本仓发布节奏独立；
  主仓发版后按需在本仓 bump 依赖范围，走正常 PR。
- 本仓不引入 changesets：单包手工 bump 已足够；需要自动升版本时再评估。
