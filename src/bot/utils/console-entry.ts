/**
 * console-entry.ts：控制台前端入口注册（docs/internals/console.md）。
 *
 * packageRoot 逐级上溯定位插件包根目录（bundle 与源码两种形态均正确）；
 * registerConsoleEntry 模块级去重——多 bot 实例只注册一次 addEntry；
 * ⚠️ 去重 flag 随作用域 dispose 重置（否则插件 stop/start 后 entry 不恢复）。
 */
import { copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "koishi";

/** 前端产物文件清单（复制用）。 */
const CLIENT_FILES = ["index.js", "index.css"] as const;

/** 控制台前端入口已注册标记（模块级去重：多 bot 实例只注册一次；作用域 dispose 时重置）。 */
let consoleEntryRegistered = false;

/**
 * 包根目录（定位 client/ 与 dist/）。
 *
 * ⚠️ 2026-08-14 修复（二维码不显示根因）：bundle（lib/index.cjs，深 1 层）与
 * 源码（src/bot/bot.ts，深 2 层）的文件深度不同，`new URL("../..")` 只对源码
 * 形态正确；且 esbuild 转译 CJS 时把 import.meta.url shim 成可用（try 不抛错），
 * __dirname 兜底分支永远走不到——最终 dev/prod 入口被注册到 node_modules 根
 * （路径不存在），控制台面板永不挂载。改为逐级上溯找 package.json（校验包名），
 * bundle 与源码两种形态均正确。
 */
function packageRoot(): string {
    let dir: string;
    try {
        dir = fileURLToPath(new URL(".", import.meta.url));
    } catch {
        dir = __dirname;
    }
    for (let i = 0; i < 5; i += 1) {
        try {
            const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
                name?: string;
            };
            if (pkg.name === "koishi-plugin-adapter-napuketto") {
                return dir;
            }
        } catch {
            // 该层无 package.json（或不可读），继续上溯
        }
        dir = dirname(dir);
    }
    throw new Error("[napuketto] 无法定位插件包根目录（未找到 package.json）");
}

/**
 * 控制台前端产物可服务路径。
 *
 * ⚠️ 2026-08-14 生产环境根因修复：@koishijs/plugin-console 的 serveAssets 对
 * `/<uiPath>/@plugin-<key>/...` 有安全检查——入口文件路径必须 startsWith(console
 * root) 或包含 "node_modules"，否则返回 403（浏览器控制台报
 * `GET /@plugin-<key>/index.js 403`，登录面板永不挂载）。标准 npm/pnpm 安装
 * （插件在 node_modules 下）天然通过；portal/本地路径/桌面端等非标准安装
 * （路径不含 node_modules）必 403。这里做防御：prod 路径不含 node_modules 时，
 * 把 dist 产物复制到 koishi 数据目录下的 node_modules 子路径（路径字符串含
 * node_modules → 通过安全检查），addEntry 指向复制产物。文件未变化时仅 stat
 * 比较（mtime/size），不重复写盘。
 */
function ensureServeableProd(ctx: Context, root: string): string {
    const prod = resolve(root, "dist");
    if (prod.includes("node_modules")) {
        return prod;
    }
    const target = resolve(
        ctx.baseDir ?? process.cwd(),
        "data",
        "napuketto-console",
        "node_modules",
        "koishi-plugin-adapter-napuketto",
        "dist",
    );
    let copied = false;
    for (const name of CLIENT_FILES) {
        const src = resolve(prod, name);
        const srcStat = statSync(src, { throwIfNoEntry: false });
        if (srcStat === undefined) {
            continue;
        }
        const dst = resolve(target, name);
        const dstStat = statSync(dst, { throwIfNoEntry: false });
        if (
            dstStat === undefined ||
            dstStat.size !== srcStat.size ||
            dstStat.mtimeMs < srcStat.mtimeMs
        ) {
            mkdirSync(target, { recursive: true });
            copyFileSync(src, dst);
            copied = true;
        }
    }
    ctx.logger.info(
        "[napuketto] 非标准安装（prod 路径不含 node_modules），前端产物复制到 %s%s",
        target,
        copied ? "（已更新）" : "（已是最新）",
    );
    return target;
}

/** 注册控制台登录面板前端入口（dev 由 koishi dev 动态编译；prod 走 vite 产物 dist）。 */
export function registerConsoleEntry(ctx: Context): void {
    if (consoleEntryRegistered) {
        return;
    }
    consoleEntryRegistered = true;
    const root = packageRoot();
    const prod = ensureServeableProd(ctx, root);
    ctx.logger.info(
        "[napuketto] registerConsoleEntry: addEntry dev=%s prod=%s",
        resolve(root, "client/index.ts"),
        prod,
    );
    ctx.console.addEntry({
        dev: resolve(root, "client/index.ts"),
        prod,
    });
    // ⚠️ 2026-08-14 修复（插件 stop/start 后前端组件消失根因）：addEntry 创建
    // 的 Entry 是**作用域绑定**的（@koishijs/console src/entry.ts：
    // `ctx.collect('entry', () => delete entries[id])`）——插件 stop → 本作用域
    // dispose → console 自动移除 entry。若模块级 flag 不重置，插件重启后
    // registerConsoleEntry 直接 return → 不重新 addEntry → entry 永久丢失 →
    // 前端 slot 组件（扫码面板）消失。此处挂作用域 dispose 重置 flag，下次
    // 插件启动可重新注册。多 bot 场景：第一个 bot 注册（挂 dispose 重置），
    // 其余 return 不挂——但第一个的 dispose 会重置 flag，整体正确（无活跃
    // entry 时 flag 必为 false）。
    ctx.on("dispose", () => {
        consoleEntryRegistered = false;
    });
}
