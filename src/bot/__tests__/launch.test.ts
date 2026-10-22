/**
 * launch.test.ts：launch 工厂纯函数单测（docs/internals/bot.md）。
 *
 * 只测 resolveEntry（override 分支）与 resolveLaunchOptions（配置解析）；
 * 不真实 spawn（launchSelfHost 需 stub/wrapper 环境）。测试注入 qqPath 与
 * kernelEntry 覆盖，避免探测 QQ 安装与 import.meta.resolve 环境差异。
 */

import type { QqInstallInfo } from "@napuketto/loader";
import { describe, expect, it } from "vitest";
import type { NapukettoBotConfig } from "../../config.js";
import { resolveEntry, resolveLaunchOptions } from "../launch.js";

/** 测试配置（覆盖注入，避免探测/解析环境差异）。 */
function makeConfig(overrides: Partial<NapukettoBotConfig> = {}): NapukettoBotConfig {
    return {
        selfId: "123456789",
        qqPath: "C:/QQ/NTQQ/QQ.exe",
        kernelEntry: "C:/repo/packages/kernel/dist/index.mjs",
        ...overrides,
    };
}

/** 假 QQ 解析（避免本机 QQ 目录探测；异步，与 LaunchResolvers.resolveQq 签名对齐）。 */
async function fakeResolveQq(opts: {
    qqPath: string | undefined;
    dataRoot: string;
}): Promise<QqInstallInfo> {
    const exe = opts.qqPath ?? "C:/QQ/NTQQ/QQ.exe";
    return {
        qqPath: exe,
        installDir: "C:/QQ/NTQQ",
        version: "9.9.33-51802",
        wrapperPath: "C:/QQ/NTQQ/versions/9.9.33-51802/resources/app/wrapper.node",
        source: "local",
    };
}

describe("resolveEntry", () => {
    it("override 优先（不触发 import.meta.resolve）", () => {
        const entry = resolveEntry("@napuketto/kernel", "C:/repo/kernel.mjs");
        expect(entry).toBe("C:/repo/kernel.mjs");
    });

    it("相对 override 基于 cwd 展开（分隔符归一化）", () => {
        const entry = resolveEntry("@napuketto/kernel", "./local/kernel.mjs");
        expect(entry.replaceAll("\\", "/")).toBe(
            `${process.cwd()}/local/kernel.mjs`.replaceAll("\\", "/"),
        );
    });
});

describe("resolveLaunchOptions（强制扫码一次性标记，2026-09-08）", () => {
    it("forceQr.current=true → qrOnly:true 且消费后清零", async () => {
        const forceQr = { current: true };
        const options = await resolveLaunchOptions(makeConfig(), {
            resolveQq: fakeResolveQq,
            forceQr,
        });
        expect(options.qrOnly).toBe(true);
        expect(forceQr.current).toBe(false);
    });

    it("forceQr 缺省/未置 → 无 qrOnly（快速登录路径不变）", async () => {
        const options = await resolveLaunchOptions(makeConfig(), {
            resolveQq: fakeResolveQq,
            forceQr: { current: false },
        });
        expect(options.qrOnly).toBeUndefined();
        const optionsNoRef = await resolveLaunchOptions(makeConfig(), {
            resolveQq: fakeResolveQq,
        });
        expect(optionsNoRef.qrOnly).toBeUndefined();
    });
});

describe("resolveLaunchOptions", () => {
    it("组装 launchSelfHost 选项（IPC 自建宿主模式）", async () => {
        const options = await resolveLaunchOptions(makeConfig(), { resolveQq: fakeResolveQq });
        expect(options.qq.qqPath).toBe("C:/QQ/NTQQ/QQ.exe");
        expect(options.kernelEntry).toBe("C:/repo/packages/kernel/dist/index.mjs");
        expect(options.cfgDir).toContain("123456789"); // 数据根/账号
        expect(options.quickUin).toBe("123456789");
        expect(options.selfHost).toBe(true);
        expect(options.ipc).toBe(true);
        expect(options.stdio).toEqual(["pipe", "pipe", "pipe"]);
        // 数据根（dataDir 未配置 → 默认解析）
        expect(options.cwd).toBeTypeOf("string");
        expect(options.configPath).toBeTypeOf("string");
    });

    it("quickUin = selfId（快速登录账号）", async () => {
        const options = await resolveLaunchOptions(makeConfig({ selfId: "3567141148" }), {
            resolveQq: fakeResolveQq,
        });
        expect(options.quickUin).toBe("3567141148");
    });

    it("dataDir 覆盖数据根", async () => {
        // 绝对路径按平台取：Linux 上 "C:/data" 是相对路径语义（posix resolve 拼
        // cwd），数据根契约本就要求当前平台路径（WSL 必须 ext4，见 launch.ts）
        const dataDir = process.platform === "win32" ? "C:/data" : "/tmp/napuketto-data";
        const options = await resolveLaunchOptions(makeConfig({ dataDir }), {
            resolveQq: fakeResolveQq,
        });
        expect(options.cwd.replaceAll("\\", "/")).toBe(dataDir);
        expect(options.cfgDir.replaceAll("\\", "/")).toBe(`${dataDir}/123456789`);
    });

    it("OB11 动作桥入口：缺省解析依赖（ob11Actions 默认开）", async () => {
        const options = await resolveLaunchOptions(makeConfig(), { resolveQq: fakeResolveQq });
        expect(options.adapterEntry).toBeTypeOf("string");
        expect(options.adapterEntry).toContain("adapter");
        expect(options.networkEntry).toBeTypeOf("string");
        expect(options.networkEntry).toContain("network");
    });

    it("OB11 动作桥入口：ob11Actions=false 时不解析（子进程纯 kernel 动作面）", async () => {
        const options = await resolveLaunchOptions(
            makeConfig({
                ob11Actions: false,
                adapterEntry: "C:/adapter/index.mjs",
                networkEntry: "C:/network/index.mjs",
            }),
            { resolveQq: fakeResolveQq },
        );
        expect(options.adapterEntry).toBeUndefined();
        expect(options.networkEntry).toBeUndefined();
    });

    it("OB11 动作桥入口：override 优先", async () => {
        const options = await resolveLaunchOptions(
            makeConfig({
                adapterEntry: "C:/custom/adapter/index.mjs",
                networkEntry: "C:/custom/network/index.mjs",
            }),
            { resolveQq: fakeResolveQq },
        );
        expect(options.adapterEntry).toBe("C:/custom/adapter/index.mjs");
        expect(options.networkEntry).toBe("C:/custom/network/index.mjs");
    });
});
