import type { DriverState, RestartPolicy } from "./types.js";

/**
 * 心跳健康监控。
 *
 * 职责：以固定间隔轮询「最近消息时间」，超过心跳超时判定失联 → 回调。
 * 独立成类后 driver 只负责接线（提供 seenAt/spawnAt 采样 + 失联回调），
 * 心跳逻辑可单测（注入假时钟/假采样）。
 */

/** 心跳采样源（driver 提供：客户端最近消息时间 + spawn 时间 + 当前状态）。 */
export interface HeartbeatSource {
    /** 最近收到子进程任何消息的时间戳（epoch ms），0 = 从未收到。 */
    seenAt: () => number;
    /** 最近一次 spawn 的时间戳（epoch ms），0 = 未 spawn。 */
    spawnAt: () => number;
    /** 当前驱动状态（仅 booting / ready 时判定）。 */
    state: () => DriverState;
}

/** 心跳监控器（构造时给定轮询间隔与失联阈值；start 后持续轮询）。 */
export class HeartbeatMonitor {
    private timer: NodeJS.Timeout | null = null;

    constructor(
        private readonly source: HeartbeatSource,
        private readonly options: {
            /** 轮询间隔（毫秒）。 */
            intervalMs: number;
            /** 心跳超时（毫秒）：超过即判定失联。 */
            timeoutMs: number;
            /** 失联回调（driver 负责 kill + 重启）。 */
            onStale: () => void;
        },
    ) {}

    /** 开始轮询（幂等：已有 timer 直接忽略）。 */
    start(): void {
        if (this.timer !== null) {
            return;
        }
        this.timer = setInterval(() => {
            this.check();
        }, this.options.intervalMs);
    }

    /** 停止轮询（幂等）。 */
    stop(): void {
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /** 单次判定（可单测：注入 source 后直接调用）。 */
    check(): void {
        const state = this.source.state();
        if (state !== "booting" && state !== "ready") {
            return;
        }
        // 距最后一条消息超时 → 判定失联（兜 dlopen/登录卡死：
        // 从未收到消息时用 spawn 时间兜底，spawn 后无任何消息同样判失联）
        const lastSeen = this.source.seenAt();
        const reference = lastSeen > 0 ? lastSeen : this.source.spawnAt();
        if (reference > 0 && Date.now() - reference > this.options.timeoutMs) {
            this.options.onStale();
        }
    }
}

/** 默认重启策略。 */
const DEFAULT_RESTART: Required<RestartPolicy> = {
    maxRetries: 3,
    backoffMs: 1_000,
    backoffFactor: 2,
};

/** 退避计算：第 attempt 次（从 1 起）重启的等待毫秒。 */
export function backoffDelay(
    attempt: number,
    baseMs: number,
    factor: number,
    maxMs?: number,
): number {
    const delay = baseMs * factor ** Math.max(0, attempt - 1);
    return maxMs !== undefined ? Math.min(delay, maxMs) : delay;
}

export class RestartScheduler {
    private readonly policy: Required<RestartPolicy>;
    private count = 0;
    private timer: NodeJS.Timeout | null = null;

    constructor(policy?: RestartPolicy) {
        this.policy = {
            maxRetries: policy?.maxRetries ?? DEFAULT_RESTART.maxRetries,
            backoffMs: policy?.backoffMs ?? DEFAULT_RESTART.backoffMs,
            backoffFactor: policy?.backoffFactor ?? DEFAULT_RESTART.backoffFactor,
        };
    }

    get attempts(): number {
        return this.count;
    }

    get exhausted(): boolean {
        return this.count >= this.policy.maxRetries;
    }

    reset(): void {
        this.count = 0;
    }

    schedule(spawn: () => void, attempt = this.count + 1): void {
        const delay = backoffDelay(
            Math.max(1, attempt),
            this.policy.backoffMs,
            this.policy.backoffFactor,
        );
        this.timer = setTimeout(() => {
            this.timer = null;
            this.count = attempt;
            spawn();
        }, delay);
    }

    cancel(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }
}
