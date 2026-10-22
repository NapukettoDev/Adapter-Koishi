/**
 * backoff.ts：指数退避纯函数（崩溃/失联重启用，docs/internals/runtime.md）。
 */
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
