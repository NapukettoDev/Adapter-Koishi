/**
 * launch.ts：launch 工厂（docs/internals/bot.md）——launchSelfHost 组装 + 包入口解析。
 *
 * 参考 cli boot.ts 的组装方式。IPC 模式注入 adapterEntry/networkEntry 时，
 * loader IPC 分支整表挂载 OB11 动作桥（§5.14；解析失败 fail-soft 降级纯
 * kernel 动作面）。
 *
 * `resolveLaunchOptions` 为纯函数（不 spawn，可单测）；`buildLaunch` 返回
 * DriverLauncher（真实 spawn，由 driver 调用，不直接测）。
 *
 * ⚠️ 发布形态（2026-08-09 产品化）：`@napuketto/kernel` / `@napuketto/loader`
 * 为 dependencies（真实安装，不 bundle）——子进程要的是磁盘真实文件
 * （self-host.cjs / 平台 stub / kernel 入口），bundle 后资产丢失。
 * `resolveEntry` 用 `createRequire`（CJS 产物下 `import.meta.resolve` 被
 * 替换成 `{}` 报错，见 docs/guides/development.md 产物与依赖形态）；`launchSelfHost` 内部 `__dirname`
 * 定位 self-host.cjs 由 loader 包内 `files: ["dist", "native/..."]` 保证。
 */
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { resolveConfigPath, resolveDataRoot } from "@napuketto/kernel";
import {
    type LaunchOptions,
    launchSelfHost,
    type QqInstallInfo,
    resolveQqFiles,
    resolveQqInstall,
} from "@napuketto/loader";
import type { NapukettoBotConfig } from "../config.js";
import type { DriverLauncher } from "../driver/index.js";

/**
 * 解析包入口（override 优先；否则 createRequire.resolve——CJS 产物下
 * `import.meta.resolve` 不可用，被 rolldown 替换成 `{}` 报
 * `{}.resolve is not a function`）。
 *
 * 缺省解析依赖 `@napuketto/*` 为真实 dependencies（发布后 npm 安装到
 * node_modules，createRequire 按 Node 标准解析规则查找）。
 */
const require = createRequire(import.meta.url);

export function resolveEntry(pkg: string, override?: string): string {
    if (override !== undefined && override !== "") {
        return resolvePath(override);
    }
    try {
        return require.resolve(pkg);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
            `无法解析 ${pkg} 入口: ${message}（请确认 ${pkg} 依赖已安装；` +
                `或手动指定 ${pkg} 入口路径）`,
        );
    }
}

/** 路径解析（相对路径基于进程 cwd 展开）。 */
function resolvePath(p: string): string {
    return p.startsWith(".") ? join(process.cwd(), p) : p;
}

/** launchSelfHost 选项（resolveLaunchOptions 产出，测试断言用）。 */
export type ResolvedLaunch = LaunchOptions & {
    cwd: string;
    configPath: string;
    extraEnv: Record<string, string>;
    quickUin: string;
    selfHost: true;
    ipc: true;
};

/** 可注入依赖（测试用假实现，生产默认按平台分支解析）。 */
export interface LaunchResolvers {
    /** QQ 原生文件解析（默认按平台探测本机安装，Linux 缺失时尝试缓存或下载）。 */
    resolveQq?: (opts: { qqPath: string | undefined; dataRoot: string }) => Promise<QqInstallInfo>;
    /** 阶段回调（下载/解包/win-node/启动提示；默认无——resolveLaunchOptions 纯函数不落地）。 */
    onStage?: (message: string) => void;
    /** 一次性强制扫码标记（面板「扫码登录」置 true；resolveLaunchOptions 消费后清零）。 */
    forceQr?: { current: boolean };
}

/** 显式路径优先；Linux 自动探测交给 loader 处理原生安装和缓存。 */
async function defaultResolveQq(
    opts: {
        qqPath: string | undefined;
        dataRoot: string;
    },
    onStage?: (message: string) => void,
): Promise<QqInstallInfo> {
    if (opts.qqPath !== undefined && opts.qqPath !== "") {
        return resolveQqInstall(resolve(opts.qqPath));
    }
    if (process.platform === "linux") {
        return resolveQqFiles({
            dataRoot: opts.dataRoot,
            ...(onStage !== undefined ? { onStage } : {}),
        });
    }
    return resolveQqInstall();
}

