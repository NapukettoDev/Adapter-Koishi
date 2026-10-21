/**
 * build-client.ts：控制台前端构建（design.md §5.12）。
 *
 * 等价 @koishijs/client 的 yakumo client 构建（webui packages/client/src/index.ts
 * 的 build()）：`client/index.ts` → `dist/index.js`（ESM，external 运行时由
 * koishi 控制台提供）。
 *
 * - external：vue / vue-router / @vueuse/core / @koishijs/client——koishi 控制台
 *   主入口已加载同名模块（entry 加载时经控制台模块系统解析）。
 * - 产物：dist/index.js（逻辑，lib es 格式 + 手动改名）+ dist/style.css（如有）。
 * - dev 模式无需此脚本（koishi dev 动态编译 client/index.ts）。
 *
 * 用法：`pnpm build:client`（本仓根目录；Node 24 直接跑 TS）。
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RolldownOutput } from "rolldown";
import vue from "@vitejs/plugin-vue";
import * as vite from "vite";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const outDir = resolve(root, "dist");

// 与 yakumo client 构建对齐：lib es + external + 手动写文件（index.mjs → index.js）
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const results = await vite.build({
    root,
    build: {
        write: false,
        outDir: "dist",
        assetsDir: "",
        minify: true,
        emptyOutDir: true,
        commonjsOptions: {
            transformMixedEsModules: true,
            strictRequires: true,
        },
        lib: {
            entry: resolve(root, "client/index.ts"),
            fileName: "index",
            formats: ["es"],
        },
        rollupOptions: {
            makeAbsoluteExternalsRelative: true,
            external: ["vue", "vue-router", "@vueuse/core", "@koishijs/client"],
            output: {
                format: "iife",
            },
        },
    },
    plugins: [vue()],
    css: {
        preprocessorOptions: {
            scss: {
                api: "modern-compiler",
            },
        },
    },
    resolve: {
        alias: {
            // koishi 生态别名：控制台构建链用（与 yakumo build 对齐）
            "vue-i18n": "@koishijs/client",
            "@koishijs/components": "@koishijs/client",
        },
    },
    define: {
        "process.env.NODE_ENV": '"production"',
    },
});

// 非 watch 模式不返回 RolldownWatcher；此处收窄为输出对象
const bundle = (Array.isArray(results) ? results[0] : results) as RolldownOutput | undefined;
if (bundle === undefined) {
    throw new Error("[build-client] vite build 未返回输出");
}
for (const item of bundle.output) {
    if (item.type === "chunk") {
        const dest = resolve(
            outDir,
            item.fileName === "index.mjs" ? "index.js" : item.fileName,
        );
        const result = await vite.transformWithEsbuild(item.code, dest, {
            minifyWhitespace: true,
            charset: "utf8",
        });
        await writeFile(dest, result.code);
    } else if (item.type === "asset") {
        await writeFile(resolve(outDir, item.fileName), item.source);
    }
}

console.log("[build-client] dist/index.js 完成（client/index.ts → dist，ESM + external）");
