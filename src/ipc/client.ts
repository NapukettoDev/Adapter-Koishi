/**
 * client.ts：IPC 客户端（插件侧）。
 *
 * 职责（docs/internals/runtime.md）：
 *  - 传输 + 编解码接线
 *  - 请求-响应匹配（单调递增 id + pending Map + 超时清理）
 *  - 心跳（子进程发 ping → 自动回 pong，记录 lastPingAt/lastPongAt/lastSeenAt）
 *  - 事件分发（on(type, handler)，泛型收窄到具体消息类型）
 */

import {
    IPC_VERSION,
    type IpcActionMessage,
    type IpcControlPayload,
    type IpcMessage,
    type IpcResultMessage,
} from "@napuketto/loader";
import { decodeIpcMessage, encodeIpcMessage } from "./codec.js";
import { IpcError } from "./errors.js";
import { DEFAULT_REQUEST_TIMEOUT_MS, PendingRequests } from "./pending.js";
import type { IpcLineTransport } from "./transport.js";

/** 客户端选项。 */
interface IpcClientOptions {
    /** 动作请求超时（毫秒，默认 60s）。 */
    requestTimeoutMs?: number;
    /** 无法解析的行回调（诊断：stdout 被并发输出撕裂/原生 printf 污染时留痕，
     * 不再静默丢弃——调用方接 logger，见 driver 的 onJunkLine 接线）。 */
    onJunkLine?: (line: string) => void;
}

/** 心跳采样：子进程发 ping → 自动回 pong。 */
export class NapukettoIpcClient {
    private readonly handlers = new Map<IpcMessage["type"], Set<(message: unknown) => void>>();
    private readonly pending = new PendingRequests();
    private lastPingAt = 0;
    private lastPongAt = 0;
    private lastSeenAt = 0;
    private closed = false;

    constructor(
        private readonly transport: IpcLineTransport,
        private readonly options: IpcClientOptions = {},
    ) {
        this.transport.onLine((line) => {
            this.handleLine(line);
        });
        this.transport.onClose(() => {
            this.handleClose();
        });
    }

    /** 最近收到子进程心跳（ping）的时间戳（epoch ms），0 = 从未收到。 */
    get pingAt(): number {
        return this.lastPingAt;
    }

    /** 最近收到子进程 pong 应答的时间戳（epoch ms），0 = 从未收到。 */
    get pongAt(): number {
        return this.lastPongAt;
    }

    /** 最近收到子进程任何消息的时间戳（epoch ms），0 = 从未收到。 */
    get seenAt(): number {
        return this.lastSeenAt;
    }

    /** 通道是否打开。 */
    get alive(): boolean {
        return !this.closed;
    }

    /**
     * 订阅指定类型的消息。泛型收窄到具体消息类型
     * （如 `on("event", (msg) => ...)` 中 msg 是 IpcEventMessage）。返回退订函数。
     */
    on<T extends IpcMessage["type"]>(
        type: T,
        handler: (message: Extract<IpcMessage, { type: T }>) => void,
    ): () => void {
        const wrapped = (message: unknown): void => {
            handler(message as Extract<IpcMessage, { type: T }>);
        };
        const set = this.handlers.get(type) ?? new Set<(message: unknown) => void>();
        set.add(wrapped);
        this.handlers.set(type, set);
        return () => {
            set.delete(wrapped);
        };
    }

    /**
     * 发送动作请求（koishi → kernel API，经子进程转发），等待 result 响应。
     * 超时 reject IpcError("TIMEOUT")；通道关闭 reject IpcError("CLOSED")。
     */
    request(
        action: string,
        params?: Record<string, unknown>,
        timeoutMs?: number,
    ): Promise<unknown> {
        if (this.closed) {
            return Promise.reject(new IpcError("IPC 通道已关闭", "CLOSED"));
        }
        const timeout = timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        const { id, promise } = this.pending.add(action, timeout);
        const payload: IpcActionMessage["payload"] =
            params === undefined ? { action } : { action, params };
        this.send({ v: IPC_VERSION, type: "action", id, payload });
        return promise;
    }

    /** 发送控制指令（stop / restart / login）。 */
    sendControl(payload: IpcControlPayload): void {
        this.send({ v: IPC_VERSION, type: "control", payload });
    }

    /** 主动关闭通道（幂等）：pending 全部 reject，通知传输关闭。 */
    close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.pending.rejectAll();
        this.transport.close();
    }

    private send(message: IpcMessage): void {
        if (this.closed) {
            return;
        }
        this.transport.write(encodeIpcMessage(message));
    }

    private handleLine(line: string): void {
        const message = decodeIpcMessage(line);
        if (message === null) {
            // 非法行：不静默丢弃（撕裂/污染留痕，调用方可接日志）
            this.options.onJunkLine?.(line);
            return;
        }
        this.lastSeenAt = Date.now();
        switch (message.type) {
            case "ping":
                this.lastPingAt = Date.now();
                this.send({ v: IPC_VERSION, type: "pong" });
                break;
            case "pong":
                this.lastPongAt = Date.now();
                break;
            case "result":
                this.handleResult(message);
                return; // result 只走 pending 匹配，不派发给事件订阅者
            default:
                break;
        }
        this.dispatch(message);
    }

    private handleResult(message: IpcResultMessage): void {
        const payload = message.payload;
        if (payload.ok) {
            this.pending.resolve(message.id, payload.value);
        } else {
            // 诊断（2026-08-09）：错误消息带上 action 名，方便日志反查
            // 是哪个动作失败（子进程完整堆栈见 boot 日志）。
            this.pending.reject(message.id, payload.error);
        }
    }

    private handleClose(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.pending.rejectAll();
    }

    private dispatch(message: IpcMessage): void {
        const set = this.handlers.get(message.type);
        if (set === undefined) {
            return;
        }
        for (const handler of [...set]) {
            handler(message);
        }
    }
}
