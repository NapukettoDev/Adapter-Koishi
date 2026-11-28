# 依赖更新与发布

## 依赖更新

- **Napuketto 发布组**由 `sync-napuketto-deps.yml` 每日检查，也可在 Actions 中手动运行。上游 npm
  发布任务成功后会发出 `napuketto-published` 通知。适配器每次都从 npm registry 读取五个包的
  `latest`，按同一批次解析 manifest 和 lockfile。只有稳定版本、五包的直接锁定版本与目标一致、
  组内传递引用一致，且 frozen-lockfile 可以下载完整产物时，才更新固定分支
  `automation/napuketto-deps` 上的同一条 PR。
- **其它 npm 依赖与 GitHub Actions**继续由 Dependabot 更新。开发宿主（Koishi 与控制台）一起更新，
  前端构建链一起更新，其余开发工具的兼容更新归为一组，跨主版本变更可单独评估。手动检查入口为
  **Insights → Dependency graph → Dependabot → Recent update jobs → Check for updates**。
- pnpm 对 npm 包设置 24 小时发布龄，五个 Napuketto 直系包沿用现有豁免，组外传递依赖仍适用。
  CI 的 frozen-lockfile 安装也校验锁内包的发布龄。Koishi 与控制台 peer 范围由维护者根据宿主兼容性
  修改；开发依赖锁定用于构建与测试的实际宿主版本，CI 拒绝未满足的 peer，并核对宿主更新 PR
  中两个被测版本都匹配 npm `latest`。

无差异时同步任务不提交。registry 不可用、tarball 尚未可取、`latest` 回退或指向预发行版、
上游分批发布造成版本冲突、或 pnpm 解析到不同版本时，任务会记录目标和实际错误并停止。
可在 registry 恢复或整批发布后用 `pnpm run deps:sync --update` 重跑。
同步失败时恢复原 manifest 和 lockfile。工具按 pnpm 返回的 JSON 检查生产依赖树。
现有候选 PR 的编译或 IPC 契约检查失败时，根据 CI 日志协调上游或修正适配器，再运行更新。

## 机器人配置与验收

在 Adapter-Koishi 安装用于更新依赖的 GitHub App，并授予本仓 **Contents: Read and write**
及 **Pull requests: Read and write**。设置 Actions variable `DEPS_APP_CLIENT_ID` 和 secret
`DEPS_APP_PRIVATE_KEY`。生成锁文件的 job 不持有 App 凭据，创建 PR 的 job 只接收
`package.json` 和 `pnpm-lock.yaml`。依赖分支走同样的规则集，App 无需主分支 bypass。

Napuketto 的发布 App 也须安装到 Adapter-Koishi，发布通知只使用对本仓的 **Contents: Write**。
通知失败时可重跑上游通知 job 或从本仓手动发起检查。
首条有实际版本变更的 App PR 应在 Checks 中出现 `build / check / test` 和 `windows (test)`，
其中包括已发布包的 IPC v1 报文、入口与资产检查。Dependabot PR 也走相同门禁。

## npm 发布

从旧版升级前先将 Koishi 的 Node.js 升至 24.11.0 或更高。新的 Napuketto 发布组统一声明此下限，
并延用平台原生宿主的 IPC v1。回滚时按适配器版本恢复整组 npm 依赖，不混装不同发布组。

维护者在发布 PR 中更新 `package.json` 版本和 `CHANGELOG.md`。合并后
`release.yml` 检查 npm 是否已有该版本。未发布时依次使用 frozen lockfile 安装、构建后端及控制台、
静态检查、测试和 `pnpm pack`。实际发布 job 通过 `release` environment 审批获取 npm OIDC 权限，
发布准备阶段交付的同一份 npm tarball。

环境部署分支限制为 `main`。npm 信任配置须匹配仓库 `NapukettoDev/Adapter-Koishi`、
工作流 `release.yml` 与环境 `release`。OIDC 失败时检查 publish job 的 token exchange 日志。
可在 Actions 中重跑失败的发布；检测到版本已存在时会跳过。依赖 PR 由维护者审查合并，
发布仍经过环境审批。
