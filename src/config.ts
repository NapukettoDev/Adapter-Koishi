/**
 * config.ts：koishi bot 配置 schema（docs/internals/bot.md）。
 *
 * koishi 平台 bot 配置（`bots: { 'onebot:<uin>': {...} }`）：
 *  - selfId：登录账号（QQ 号，必填，数据目录账号隔离 + 快速登录账号）
 *  - qqPath / stubDir：loader 引导参数（缺省自动探测/包内默认）
 *  - dataDir：数据根目录（缺省 kernel resolveDataRoot 默认）
 *  - kernelEntry 等：包入口覆盖（高级项，缺省按 Node 解析规则从 dependencies 自动定位）
 *  - logLevel：日志等级（默认 info，排障时可用 debug 查看详细日志）
 *  - restart / heartbeatTimeoutMs：driver 重启策略与心跳超时
 *
 * 运行时 import koishi（Schema）——本文件不进单测（docs/guides/development.md 单测边界）。
 */
import { Schema } from "koishi";
import {
    DEFAULT_LOCAL_FILE_POLICY,
    DEFAULT_LOG_LEVEL,
    DEFAULT_REMOTE_MEDIA_POLICY,
    type OutboundMediaPolicy,
    SELF_ID_PATTERN,
} from "./shared.js";

/** 日志等级（reggol Logger level）。 */
export type LogLevel = "debug" | "info" | "error" | "silent";

/** 重启策略（与 driver RestartPolicy 对齐）。 */
export interface RestartConfig {
    /** 最大重启次数（0 = 不重启），默认 3。 */
    maxRetries?: number;
    /** 首次退避基数（毫秒），默认 1000。 */
    backoffMs?: number;
    /** 退避因子，默认 2。 */
    backoffFactor?: number;
}

/** bot 配置。 */
export interface NapukettoBotConfig extends OutboundMediaPolicy {
    /** 登录账号（QQ 号，必填：数据目录账号隔离 + 快速登录账号）。 */
    selfId: string;
    /** QQ 可执行文件路径（缺省由 loader 自动探测）。 */
    qqPath?: string;
    /** Windows stub QQNT.dll 目录（缺省 loader 包内默认）。 */
    stubDir?: string;
    /** Linux ELF stub 文件路径（缺省 loader 包内默认）。 */
    linuxStubPath?: string;
    /** Windows 上 Koishi 运行于非 Node 宿主时使用的 node.exe。 */
    winNodePath?: string;
    /** 入站图片自动下载补丁（省略时沿用 loader 默认及环境开关）。 */
    nativeMediaPatch?: boolean;
    /** 数据根目录（缺省 kernel resolveDataRoot 默认）。 */
    dataDir?: string;
    /** 包入口覆盖（高级项；缺省 createRequire 按 dependencies 自动定位）。 */
    kernelEntry?: string;
    /** 自建宿主入口覆盖（高级项；缺省 loader 包内 dist/host/self-host.cjs）。 */
    selfHostEntry?: string;
    /** OB11 动作桥入口覆盖（高级项；缺省按 dependencies 自动解析，docs/internals/actions.md）。 */
    adapterEntry?: string;
    /** network 入口覆盖（高级项；与 adapterEntry 配对，EventBroadcaster 用）。 */
    networkEntry?: string;
    /** 心跳超时（毫秒，driver 默认 45s）。 */
    heartbeatTimeoutMs?: number;
    /**
     * OB11 动作桥（默认 true）：子进程整表挂载 @napuketto/adapter 的 OneBot 11
     * 动作注册表和 ob11 事件（零网络传输；docs/internals/actions.md）。
     * 关闭 = 只保留 kernel 点分动作面（子进程也不需要 adapter/network 依赖）。
     */
    ob11Actions?: boolean;
    /** 日志等级，默认 info。 */
    logLevel?: LogLevel;
    /** 子进程重启策略。 */
    restart?: RestartConfig;
}

const localMediaRootsSchema = Schema.array(Schema.string())
    .role("table")
    .description("允许低信任调用者发送的本地媒体白名单目录")
    .default([]);

// 表单中的「自动」对应省略字段，运行时仍只接收显式布尔值。
const nativeMediaPatchSchema = Schema.union([
    Schema.const(undefined).description("自动"),
    Schema.const(true).description("强制开启"),
    Schema.const(false).description("强制关闭"),
]).description("入站图片自动下载补丁") as Schema<boolean>;

