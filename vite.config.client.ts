/**
 * vite.config.client.ts：控制台前端构建（design.md §5.12）。
 *
 * 等价 @koishijs/client 的 yakumo client 构建：`client/index.ts` → `dist/index.js`
 * （ESM，运行时依赖由 koishi 控制台提供）。
 *
 * - external：vue / vue-router / @vueuse/core / @koishijs/client——koishi 控制台
 *   主入口已加载同名模块（entry 加载时经控制台模块系统解析）。
 * - 产物：dist/index.js（逻辑）+ dist/index.css（样式）；文件名固定，运行时
 *   console-entry.ts 按 CLIENT_FILES 清单复制（改名会导致面板加载 404）。
 * - dev 模式无需构建（koishi dev 动态编译 client/index.ts）。
 *
 * 文件名带 `.client` 后缀：避免 vitest 默认加载本配置（lib 构建 + NODE_ENV 被
 * define 成 production 会污染单测）。用法：`pnpm build:client`。
 */
import { resolve } from "node:path";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const root = import.meta.dirname;

export default defineConfig({
    root,
    build: {
        outDir: "dist",
        assetsDir: "",
        emptyOutDir: true,
        minify: true,
        commonjsOptions: {
            transformMixedEsModules: true,
            strictRequires: true,
        },
        lib: {
            entry: resolve(root, "client/index.ts"),
            formats: ["es"],
            // 固定产物名：ES 格式默认输出 index.mjs，运行时清单要求 index.js
            fileName: () => "index.js",
            cssFileName: "index",
        },
        rolldownOptions: {
            external: ["vue", "vue-router", "@vueuse/core", "@koishijs/client"],
            output: {
                // Vite 8（rolldown）下 build.minify 只压缩/改名、不删空白，产物会比旧
                // 链路大 ~25%；显式打开空白删除后为 6.2KB（gzip 2.4KB，旧链路 7.3KB）。
                minify: { compress: true, mangle: true, codegen: { removeWhitespace: true } },
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
        // koishi 生态别名：控制台构建链用（与 yakumo build 对齐）
        alias: {
            "vue-i18n": "@koishijs/client",
            "@koishijs/components": "@koishijs/client",
        },
    },
    define: {
        "process.env.NODE_ENV": '"production"',
    },
});
