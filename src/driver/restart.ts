import type { RestartPolicy } from "./types.js";

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
