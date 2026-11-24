/**
 * launch.test.ts：launch 工厂纯函数单测（docs/internals/bot.md）。
 *
 * 只测 resolveEntry（override 分支）与 resolveLaunchOptions（配置解析）；
 * 不真实 spawn（launchSelfHost 需 stub/wrapper 环境）。测试注入 qqPath 与
 * kernelEntry 覆盖，避免探测 QQ 安装与 import.meta.resolve 环境差异。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type { QqInstallInfo } from "@napuketto/loader";
import { describe, expect, it, vi } from "vitest";
import { resolveEntry, resolveLaunchOptions } from "../../../src/bot/launch.js";
import type { NapukettoBotConfig } from "../../../src/config.js";
import { requireSelfId, SELF_ID_PATTERN } from "../../../src/shared.js";

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
        expect(options.stubDir).toBeUndefined();
        expect(options.linuxStubPath).toBeUndefined();
        expect(options.winNodePath).toBeUndefined();
        expect(options.nativeMediaPatch).toBeUndefined();
    });

    it("升级配置使用安全默认值，显式兼容仅作用于对应账号", async () => {
        vi.stubEnv("NAPUKETTO_DIAG", "1");
        vi.stubEnv(
            "NAPUKETTO_CONFIG_JSON",
            JSON.stringify({
                accounts: [
                    {
                        qq: "10000",
                        password: "fixture-password",
                        onebot11: { media: { outboundPolicy: "compat" } },
                    },
                ],
                log: { timestamp: "local", unboundReceive: true },
            }),
        );
        try {
            const defaults = await resolveLaunchOptions(makeConfig(), { resolveQq: fakeResolveQq });
            expect(defaults.diagnostics).toBe(false);
            expect(defaults.log).toEqual({ level: "info" });
            expect(JSON.parse(defaults.extraEnv["NAPUKETTO_CONFIG_JSON"] ?? "")).toEqual({
                log: { timestamp: "local", unboundReceive: false },
                accounts: [
                    {
                        qq: "123456789",
                        onebot11: { media: { outboundPolicy: "public-only", localMediaRoots: [] } },
                    },
                ],
            });
            const trusted = await resolveLaunchOptions(
                makeConfig({
                    selfId: "10002",
                    diagnostics: true,
                    logLevel: "error",
                    localFilePolicy: "legacy",
                    localMediaRoots: [" ./media "],
                    remoteMediaPolicy: "compatible",
                }),
                { resolveQq: fakeResolveQq },
            );
            expect(trusted.diagnostics).toBe(true);
            expect(trusted.log).toEqual({ level: "error" });
            expect(JSON.parse(trusted.extraEnv["NAPUKETTO_CONFIG_JSON"] ?? "").accounts).toEqual([
                {
                    qq: "10002",
                    onebot11: {
                        media: { outboundPolicy: "compat", localMediaRoots: [resolve("media")] },
                    },
                },
            ]);
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it.each([true, false])("保留宿主覆盖及 nativeMediaPatch=%s", async (nativeMediaPatch) => {
        const options = await resolveLaunchOptions(
            makeConfig({
                stubDir: "local/stub",
                linuxStubPath: "local/stub.so",
                winNodePath: "local/node.exe",
                selfHostEntry: "local/self-host.cjs",
                nativeMediaPatch,
            }),
            { resolveQq: fakeResolveQq },
        );
        expect(options).toMatchObject({
            stubDir: resolve("local/stub"),
            linuxStubPath: resolve("local/stub.so"),
            winNodePath: resolve("local/node.exe"),
            selfHostEntry: resolve("local/self-host.cjs"),
            nativeMediaPatch,
        });
    });

    it.each(["10001", "123456789", "3567141148", "12345678901"])(
        "保留 QQ 号 %s，账号目录是数据根的直属子目录",
        async (selfId) => {
            expect(SELF_ID_PATTERN.test(selfId)).toBe(true);
            expect(requireSelfId(selfId)).toBe(selfId);
            const options = await resolveLaunchOptions(makeConfig({ selfId }), {
                resolveQq: fakeResolveQq,
            });
            expect(options.quickUin).toBe(selfId);
            expect(dirname(options.cfgDir)).toBe(options.cwd);
            expect(relative(options.cwd, options.cfgDir)).toBe(selfId);
        },
    );

    it.each([
        undefined,
        null,
        10001,
        "",
        " ",
        "1000",
        "123456789012",
        "１０００１",
        " 10001",
        "10001\n",
        "10001\0",
        ".",
        "..",
        "../10001",
        "..\\10001",
        "10001/20002",
        "/10001",
        "C:10001",
        "C:\\10001",
        "\\\\server\\share\\10001",
        "10001:stream",
        "10001.",
        "10001 ",
    ])("无效 selfId %j 在解析数据根和 QQ 前被拒绝", async (selfId) => {
        if (typeof selfId === "string") {
            expect(SELF_ID_PATTERN.test(selfId)).toBe(false);
        }
        expect(() => requireSelfId(selfId)).toThrow(TypeError);
        const readDataDir = vi.fn(() => "unused");
        const resolveQq = vi.fn(fakeResolveQq);
        const forceQr = { current: true };
        // 模拟绕过 Schema 的运行时调用。
        const config = makeConfig({ selfId: selfId as string });
        Object.defineProperty(config, "dataDir", { get: readDataDir });
        await expect(resolveLaunchOptions(config, { resolveQq, forceQr })).rejects.toThrow(
            /selfId/,
        );
        expect(readDataDir).not.toHaveBeenCalled();
        expect(resolveQq).not.toHaveBeenCalled();
        expect(forceQr.current).toBe(true);
    });

    it("QQ 探测后仍使用同一个已校验的账号", async () => {
        const config = makeConfig({ selfId: "10001" });
        const options = await resolveLaunchOptions(config, {
            resolveQq: (opts) => {
                config.selfId = "20002";
                return fakeResolveQq(opts);
            },
        });
        expect(options.quickUin).toBe("10001");
        expect(relative(options.cwd, options.cfgDir)).toBe("10001");
    });

    it("显式 qqPath 优先于 loader 的缓存环境设置，并在切换 cwd 前解析", async () => {
        const root = mkdtempSync(join(tmpdir(), "napuketto-explicit-qq-"));
        try {
            const app = join(root, "versions", "9.9.33-52230", "resources", "app");
            mkdirSync(app, { recursive: true });
            const wrapperPath = join(app, "wrapper.node");
            writeFileSync(wrapperPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
            const qqPath = relative(process.cwd(), join(root, "QQ.exe"));
            vi.stubEnv("NAPUTO_QQ_FILES", join(root, "nonexistent"));
            vi.stubEnv("NAPUTO_QQ_PATH", join(root, "nonexistent", "QQ.exe"));
            const options = await resolveLaunchOptions(makeConfig({ qqPath }));
            expect(options.qq).toMatchObject({ installDir: root, wrapperPath, source: "local" });
        } finally {
            vi.unstubAllEnvs();
            rmSync(root, { recursive: true, force: true });
        }
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
        expect(options.extraEnv).toMatchObject({
            NAPUKETTO_DATA_ROOT: options.cwd,
            NAPUKETTO_DATA: options.cwd,
        });
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

    it("可选路径的空串/空白视为未配置，不解析成 cwd", async () => {
        const options = await resolveLaunchOptions(
            makeConfig({
                qqPath: "   ",
                dataDir: "\t ",
                stubDir: " ",
                linuxStubPath: "",
                winNodePath: "\t",
                selfHostEntry: "   ",
                kernelEntry: " ",
                adapterEntry: "",
                networkEntry: " ",
            }),
            { resolveQq: fakeResolveQq },
        );
        expect(options.qq.qqPath).toBe("C:/QQ/NTQQ/QQ.exe");
        expect(options.stubDir).toBeUndefined();
        expect(options.linuxStubPath).toBeUndefined();
        expect(options.winNodePath).toBeUndefined();
        expect(options.selfHostEntry).toBeUndefined();
    });

    it.each([
        ["stubDir", "file"],
        ["linuxStubPath", "directory"],
        ["winNodePath", "directory"],
        ["selfHostEntry", "directory"],
        ["qqPath", "directory"],
        ["kernelEntry", "directory"],
        ["dataDir", "file"],
    ] as const)("配置项 %s 期望 %s，类型不符时报错且不回显路径", async (key, actualKind) => {
        const root = mkdtempSync(join(tmpdir(), "napuketto-path-kind-"));
        try {
            const filePath = join(root, "not-a-directory");
            const dirPath = join(root, "not-a-file");
            writeFileSync(filePath, "x");
            mkdirSync(dirPath);
            const path = actualKind === "file" ? filePath : dirPath;
            const config = makeConfig({ [key]: path });
            const error = await resolveLaunchOptions(config, {
                resolveQq: fakeResolveQq,
            }).catch((caught: unknown) => caught);
            expect(error).toBeInstanceOf(TypeError);
            expect((error as Error).message).toContain(key);
            expect((error as Error).message).not.toContain(root);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("qqPath 解析失败只点名配置项，不回显底层路径", async () => {
        const root = mkdtempSync(join(tmpdir(), "napuketto-path-"));
        try {
            const qqPath = join(root, "QQ.exe");
            writeFileSync(qqPath, "x");
            const error = await resolveLaunchOptions(makeConfig({ qqPath }), {
                resolveQq: async () => {
                    throw new Error(`无法读取 ${root}`);
                },
            }).catch((caught: unknown) => caught);
            expect(error).toBeInstanceOf(TypeError);
            expect((error as Error).message).toContain("qqPath");
            expect((error as Error).message).not.toContain(root);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("OB11 动作桥 override 是目录时降级并点名配置项（不阻断启动）", async () => {
        const root = mkdtempSync(join(tmpdir(), "napuketto-entry-dir-"));
        try {
            const adapterDir = join(root, "adapter");
            mkdirSync(adapterDir);
            const onStage = vi.fn();
            const options = await resolveLaunchOptions(
                makeConfig({ adapterEntry: adapterDir, networkEntry: adapterDir }),
                { resolveQq: fakeResolveQq, onStage },
            );
            expect(options.adapterEntry).toBeUndefined();
            expect(options.networkEntry).toBeUndefined();
            expect(onStage).toHaveBeenCalledWith(expect.stringContaining("adapterEntry"));
            expect(onStage).toHaveBeenCalledWith(expect.stringContaining("networkEntry"));
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
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
