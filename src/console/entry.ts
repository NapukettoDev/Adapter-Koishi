/**
 * entry.ts：控制台前端入口注册（docs/internals/console.md）。
 *
 * packageRoot 逐级上溯定位插件包根目录（bundle 与源码两种形态均正确）；
 * 同一控制台的 Bot 共用一个前端入口，最后一个 Bot 销毁时释放。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "koishi";

import { prepareConsoleAssets } from "./entry-assets.js";

interface SharedEntry {
    users: number;
    dispose(): unknown;
}

// Cordis 会按调用作用域代理服务，entries 是该 console 实例共享的底层对象。
const consoleEntries = new WeakMap<Context["console"]["entries"], SharedEntry>();

/** 源码与 CJS 产物的目录深度不同，按包名逐级查找包根目录。 */
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

function usesDevEntry(console: Context["console"], dev: string): boolean {
    const config = "config" in console ? console.config : undefined;
    return (
        typeof config === "object" &&
        config !== null &&
        "devMode" in config &&
        config.devMode === true &&
        existsSync(dev)
    );
}

/** 注册控制台登录面板前端入口（dev 由 koishi dev 动态编译；prod 走 vite 产物 dist）。 */
function addConsoleEntry(ctx: Context): SharedEntry {
    const root = packageRoot();
    const dev = resolve(root, "client/index.ts");
    const source = resolve(root, "dist");
    const prod = usesDevEntry(ctx.console, dev)
        ? source
        : prepareConsoleAssets(source, ctx.baseDir ?? process.cwd());
    ctx.logger.info("[napuketto] registerConsoleEntry: addEntry dev=%s prod=%s", dev, prod);
    // 入口独立于 Bot。注入作用域先于 console 服务卸载，确保 dispose 仍可访问服务。
    const scope = ctx.root.inject(["console"], (owner) => {
        owner.console.addEntry({
            dev,
            prod,
        });
    });
    return { users: 0, dispose: () => scope.dispose() };
}

export function registerConsoleEntry(ctx: Context): void {
    const entries = ctx.console.entries;
    const shared = consoleEntries.get(entries) ?? addConsoleEntry(ctx);
    consoleEntries.set(entries, shared);
    shared.users += 1;
    let released = false;
    ctx.on("dispose", () => {
        if (released) {
            return;
        }
        released = true;
        shared.users -= 1;
        if (shared.users === 0) {
            consoleEntries.delete(entries);
            shared.dispose();
        }
    });
}
