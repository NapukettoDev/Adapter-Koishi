import {
    IPC_VERSION,
    type IpcActionMessage,
    type IpcControlPayload,
    type IpcMessage,
    IpcMessageSchema,
    type IpcResultMessage,
} from "@napuketto/loader";
import { IpcError } from "../../shared.js";
import { DEFAULT_MAX_IPC_LINE_BYTES, DEFAULT_MAX_PENDING_REQUESTS } from "./limits.js";
import { DEFAULT_REQUEST_TIMEOUT_MS, PendingRequests } from "./pending.js";
import type { IpcLineTransport } from "./transport.js";

/**
 * client.ts：IPC 客户端（插件侧）。
 *
 * 职责（docs/internals/runtime.md）：
 *  - 传输 + 编解码接线
 *  - 请求-响应匹配（单调递增 id + pending Map + 超时清理）
 *  - 请求生命周期收口：编码、登记或发送任一步失败都回到 pending 清理
 *  - 心跳（子进程发 ping → 自动回 pong，记录 lastPingAt/lastPongAt/lastSeenAt）
 *  - 事件分发（on(type, handler)，泛型收窄到具体消息类型）
 */

/** 客户端选项。 */
interface IpcClientOptions {
    /** 动作请求超时（毫秒，默认 60s）。 */
    requestTimeoutMs?: number;
    /** 同时在途请求上限（默认 256），超限请求立即失败。 */
    maxPending?: number;
    /** 单条出站 IPC 行字节上限（默认 16 MiB，不含行尾 LF）。 */
    maxLineBytes?: number;
    /** 无法解析的行回调（诊断：stdout 被并发输出撕裂/原生 printf 污染时留痕，
     * 不再静默丢弃——调用方接 logger，见 driver 的 onJunkLine 接线）。 */
    onJunkLine?: () => void;
    /** 单条消息订阅者抛错时的诊断回调；不影响同类型其余订阅者。 */
    onHandlerError?: (error: unknown, type: IpcMessage["type"]) => void;
}

/** 心跳采样：子进程发 ping → 自动回 pong。 */
export class NapukettoIpcClient {
    private readonly handlers = new Map<IpcMessage["type"], Set<(message: unknown) => void>>();
    private readonly pending: PendingRequests;
    private readonly maxLineBytes: number;
    private lastPingAt = 0;
    private lastPongAt = 0;
    private lastSeenAt = 0;
    private closed = false;

