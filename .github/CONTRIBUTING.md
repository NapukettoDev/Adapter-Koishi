# 贡献指南

> 本页只做跳板。完整开发环境、构建顺序、测试边界、PR 与 CI 说明见
> [docs/guides/development.md](../docs/guides/development.md)。

## 开始之前

1. 读 [AGENTS.md](../AGENTS.md)（红线 / 依赖 / 流程）与 [docs/README.md](../docs/README.md)（路由）。
2. 装 Node.js 24 与 pnpm 12（根 `package.json` 的 `packageManager` 已锁定版本），执行 `pnpm install`。

## 提交前

```bash
pnpm build && pnpm build:client   # tsc 走 NodeNext 解析 @napuketto/* 的 exports，build 必须前置
pnpm check                        # biome + tsc（含 client/tsconfig.json）
pnpm test                         # vitest 全量
```

日常改单点逻辑时先跑单文件：`pnpm exec vitest run <文件> --reporter=dot`。涉及发布形态的改动
加跑 `pnpm pack --dry-run`，核对清单含 `lib` / `client` / `dist`、不含 `src`。

版本号在 PR 里手工 bump，并在 `CHANGELOG.md` 写对应条目（本仓不使用 changesets；发布由合并
`main` 后的 `release.yml` 接管）。

## PR

一切改动走 PR（分支 → PR → CI `build / check / test` 与 `windows (test)` 全绿 → squash 合并），
禁止直推 `main`。提交信息用 `type(scope): 描述`（`feat` / `fix` / `docs` / `refactor` / `chore` /
`ci` / `build`），描述用中文，如 `fix(driver): 修正心跳超时后的重连判定`。

PR 模板按领域拆（修复 / 特性 / 文档 / 依赖 / 重构与性能 / 发布），不会被自动带入；用
`gh pr create --template <文件名>` 或 compare URL 的 `?template=` 指定，清单见
[PULL_REQUEST_TEMPLATE](./PULL_REQUEST_TEMPLATE)。

## 许可证

MIT，零引入 GPL 源码与类型（含 NapCat）；不修改 QQ 安装目录的任何文件（原生层只在自建宿主
子进程内装配）。参与即同意 [行为准则](./CODE_OF_CONDUCT.md)；漏洞按 [安全政策](./SECURITY.md)
私下报告。
