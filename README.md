
</div>

<div align="center">
<h1 id="Adapter-Napuketto">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/wordmark-dark.svg">
    <img src=".github/assets/wordmark-light.svg" alt="NapukettoQQ Koishi Adapter" width="800">
  </picture>
</h1>
<p>
  <a href="https://github.com/NapukettoDev/Adapter-Koishi/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/NapukettoDev/Adapter-Koishi/ci.yml?style=flat-square&label=CI" alt="CI"></a>&emsp;
  <a href="https://www.npmjs.com/package/koishi-plugin-adapter-napuketto"><img src="https://img.shields.io/npm/v/koishi-plugin-adapter-napuketto?style=flat-square&label=npm&color=cb3837" alt="npm"></a>&emsp;
  <a href=""><img src="https://img.shields.io/badge/Koishi-%5E4.18.7-5546a3?style=flat-square" alt="Koishi"></a>&emsp;
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License"></a>
</p>
</div>

---

## 快速开始

### 安装

我们建议直接通过 Koishi 的插件市场进行安装

但是你也可以直接使用命令
```bash
npm install koishi-plugin-adapter-napuketto
# 或使用 pnpm add / yarn add
```

### 配置

你可以在Koishi控制台进行可视化配置

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `selfId` | `string` | **必填** | 登录的 QQ 号 |
| `dataDir` | `string` | 自动解析 | 数据与缓存根目录 |


<details>
<summary><b>或通过编辑`koishi.yml`</b></summary>

插件本身留空，账号配置挂在 `bots` 下（平台名为 `onebot`）：

```yaml
plugins:
  adapter-napuketto: {}

bots:
  # 推荐：key 带 QQ 号，天然支持多账号
  onebot:123456789:
    selfId: "123456789"

  # 单账号也可省略 key 后缀：
  # onebot:
  #   selfId: "123456789"
```
</details>

<br>

完整配置项、默认值与多账号说明见 [配置文档](./docs/guides/configuration.md)。

---

## 参与开发

本仓库独立维护，依赖NPM上已发布的 `@napuketto/*` 包

```bash
pnpm install
pnpm check       # Biome + tsc
pnpm test        # Vitest
pnpm build       # tsdown → lib/index.cjs
pnpm build:client
```

* **发布形态**：`lib/index.cjs`（CJS 入口）；`@napuketto/*` 与 koishi 生态按 external 处理，由 npm 安装提供；控制台前端单独构建到 `dist/`。
* **源码开发**：`exports.development` 指向 `src/index.ts`（仅仓库内有效，发布包不含 `src`）；Koishi 以 `require()` 加载时通常走 `lib/index.cjs`，联调前先 `pnpm build`。
* **本地联调**：`pnpm pack` 出 tarball 后 `pnpm add file:<tarball>`，验证完切回 registry 版本；不要用 workspace link。

> [!NOTE]
> `pnpm lint:client`（ESLint 检查 `.vue`）暂不可用：`@typescript-eslint/parser` 尚不支持 TypeScript 7；它不在 `pnpm check` 内。

---

## 生态与导航

* **文档**：[文档索引](./docs/README.md) ｜ [架构总览](./docs/architecture/overview.md) ｜ [配置](./docs/guides/configuration.md) ｜ [排障](./docs/guides/troubleshooting.md) ｜ [发布流程](./docs/operations/release.md) ｜ [更新日志](./CHANGELOG.md)
* **上游**：[NapukettoQQ 主仓](https://github.com/NapukettoDev/NapukettoQQ) ｜ [架构书](https://github.com/NapukettoDev/NapukettoQQ/blob/main/docs/architecture.md)

---

## 状态

<p align="center">
  <img src="https://repobeats.axiom.co/api/embed/9b46708d053b4cb9a00499859f73bad400d7b956.svg" alt="Repobeats analytics image">
</p>

## English

`koishi-plugin-adapter-napuketto` is the [Koishi](https://koishi.chat) adapter for [NapukettoQQ](https://github.com/NapukettoDev/NapukettoQQ). Each QQ account runs in a dedicated self-hosted Node.js child process; kernel events are bridged to Koishi sessions and Koishi actions to kernel API calls — no external WebUI or separate protocol server required.