    constructor(
        private readonly transport: IpcLineTransport,
        private readonly options: IpcClientOptions = {},
    ) {
        this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_IPC_LINE_BYTES;
        this.pending = new PendingRequests(options.maxPending ?? DEFAULT_MAX_PENDING_REQUESTS);
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

    /** 当前在途请求数（诊断与容量断言）。 */
    get pendingCount(): number {
        return this.pending.size;
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
     *
     * 成功响应 resolve；远端失败 reject 为携带远端错误码的 IpcError；
     * 超时 reject IpcError("TIMEOUT")；通道关闭 reject IpcError("CLOSED")。
     * 本地编码、单行上限、在途容量或同步发送失败时立即 reject，并回收该请求的
     * 定时器与 id 簿记（不留下悬挂 pending）。
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
        let id: number | undefined;
        let promise: Promise<unknown> | undefined;
        try {
            const entry = this.pending.add(action, timeout);
            id = entry.id;
            promise = entry.promise;
            const payload: IpcActionMessage["payload"] =
                params === undefined ? { action } : { action, params };
            const line = this.encode({ v: IPC_VERSION, type: "action", id, payload });
            this.writeLine(line);
            return promise;
        } catch (error) {
            const failure = toIpcError(error);
            if (id !== undefined) {
                this.pending.rejectWith(id, failure);
            }
            // 同步写入抛错说明传输已不可用；关闭会以 CLOSED 结束其余在途请求。
            if (failure.code === "IPC_SEND_FAILED") {
                this.close();
            }
            return promise ?? Promise.reject(failure);
        }
    }

    /**
     * 发送控制指令（stop / restart / login）。
     * 返回是否已提交给传输；编码或同步写入失败返回 false（发送失败会关闭通道）。
     */
    sendControl(payload: IpcControlPayload): boolean {
        try {
            this.writeLine(this.encode({ v: IPC_VERSION, type: "control", payload }));
            return true;
        } catch (error) {
            if (toIpcError(error).code === "IPC_SEND_FAILED") {
                this.close();
            }
            return false;
        }
    }

    /** 主动关闭通道（幂等）：pending 全部 reject，通知传输关闭。 */
    close(): void {
        if (this.closed) {
            return;
        }
        this.handleClose();
        try {
            this.transport.close();
        } catch {
            // 客户端状态已关闭；传输清理异常不反向影响调用方。
        }
    }

    private send(message: IpcMessage): void {
        this.writeLine(this.encode(message));
    }

    /** 编码并实施单行字节上限（不含行尾 LF）。 */
    private encode(message: IpcMessage): string {
        let line: string;
        try {
            line = encodeIpcMessage(message);
        } catch (error) {
            throw new IpcError(`IPC 消息编码失败: ${describeError(error)}`, "IPC_ENCODE_FAILED");
        }
        const bytes = Buffer.byteLength(line, "utf8") - 1;
        if (bytes > this.maxLineBytes) {
            throw new IpcError(
                `IPC 消息超过单行上限（${bytes} > ${this.maxLineBytes} 字节）`,
                "IPC_LINE_TOO_LARGE",
            );
        }
        return line;
    }

    /** 写入一行；通道已关闭或同步写入抛错时转换为 IpcError。 */
    private writeLine(line: string): void {
        if (this.closed) {
            throw new IpcError("IPC 通道已关闭", "CLOSED");
        }
        try {
            this.transport.write(line);
        } catch (error) {
            throw new IpcError(`IPC 消息发送失败: ${describeError(error)}`, "IPC_SEND_FAILED");
        }
    }

    private handleLine(line: string): void {
        if (this.closed) {
            return;
        }
        const message = decodeIpcMessage(line);
        if (message === null) {
            // 非法行：不静默丢弃（撕裂/污染留痕，调用方可接日志）
            try {
                this.options.onJunkLine?.();
            } catch {
                // 诊断回调异常不得中断后续 IPC 行。
            }
            return;
        }
        this.lastSeenAt = Date.now();
        switch (message.type) {
            case "ping":
                this.lastPingAt = Date.now();
                try {
                    this.send({ v: IPC_VERSION, type: "pong" });
                } catch {
                    // 心跳应答失败视为通道不可用；关闭后由 driver 处理进程生命周期。
                    this.close();
                    return;
                }
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
        this.handlers.clear();
    }

    private dispatch(message: IpcMessage): void {
        const set = this.handlers.get(message.type);
        if (set === undefined) {
            return;
        }
        for (const handler of [...set]) {
            try {
                handler(message);
            } catch (error) {
                // 单个订阅者异常不得中断同类型其余订阅者或后续 IPC 行。
                try {
                    this.options.onHandlerError?.(error, message.type);
                } catch {
                    // 诊断回调自身异常也不反向影响通道。
                }
            }
        }
    }
}

/** 把任意错误转换为带 IPC 错误码的 IpcError（已是 IpcError 时保留原码）。 */
function toIpcError(error: unknown): IpcError {
    if (error instanceof IpcError) {
        return error;
    }
    return new IpcError(`IPC 请求失败: ${describeError(error)}`, "IPC_SEND_FAILED");
}

/** 安全提取错误描述，避免异常对象自身的 getter/toString 再次抛错。 */
function describeError(error: unknown): string {
    try {
        return error instanceof Error ? error.message : String(error);
    } catch {
        return "未知错误";
    }
}

/**
 * IPC 消息编解码（JSON 行协议）。
 *
 * 每行一条 JSON 消息，`\n` 结尾（stdout 收行 / stdin 发行）。
 * 解码宽松：非法行 / 空行 / v 不匹配 / 未知 type → null，调用方记日志跳过，
 * 不崩通道。
 */

/** 编码为 JSON 行（追加换行）。 */
export function encodeIpcMessage(message: IpcMessage): string {
    return `${JSON.stringify(message)}\n`;
}

/** 解码一行 JSON；非法行/空行/形状不合法返回 null。 */
export function decodeIpcMessage(line: string): IpcMessage | null {
    const trimmed = line.trim();
    if (trimmed === "") {
        return null;
    }
    try {
        const parsed: unknown = JSON.parse(trimmed);
        const result = IpcMessageSchema.safeParse(parsed);
        return result.success ? result.data : null;
    } catch {
        return null;
    }
}
