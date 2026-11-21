/**
 * transport.ts：JSON 行传输抽象。
 *
 * 真实实现包装 ChildProcess stdio（stdout readline 收行 + stdin 发行）；
 * 测试注入内存双端（MemoryLinePair，见 index.test.ts）。
 */
import type { ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { Writable } from "node:stream";
import { KernelError } from "@napuketto/kernel";
import { isNativeNoiseLine } from "@napuketto/loader";
import { IpcError } from "./errors.js";
import { SubscriberSet } from "./subscribers.js";

/** JSON 行传输接口。 */
export interface IpcLineTransport {
    /** 发送一行（编码后的完整消息，含换行）。 */
    write(line: string): void;
    /** 订阅收到的行。返回退订函数。 */
    onLine(callback: (line: string) => void): () => void;
    /** 订阅通道关闭。返回退订函数。 */
    onClose(callback: () => void): () => void;
    /** 关闭通道（幂等）。 */
    close(): void;
}

/**
 * 行传输抽象基类：订阅管理（onLine/onClose/close）与 closed 状态共享。
 * 子类只实现 write 与数据源接线（dispatchLine/onClosed 钩子）。
 */
export abstract class BaseLineTransport implements IpcLineTransport {
    protected readonly lineHandlers = new SubscriberSet<[line: string]>();
    protected readonly closeHandlers = new SubscriberSet<[]>();
    protected closed = false;

    /** 发送一行。 */
    abstract write(line: string): void;

    /** 收到一行并分发（子类在数据源回调中调用；closed 后忽略）。 */
    protected dispatchLine(line: string): void {
        if (!this.closed) {
            this.lineHandlers.dispatch(line);
        }
    }

    onLine(callback: (line: string) => void): () => void {
        return this.lineHandlers.add(callback);
    }

    onClose(callback: () => void): () => void {
        return this.closeHandlers.add(callback);
    }

    close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.onClosed();
        this.closeHandlers.dispatch();
        this.lineHandlers.clear();
        this.closeHandlers.clear();
    }

    /** 子类钩子：关闭时的资源清理（默认无操作）。 */
    protected onClosed(): void {}
}

/** 基于 ChildProcess stdio 的传输：stdout 收行（readline），stdin 发行。 */
export class ChildProcessIpcTransport extends BaseLineTransport {
    private readonly stdin: Writable;
    private readonly stdoutLines: Interface;
    private readonly stderrLines: Interface | undefined;
    private writeFailed = false;

    private readonly onStdoutLine = (line: string): void => {
        // 整行原生噪音静默丢弃，协议行撕裂留给客户端诊断。
        if (!isNativeNoiseLine(line)) {
            this.dispatchLine(line);
        }
    };

    private readonly onStderrLine = (line: string): void => {
        if (!isNativeNoiseLine(line)) {
            process.stderr.write(`[napuketto 子进程] ${line}\n`);
        }
    };

    private readonly onChildClose = (): void => {
        this.close();
    };

    private readonly handleWriteError = (error?: Error | null): void => {
        if (error == null || this.writeFailed) {
            return;
        }
        // 同一次写入可能先调用回调，随后触发 stdin 的 error 事件。
        this.writeFailed = true;
        this.close();
        this.onWriteError?.(error);
    };

    constructor(
        private readonly child: ChildProcess,
        private readonly onWriteError?: (error: Error) => void,
    ) {
        super();
        const { stdin, stdout } = child;
        if (stdout === null || stdin === null) {
            throw new KernelError("子进程 stdio 未启用（需要 stdout/stdin pipe）", "INVALID_STATE");
        }
        this.stdin = stdin;
        // IPC 可以先于 stdin 关闭，已提交的写入此后仍可能触发 error。
        if (!stdin.closed) {
            stdin.on("error", this.handleWriteError);
            stdin.once("close", () => stdin.off("error", this.handleWriteError));
        }
        this.stdoutLines = createInterface({ input: stdout, crlfDelay: Infinity });
        this.stdoutLines.on("line", this.onStdoutLine);
        // stderr 保留宿主的原始诊断，同时过滤原生噪音。
        if (child.stderr !== null) {
            this.stderrLines = createInterface({ input: child.stderr, crlfDelay: Infinity });
            this.stderrLines.on("line", this.onStderrLine);
        }
        child.once("close", this.onChildClose);
    }

    write(line: string): void {
        if (this.closed) {
            return;
        }
        const { stdin } = this;
        if (!stdin.writable) {
            this.handleWriteError(
                stdin.errored ?? new IpcError("IPC stdin 不可写", "IPC_STDIN_UNAVAILABLE"),
            );
            return;
        }
        stdin.write(line, this.handleWriteError);
    }

    protected override onClosed(): void {
        this.child.off("close", this.onChildClose);
        this.stdoutLines.off("line", this.onStdoutLine).close();
        this.stderrLines?.off("line", this.onStderrLine).close();
    }
}
