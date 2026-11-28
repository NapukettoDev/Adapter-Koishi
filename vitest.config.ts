import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

export default defineConfig({
    plugins: [vue()],
    resolve: {
        alias: {
            "@koishijs/client": fileURLToPath(new URL("./tests/fixtures/koishi-client.ts", import.meta.url)),
        },
    },
});