/** 配置 schema（koishi）。 */
export const napukettoConfigSchema: Schema<NapukettoBotConfig> = Schema.intersect([
    Schema.object({
        selfId: Schema.string().pattern(SELF_ID_PATTERN).description("用于登录的 QQ 号").required(),
        logLevel: Schema.union([
            Schema.const("silent" as const).description("静默"),
            Schema.const("info" as const).description("常规"),
            Schema.const("error" as const).description("错误"),
            Schema.const("debug" as const).description("调试"),
        ])
            .description("当前账号的日志输出等级")
            .default(DEFAULT_LOG_LEVEL),
    }).description("基础设置"),
    Schema.intersect([
        // Koishi 将分组说明传给子项，清空此处避免重复显示分组标题。
        Schema.object({
            ob11Actions: Schema.boolean()
                .description(
                    "启用 OneBot 11 动作桥（提供 OB11 动作，关闭后仍可收发消息和接收撤回事件）",
                )
                .default(true),
            remoteMediaPolicy: Schema.union([
                Schema.const("compatible").description("兼容模式（允许本机与局域网媒体地址）"),
                Schema.const("public-only").description("仅公网（拦截内网地址）"),
            ])
                .description("出站远程媒体下载策略")
                .default(DEFAULT_REMOTE_MEDIA_POLICY),
            localFilePolicy: Schema.union([
                Schema.const("legacy").description("兼容模式（沿用本地路径与 file://）"),
                Schema.const("allowlist").description("白名单模式（仅允许指定目录）"),
            ])
                .description("出站本地媒体读取策略")
                .default(DEFAULT_LOCAL_FILE_POLICY),
        }).description(""),
        Schema.union([
            Schema.object({
                localFilePolicy: Schema.const("allowlist").required(),
                localMediaRoots: localMediaRootsSchema,
            }),
            Schema.object({
                localFilePolicy: Schema.const("legacy"),
                localMediaRoots: localMediaRootsSchema.hidden(),
            }),
        ]),
    ])
        .description("功能与媒体策略")
        .role("napuketto-config-group")
        .collapse(),
    Schema.object({
        heartbeatTimeoutMs: Schema.number()
            .min(5_000)
            .step(1_000)
            .description("子进程心跳超时时间（毫秒），超时判定失联并重启")
            .default(45_000),
        restart: Schema.object({
            maxRetries: Schema.number()
                .min(0)
                .max(20)
                .step(1)
                .description("最大自动重启次数（0 表示不重启）")
                .default(3),
            backoffMs: Schema.number()
                .min(100)
                .step(100)
                .description("首次重启退避基数（毫秒）")
                .default(1_000),
            backoffFactor: Schema.number()
                .min(1)
                .max(10)
                .step(0.5)
                .description("退避倍率（每次重试等待时间按此倍率递增）")
                .default(2),
        }).description("ㅤ子进程重启策略"),
    })
        .description("进程保活与重启")
        .role("napuketto-config-group")
        .collapse(),
    Schema.object({
        qqPath: Schema.string().description("自定义 QQ 可执行文件路径（留空自动探测）"),
        dataDir: Schema.string().description("自定义数据根目录（支持 ~ 与相对路径，留空自动解析）"),
        nativeMediaPatch: nativeMediaPatchSchema,
        stubDir: Schema.string().description(
            "Windows stub 目录（QQNT.dll 所在目录，留空使用内置默认）",
        ),
        linuxStubPath: Schema.string().description(
            "Linux ELF stub 路径（留空自动解析，非 x64 架构按需指定）",
        ),
        winNodePath: Schema.string().description(
            "Windows 外部 node.exe 路径（非标准 Node 宿主使用）",
        ),
    })
        .description("运行环境与路径")
        .role("napuketto-config-group")
        .collapse(),
    Schema.object({
        kernelEntry: Schema.string().description("kernel 入口路径覆盖").hidden(),
        selfHostEntry: Schema.string().description("自建宿主入口路径覆盖").hidden(),
        adapterEntry: Schema.string().description("OB11 动作桥 adapter 入口覆盖").hidden(),
        networkEntry: Schema.string().description("OB11 动作桥 network 入口覆盖").hidden(),
    }).hidden(),
]);
