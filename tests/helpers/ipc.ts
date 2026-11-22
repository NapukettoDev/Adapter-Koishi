/**
 * ipc.ts：IPC 层测试共享设施。
 * MemoryLinePair（内存双端传输）+ captureAction（捕获对端发出的 action 请求）。
 */
import { Writable } from "node:stream";
import { decodeIpcMessage, type IpcMessage } from "../../src/runtime/ipc/index.js";
import { BaseLineTransport } from "../../src/runtime/ipc/transport.js";

/** 保留真实 Writable 的排队和 error 语义，由测试控制每次写入完成。 */
export class ControlledWritable extends Writable {
    readonly written: string[] = [];
    private finishWrite: ((error?: Error | null) => void) | undefined;

    constructor() {
        super({ highWaterMark: 1 });
    }

    override _write(
        chunk: Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
    ): void {
        this.written.push(chunk.toString());
        this.finishWrite = callback;
    }

    completeWrite(error?: Error): void {
        const finish = this.finishWrite;
        if (finish === undefined) {
            throw new Error("没有待完成的写入");
        }
        this.finishWrite = undefined;
        finish(error);
    }
}

/** 内存双端传输：一端 write → 对端（peer）lineHandlers 立即收到。 */
export class MemoryLinePair extends BaseLineTransport {
    readonly peer: MemoryLinePair;

    constructor(peer?: MemoryLinePair) {
        super();
        // 构造时互指：new MemoryLinePair() 自动成对
        this.peer = peer ?? new MemoryLinePair(this);
    }

    /** 写入对端（管道语义：write 进一端 = 对端收到）。 */
    write(line: string): void {
        this.peer.dispatchLine(line);
    }
}

/** 捕获对端发出的第一个 action 请求（先注册再发请求，不泄漏订阅）。 */
export async function captureAction(
    pair: MemoryLinePair,
): Promise<Extract<IpcMessage, { type: "action" }> | null> {
    let captured: Extract<IpcMessage, { type: "action" }> | null = null;
    pair.peer.onLine((line) => {
        const msg = decodeIpcMessage(line);
        if (msg?.type === "action" && captured === null) {
            captured = msg;
        }
    });
    await Promise.resolve(); // 让已同步发出的消息被处理
    return captured;
}
