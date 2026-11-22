import type { IpcEventPayload } from "../ipc/index.js";

/** booting 阶段状态重查间隔（毫秒）：status 丢失后定期向子进程重同步。 */
const BOOT_STATUS_QUERY_INTERVAL_MS = 20_000;

/** 状态重查节流下限（毫秒）：事件风暴下避免 control status 刷屏。 */
const STATUS_QUERY_MIN_INTERVAL_MS = 5_000;

/** 单次引导暂存的事件数上限，超限丢弃最旧事件。 */
const MAX_STARTUP_EVENTS = 256;

export class BootResyncBuffer {
    private pending: IpcEventPayload[] | null = null;
    private lastQueryAt: number | null = null;
    private timer: NodeJS.Timeout | null = null;

    constructor(
        private readonly isBooting: () => boolean,
        private readonly query: () => void,
        private readonly dispatch: (payload: IpcEventPayload) => void,
    ) {}

    open(): void {
        this.pending = [];
        this.lastQueryAt = null;
    }

    updateTimer(): void {
        if (this.isBooting()) {
            this.timer ??= setInterval(() => {
                if (this.isBooting()) {
                    this.resync();
                }
            }, BOOT_STATUS_QUERY_INTERVAL_MS);
        } else if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    enqueue(payload: IpcEventPayload): boolean {
        const pending = this.pending;
        if (pending === null) {
            return false;
        }
        if (pending.length === MAX_STARTUP_EVENTS) {
            pending.shift();
        }
        pending.push(payload);
        // 先入队，再查状态。传输层可能同步重播 ready。
        if (this.isBooting()) {
            this.resync();
        }
        return true;
    }

    flush(): void {
        const pending = this.pending;
        if (pending === null) {
            return;
        }
        // 派发可能同步停止驱动，余下事件随旧连接丢弃。
        while (this.pending === pending) {
            const payload = pending.shift();
            if (payload === undefined) {
                this.discard();
                return;
            }
            this.dispatch(payload);
        }
    }

    discard(): void {
        this.pending = null;
    }

    private resync(): void {
        const now = Date.now();
        if (this.lastQueryAt !== null && now - this.lastQueryAt < STATUS_QUERY_MIN_INTERVAL_MS) {
            return;
        }
        this.lastQueryAt = now;
        this.query();
    }
}