/** 组装 launchSelfHost 选项（不 spawn；deps 测试注入）。 */
export async function resolveLaunchOptions(
    config: NapukettoBotConfig,
    deps: LaunchResolvers = {},
): Promise<ResolvedLaunch> {
    const dataRoot = resolveDataRoot(config.dataDir);
    const qq = await (deps.resolveQq ?? ((opts) => defaultResolveQq(opts, deps.onStage)))({
        qqPath: config.qqPath,
        dataRoot,
    });
    const cfgDir = join(dataRoot, config.selfId);
    // OB11 动作桥入口（§5.14）：ob11Actions !== false 时解析 adapter/network
    // 磁盘入口传给子进程（launcher 透传 NAPUKETTO_ADAPTER_ENTRY/NAPUKETTO_NETWORK_ENTRY，
    // loader IPC 分支检测到即装配）。解析失败（依赖未装/损坏）fail-soft 降级为
    // 纯 kernel 动作面——不阻断启动，老版本行为兜底。
    let ob11: Pick<LaunchOptions, "adapterEntry" | "networkEntry"> = {};
    if (config.ob11Actions !== false) {
        try {
            ob11 = {
                adapterEntry: resolveEntry("@napuketto/adapter", config.adapterEntry),
                networkEntry: resolveEntry("@napuketto/network", config.networkEntry),
            };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            deps.onStage?.(`OB11 动作桥不可用（降级纯 kernel 动作面）: ${message}`);
        }
    }
    // 强制扫码一次性标记（面板「扫码登录」置 true）：本次 spawn 消费后清零，
    // 崩溃退避重启不重复扫码；NAPUKETTO_QR_ONLY=1 → 子进程跳过快速登录直接出码
    const qrOnly = deps.forceQr?.current === true;
    if (qrOnly && deps.forceQr !== undefined) {
        deps.forceQr.current = false;
    }
    return {
        qq,
        kernelEntry: resolveEntry("@napuketto/kernel", config.kernelEntry),
        ...(config.selfHostEntry !== undefined
            ? { selfHostEntry: resolve(config.selfHostEntry) }
            : {}),
        ...ob11,
        ...(qrOnly ? { qrOnly: true } : {}),
        cfgDir,
        cwd: dataRoot,
        configPath: resolveConfigPath({ dataRoot }),
        // 宿主引导和 OB11 clean_cache 分别读取这两个变量。
        extraEnv: { NAPUKETTO_DATA_ROOT: dataRoot, NAPUKETTO_DATA: dataRoot },
        ...(config.stubDir !== undefined ? { stubDir: resolve(config.stubDir) } : {}),
        ...(config.linuxStubPath !== undefined
            ? { linuxStubPath: resolve(config.linuxStubPath) }
            : {}),
        ...(config.winNodePath !== undefined ? { winNodePath: resolve(config.winNodePath) } : {}),
        ...(config.nativeMediaPatch !== undefined
            ? { nativeMediaPatch: config.nativeMediaPatch }
            : {}),
        quickUin: config.selfId,
        selfHost: true,
        ipc: true,
        stdio: ["pipe", "pipe", "pipe"],
    };
}

/** launch 宿主（bot 注入 logger 等；buildLaunch 每次 spawn 前解析一次）。 */
export interface LaunchHost {
    /** 阶段日志回调（下载/解包/win-node/启动提示；bot 接 logger.info）。 */
    onStage?: (message: string) => void;
    /** 一次性强制扫码标记（bot.qrOnlyRef；面板「扫码登录」重启路径）。 */
    forceQr?: { current: boolean };
}

/** 启动工厂（driver 注入：每次 spawn 组装一次 launchSelfHost 调用）。 */
export function buildLaunch(config: NapukettoBotConfig, host: LaunchHost = {}): DriverLauncher {
    return async () => {
        const options = await resolveLaunchOptions(config, {
            ...(host.onStage !== undefined ? { onStage: host.onStage } : {}),
            ...(host.forceQr !== undefined ? { forceQr: host.forceQr } : {}),
        });
        const { child } = await launchSelfHost({
            ...options,
            ...(host.onStage !== undefined ? { onStage: host.onStage } : {}),
        });
        return { child };
    };
}
