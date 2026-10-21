/**
 * check-publishable.mjs：判断 package.json 的版本是否还需要发布。
 *
 * 用途：release 工作流的 detect job。本仓是单包、版本号在 PR 里手工 bump，
 * 因此「要不要发」只取决于 registry 上有没有这个版本——有就整轮跳过，没有就
 * 继续构建与发布。重跑天然幂等：发布失败的版本仍未进 registry，会再次尝试。
 *
 * 输出：写入 $GITHUB_OUTPUT 的 `publish=true|false`；本地直接跑则只打印结论。
 */
import { appendFileSync, readFileSync } from "node:fs";

const REGISTRY = process.env.RELEASE_REGISTRY ?? "https://registry.npmjs.org";
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const res = await fetch(`${REGISTRY}/${encodeURIComponent(pkg.name)}`, {
    headers: { accept: "application/json" },
});
if (!res.ok && res.status !== 404) {
    throw new Error(`registry 查询失败 ${pkg.name}: HTTP ${res.status}`);
}
const versions = res.ok ? ((await res.json()).versions ?? {}) : {};
const published = Object.hasOwn(versions, pkg.version);

console.log(
    `[release] ${pkg.name}@${pkg.version} ${published ? "已在 registry，跳过发布" : "未发布，进入构建与发布"}`,
);
if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `publish=${!published}\n`);
}
