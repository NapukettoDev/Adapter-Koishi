# 安全政策

> [跳转到英文版（English Version）](#english-version)

## 支持的版本

`koishi-plugin-adapter-napuketto` 处于 0.0.x 早期阶段，API 未冻结。安全更新仅针对最新发布版本提供，
以补丁版本的形式通过 `.github/workflows/release.yml`（npm OIDC 可信发布）发布。

| 版本线 | 支持情况 |
| ------ | -------- |
| 0.0.x（当前发布线） | 支持 |
| 已被取代或停止维护的旧版本 | 不支持 |

## 报告漏洞

请通过以下方式报告漏洞：

* **首选**：使用 GitHub 的私有漏洞报告功能——进入本仓库 **Security** 标签页 → **Report a
  vulnerability**，填写漏洞详情。该渠道对维护者与报告者均可见，漏洞细节不会公开暴露。
* **备选**：发送邮件至 `oppenheymu@gmail.com`（与行为准则中一致的联系邮箱），请在主题中注明
  「Security」。

报告后的流程与预期：

* 我们通常会在 **48 小时内**确认收到报告，并给出初步评估。
* 确认有效的漏洞将以补丁版本修复，并记录于 `CHANGELOG.md`；在修复落地前，我们不会公开漏洞细节，
  以免影响未升级的用户。
* **请不要**在公开渠道（Issues、讨论区、社交媒体等）披露尚未修复的漏洞细节。

### 范围说明

* 本仓适配层在范围内：子进程编排与 IPC、kernel 事件 / 动作 ↔ Koishi session / 动作 的翻译、
  媒体管线、控制台登录面板、配置解析与账号一致性校验。
* 上游 `@napuketto/kernel` / `loader` / `media` / `adapter` 的问题：请在报告中说明是否可复现于
  本仓；本仓会转给上游，不在此重复实现修复。
* 腾讯 QQ 客户端本体（`wrapper.node` 等）自身的问题不属本项目范围，请向腾讯报告；但若本项目的
  引导 / 载具方式放大了其风险，欢迎报告。
* 本项目承诺零磁盘篡改（不修改 QQ 安装目录任何文件），原生层只在自建宿主子进程内装配，
  漏洞相关行为均为运行期内存操作；若发现违背该承诺的途径，请作为高危报告。

---

<a id="english-version"></a>

# Security Policy

## Supported Versions

`koishi-plugin-adapter-napuketto` is in its early 0.0.x stage; the API is not frozen yet. Security
updates are provided for the latest released version only, shipped as patch releases through
`.github/workflows/release.yml` (npm OIDC trusted publishing).

| Version | Supported |
| ------- | --------- |
| 0.0.x (current release line) | Yes |
| Superseded or unmaintained versions | No |

## Reporting a Vulnerability

Please report vulnerabilities through the following channels:

* **Preferred**: use GitHub's private vulnerability reporting — go to the **Security** tab of this
  repository → **Report a vulnerability** and fill in the details. The channel is visible to
  maintainers and reporters only, and vulnerability details are not exposed publicly.
* **Alternative**: send an email to `oppenheymu@gmail.com` (same contact as in the Code of Conduct),
  with "Security" noted in the subject line.

What to expect after reporting:

* We typically **acknowledge receipt within 48 hours** and provide an initial assessment.
* Confirmed vulnerabilities are fixed in a patch release and recorded in `CHANGELOG.md`; until the fix
  lands, we will not disclose details publicly, so that users who have not yet upgraded are not
  exposed.
* **Please do not** disclose details of unfixed vulnerabilities in public channels (Issues,
  discussions, social media, etc.).

### Scope notes

* The adapter layer of this repository is in scope: subprocess orchestration and IPC, translation
  between kernel events / actions and Koishi sessions / actions, the media pipeline, the console
  login panel, and config parsing with account-identity validation.
* For issues in the upstream `@napuketto/kernel` / `loader` / `media` / `adapter` packages, please
  note whether they reproduce through this repository; they are forwarded upstream rather than
  re-fixed here.
* Issues in the Tencent QQ client itself (`wrapper.node`, etc.) are out of scope for this project —
  report them to Tencent. However, if the way this project boots or its vehicle amplifies such a
  risk, reports are welcome.
* This project never modifies any file under the on-disk QQ installation directory; the native layer
  is only assembled inside the self-hosted subprocess, and vulnerability-relevant behavior is runtime
  in-memory only. If you find a path that violates this invariant, please report it as high severity.
