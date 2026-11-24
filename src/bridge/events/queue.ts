/**
 * queue.ts：入站消息的按频道有界队列（docs/internals/events.md）。
 *
 * 同一频道串行执行以保持派发顺序，不同频道并行。队列按「每频道」和「全局」
 * 双重有界；饱和时不无限积压，由调用方立即执行并诊断（顺序降级）。
 * 取消按事件桥代次生效：运行中的任务收到 abort，仍在排队的任务直接丢弃并
 * 执行各自的清理回调。
 */

/** 队列饱和原因（频道积压 / 全局积压）。 */
export type QueueOverflowReason = "channel" | "total";

/** 一个排队任务；取消时运行中的任务通过 signal 中止，未运行的任务调用 cancel。 */
export interface QueueTask {
    /** 执行任务；signal 在事件桥取消时 abort。 */
    run(signal: AbortSignal): Promise<void>;
    /** 排队中被取消的清理（任务不会执行）。 */
    cancel?(): void;
}

export interface ChannelQueueOptions {
    /** 每频道最多积压的待执行任务数。 */
    maxPendingPerChannel?: number;
    /** 所有频道合计最多积压的待执行任务数。 */
    maxPendingTotal?: number;
    /** 饱和回调（随后任务仍会立即执行）。 */
    onOverflow?: (key: string, reason: QueueOverflowReason) => void;
}

interface PendingItem {
    task: QueueTask;
}

interface ChannelState {
    running: boolean;
    readonly pending: PendingItem[];
}

/** 默认每频道积压上限。 */
export const DEFAULT_MAX_PENDING_PER_CHANNEL = 64;
/** 默认全局积压上限。 */
export const DEFAULT_MAX_PENDING_TOTAL = 256;

export class BoundedChannelQueue {
    private readonly maxPerChannel: number;
    private readonly maxTotal: number;
    private readonly onOverflow: ChannelQueueOptions["onOverflow"];
    private readonly channels = new Map<string, ChannelState>();
    private readonly controllers = new Set<AbortController>();
    private pendingTotal = 0;
    private epoch = 0;

    constructor(options: ChannelQueueOptions = {}) {
        this.maxPerChannel = options.maxPendingPerChannel ?? DEFAULT_MAX_PENDING_PER_CHANNEL;
        this.maxTotal = options.maxPendingTotal ?? DEFAULT_MAX_PENDING_TOTAL;
        this.onOverflow = options.onOverflow;
    }

    /** 当前积压任务数（不含运行中）。 */
    get pending(): number {
        return this.pendingTotal;
    }

    /** 当前运行中的任务数。 */
    get running(): number {
        return this.controllers.size;
    }

    /**
     * 入队。返回 `queued` 表示按序排队；`overflow` 表示队列已饱和，
     * 任务已被立即执行（调用方应已收到 onOverflow 诊断）。
     */
    enqueue(key: string, task: QueueTask): "queued" | "overflow" {
        const state = this.channels.get(key);
        if (state === undefined || (!state.running && state.pending.length === 0)) {
            const fresh: ChannelState = { running: true, pending: [] };
            this.channels.set(key, fresh);
            this.run(key, fresh, task);
            return "queued";
        }
        if (state.pending.length >= this.maxPerChannel || this.pendingTotal >= this.maxTotal) {
            this.reportOverflow(
                key,
                state.pending.length >= this.maxPerChannel ? "channel" : "total",
            );
            // 饱和降级：不进入队列，立即执行以避免无界积压；与同频道后续
            // 任务之间不再保证顺序，由调用方记录诊断。
            this.run(key, undefined, task);
            return "overflow";
        }
        state.pending.push({ task });
        this.pendingTotal += 1;
        return "queued";
    }

    /**
     * 取消当前代次的全部工作：递增代次、中止运行中的任务、丢弃排队任务。
     * 旧代次任务结束时不驱动新代次的队列。
     */
    cancelAll(reason?: unknown): void {
        this.epoch += 1;
        for (const controller of this.controllers) {
            controller.abort(reason);
        }
        for (const state of this.channels.values()) {
            for (const item of state.pending) {
                this.cancelTask(item.task);
            }
        }
        this.channels.clear();
        this.pendingTotal = 0;
    }

    private run(key: string, state: ChannelState | undefined, task: QueueTask): void {
        const controller = new AbortController();
        const epoch = this.epoch;
        this.controllers.add(controller);
        void (async () => {
            try {
                await task.run(controller.signal);
            } catch {
                // 任务自行上报诊断；这里只保证不产生未处理 rejection。
            } finally {
                this.controllers.delete(controller);
                // 旧代次任务不推进新代次的队列，也不删除新代次的频道状态。
                const current =
                    epoch === this.epoch && state !== undefined && this.channels.get(key) === state;
                if (current && state !== undefined) {
                    const next = state.pending.shift();
                    if (next === undefined) {
                        state.running = false;
                        this.channels.delete(key);
                    } else {
                        this.pendingTotal -= 1;
                        this.run(key, state, next.task);
                    }
                }
            }
        })();
    }

    private cancelTask(task: QueueTask): void {
        try {
            task.cancel?.();
        } catch {
            // 清理回调异常不得阻塞其余任务的取消。
        }
    }

    private reportOverflow(key: string, reason: QueueOverflowReason): void {
        try {
            this.onOverflow?.(key, reason);
        } catch {
            // 诊断回调异常不得影响入站事件处理。
        }
    }
}
