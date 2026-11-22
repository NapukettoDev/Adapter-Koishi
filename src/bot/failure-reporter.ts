/**
 * 预热失败告警去重（docs/internals/bot.md）。
 *
 * 失败按「操作 + 平台 + 错误指纹」归并：首次完整告警保留错误对象（含堆栈），
 * 后续同因失败只计数；达到重复阈值或冷却时间后才再次输出摘要，避免刷屏。
 * 不同平台、不同错误码或不同错误消息各自成组，不会因某个组先告警而丢失证据。
 */

export interface FailureReporterOptions {
    /** 告警输出（reggol 风格：格式串 + 参数）。 */
    warn: (message: string, ...args: unknown[]) => void;
    /** 时钟（测试可注入）。 */
    now?: () => number;
    /** 每累计多少次同类失败追加一次摘要。 */
    repeatInterval?: number;
    /** 同一故障签名再次告警的最小间隔（毫秒）。 */
    cooldownMs?: number;
}

interface FailureRecord {
    count: number;
    lastReportedAt: number;
    /** 首次失败使用的记录键（保留原始证据）。 */
    sampleKey: string;
}

const DEFAULT_REPEAT_INTERVAL = 50;
const DEFAULT_COOLDOWN_MS = 60_000;

/** 读取错误的 code 字段（Node/SQL 驱动常用）。 */
function readErrorCode(error: unknown): string | undefined {
    if (typeof error !== "object" || error === null) return undefined;
    const code = (error as Record<string, unknown>)["code"];
    if (typeof code === "string" || typeof code === "number") return String(code);
    return undefined;
}

/**
 * 错误指纹：有 code 时忽略消息（唯一键错误消息常带记录键，按 target 分裂会刷屏）；
 * 无 code 时用消息区分不同原因。
 */
function fingerprint(error: unknown): string {
    const name = error instanceof Error ? error.name : "unknown";
    const code = readErrorCode(error);
    if (code !== undefined) return `${name}:${code}`;
    return `${name}:${error instanceof Error ? error.message : String(error)}`;
}

/** 预热失败告警器（每个根上下文共享一份）。 */
export class PreheatFailureReporter {
    private readonly records = new Map<string, FailureRecord>();
    private readonly warn: FailureReporterOptions["warn"];
    private readonly now: () => number;
    private readonly repeatInterval: number;
    private readonly cooldownMs: number;

    constructor(options: FailureReporterOptions) {
        this.warn = options.warn;
        this.now = options.now ?? Date.now;
        this.repeatInterval = options.repeatInterval ?? DEFAULT_REPEAT_INTERVAL;
        this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    }

    /** 记录一次预热失败；绝不抛错（含日志后端异常）。 */
    report(operation: string, platform: string, key: string, error: unknown): void {
        const signature = `${operation}\u0000${platform}\u0000${fingerprint(error)}`;
        const at = this.now();
        const record = this.records.get(signature);
        if (record === undefined) {
            this.records.set(signature, {
                count: 1,
                lastReportedAt: at,
                sampleKey: key,
            });
            this.emit(
                "[napuketto] %s 预热失败（%s:%s，首次）: %o",
                operation,
                platform,
                key,
                error,
            );
            return;
        }
        record.count += 1;
        const dueByCount = this.repeatInterval > 0 && record.count % this.repeatInterval === 0;
        const dueByTime = at - record.lastReportedAt >= this.cooldownMs;
        if (!dueByCount && !dueByTime) return;
        record.lastReportedAt = at;
        this.emit(
            "[napuketto] %s 预热失败累计 %d 次（最近 %s:%s，首次 %s:%s）: %o",
            operation,
            record.count,
            platform,
            key,
            platform,
            record.sampleKey,
            error,
        );
    }

    /** 日志后端异常不能反过来打断 dispatch。 */
    private emit(message: string, ...args: unknown[]): void {
        try {
            this.warn(message, ...args);
        } catch {
            // 上报失败只丢失诊断，不影响预热降级语义。
        }
    }
}
