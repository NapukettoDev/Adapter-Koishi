/**
 * config.ts：koishi bot 配置 schema（docs/internals/bot.md）。
 *
 * koishi 平台 bot 配置（`bots: { 'onebot:<uin>': {...} }`）：
 *  - selfId：登录账号（QQ 号，必填，数据目录账号隔离 + 快速登录账号）
 *  - qqPath / stubDir：loader 引导参数（缺省自动探测/包内默认）
 *  - dataDir：数据根目录（缺省 kernel resolveDataRoot 默认）
 *  - kernelEntry 等：包入口覆盖（高级项，缺省按 Node 解析规则从 dependencies 自动定位）
 *  - logLevel：日志等级（默认 debug——多点日志便于排查，用户可调低减少输出）
 *  - restart / heartbeatTimeoutMs：driver 重启策略与心跳超时
 *
 * 运行时 import koishi（Schema）——本文件不进单测（docs/guides/development.md 单测边界）。
 */
import { Schema } from "koishi";

/** 日志等级（reggol Logger level；默认 debug——事件/消息详细日志，可调低减少输出）。 */
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
export interface NapukettoBotConfig {
    /** 登录账号（QQ 号，必填：数据目录账号隔离 + 快速登录账号）。 */
    selfId: string;
    /** QQ 安装路径（缺省 loader locateQqPath 自动探测）。 */
    qqPath?: string;
    /** stub QQNT.dll 目录（缺省 loader 包内默认）。 */
    stubDir?: string;
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
     * 动作容器（79 动作 + ob11 事件透出，零网络传输；docs/internals/actions.md）。
     * 关闭 = 只保留 kernel 点分动作面（子进程也不需要 adapter/network 依赖）。
     */
    ob11Actions?: boolean;
    /** 日志等级（默认 "debug"：事件桥/消息详细日志；"info" 只留消息与警告，"error" 只报错）。 */
    logLevel?: LogLevel;
    /** 子进程重启策略。 */
    restart?: RestartConfig;
}

/** 配置 schema（koishi）。 */
export const napukettoConfigSchema: Schema<NapukettoBotConfig> = Schema.object({
    selfId: Schema.string()
        .description("登录账号（QQ 号，数据目录账号隔离 + 快速登录账号）")
        .required(),
    qqPath: Schema.string().description("QQ 安装路径（缺省自动探测）"),
    stubDir: Schema.string().description("stub QQNT.dll 目录（缺省 loader 包内默认）"),
    dataDir: Schema.string().description("数据根目录（缺省自动解析）"),
    kernelEntry: Schema.string().description(
        "kernel 入口路径覆盖（高级项；缺省按 dependencies 自动解析）",
    ),
    selfHostEntry: Schema.string().description(
        "自建宿主入口路径覆盖（高级项；缺省 loader 包内默认）",
    ),
    adapterEntry: Schema.string().description(
        "OB11 动作桥 adapter 入口覆盖（高级项；缺省按依赖自动解析）",
    ),
    networkEntry: Schema.string().description(
        "OB11 动作桥 network 入口覆盖（高级项；缺省按依赖自动解析）",
    ),
    heartbeatTimeoutMs: Schema.number()
        .description("子进程心跳超时（毫秒，默认 45000）")
        .default(45_000),
    ob11Actions: Schema.boolean()
        .description(
            "OB11 动作桥（默认开）：子进程挂载全部 OneBot 11 动作" +
                "（send_like / set_group_ban 等 79 个，经 bot.internal._request 调用）" +
                "并透出 ob11 原始事件；关闭则只保留 kernel 动作面",
        )
        .default(true),
    logLevel: Schema.union([
        Schema.const("debug" as const),
        Schema.const("info" as const),
        Schema.const("error" as const),
        Schema.const("silent" as const),
    ])
        .description(
            "日志等级（默认 debug：子进程/事件/消息详细日志；info 只留消息与警告，" +
                "error 只报错，silent 关闭）",
        )
        .default("debug"),
    restart: Schema.object({
        maxRetries: Schema.number().description("最大重启次数（0 = 不重启，默认 3）").default(3),
        backoffMs: Schema.number().description("首次退避基数（毫秒，默认 1000）").default(1_000),
        backoffFactor: Schema.number().description("退避因子（默认 2）").default(2),
    }).description("子进程重启策略"),
}).description("NapukettoQQ 连接设置");
