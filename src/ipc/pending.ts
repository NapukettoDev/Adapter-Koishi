/**
 * pending.ts：动作请求-响应匹配管理（自 client.ts 拆出）。
 *
 * 职责：单调递增 id 分配 + pending Map + 超时清理 + 批量 reject。
 * 独立成类后 client.ts 只做线路处理（编解码/心跳/事件分发），
 * 请求生命周期可单测（注入假超时）。
 */
import { IpcError } from "../shared/errors.js";

/** 动作请求超时（毫秒）。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** pending 请求条目。 */
interface PendingRequest {
    action: string;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
    timer: NodeJS.Timeout;
}

/** 已发送待响应的动作请求集合（单调 id + Map）。 */
export class PendingRequests {
    private readonly pending = new Map<number, PendingRequest>();
    private nextId = 1;

    /**
     * 登记一个请求：分配 id + 启动超时，返回 id 与 Promise。
     * 调用方拿到 id 后负责发送消息；响应到达时调 resolve/reject。
     */
    add(action: string, timeoutMs: number): { id: number; promise: Promise<unknown> } {
        const id = this.nextId++;
        return {
            id,
            promise: new Promise<unknown>((resolve, reject) => {
                const timer = setTimeout(() => {
                    this.pending.delete(id);
                    reject(new IpcError(`动作超时（${timeoutMs}ms）: ${action}`, "TIMEOUT"));
                }, timeoutMs);
                this.pending.set(id, { action, resolve, reject, timer });
            }),
        };
    }

    /** 成功响应：resolve 对应请求（不存在则忽略——迟到响应）。 */
    resolve(id: number, value: unknown): boolean {
        const pending = this.pending.get(id);
        if (pending === undefined) {
            return false; // 迟到的响应：忽略
        }
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.resolve(value);
        return true;
    }

    /** 失败响应：reject 对应请求（错误消息带上动作名，便于日志反查）。 */
    reject(id: number, error: { code: string; message: string }): boolean {
        const pending = this.pending.get(id);
        if (pending === undefined) {
            return false; // 迟到的响应：忽略
        }
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(new IpcError(`动作 ${pending.action} 失败: ${error.message}`, error.code));
        return true;
    }

    /** 通道关闭：全部 reject（幂等）。 */
    rejectAll(): void {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new IpcError("IPC 通道已关闭", "CLOSED"));
        }
        this.pending.clear();
    }
}
