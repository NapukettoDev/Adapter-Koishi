/**
 * transport.test.ts：传输层单测。
 *
 * BaseLineTransport 用最小子类 TestTransport 覆盖基类职责：dispatchLine 分发、
 * onLine/onClose 订阅与退订、close 幂等、closed 状态屏蔽、
 * onClosed 钩子（一次）。write 属子类职责（抽象方法），不在基类测试范围。
 *
 * ChildProcessIpcTransport 用 FakeChildProcess（PassThrough stdio）覆盖：
 * 原生噪音过滤（stdout 整行丢弃——噪音 ≠ 撕裂，不进 onLine 即不会触发
 * client 层 onJunkLine 诊断通道；stderr 透传同样过滤）、close 接线、stdio 守卫。
 */
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { NapukettoIpcClient } from "../../../../src/runtime/ipc/client.js";
import {
    BaseLineTransport,
    ChildProcessIpcTransport,
} from "../../../../src/runtime/ipc/transport.js";
import { ControlledWritable } from "../../../helpers/ipc.js";

/** 最小测试子类：暴露 dispatchLine 钩子 + 记录 onClosed 调用。 */
class TestTransport extends BaseLineTransport {
    readonly written: string[] = [];
    closedHookCalls = 0;

    write(line: string): void {
        this.written.push(line);
    }

    /** 测试辅助：模拟数据源收到一行。 */
    receive(line: string): void {
        this.dispatchLine(line);
    }

    protected override onClosed(): void {
        this.closedHookCalls += 1;
    }
}

describe("BaseLineTransport", () => {
    it("onLine 订阅 → dispatchLine 分发", () => {
        const transport = new TestTransport();
        const received: string[] = [];
        transport.onLine((line) => {
            received.push(line);
        });
        transport.receive("a");
        transport.receive("b");
        expect(received).toEqual(["a", "b"]);
    });

    it("onLine 退订后不再收到", () => {
        const transport = new TestTransport();
        const received: string[] = [];
        const unsubscribe = transport.onLine((line) => {
            received.push(line);
        });
        transport.receive("a");
        unsubscribe();
        transport.receive("b");
        expect(received).toEqual(["a"]);
    });

    it("onClose 订阅 → close 时通知", () => {
        const transport = new TestTransport();
        let closed = 0;
        transport.onClose(() => {
            closed += 1;
        });
        transport.close();
        expect(closed).toBe(1);
    });

    it("close 幂等：第二次 close 不重复触发 onClose / onClosed", () => {
        const transport = new TestTransport();
        let closed = 0;
        transport.onClose(() => {
            closed += 1;
        });
        transport.close();
        transport.close(); // 第二次应为 no-op
        expect(closed).toBe(1);
        expect(transport.closedHookCalls).toBe(1);
    });

    it("close 后 dispatchLine 忽略（不再通知 onLine 订阅者）", () => {
        const transport = new TestTransport();
        const received: string[] = [];
        transport.onLine((line) => {
            received.push(line);
        });
        transport.receive("a");
        transport.close();
        transport.receive("b"); // closed 后应被丢弃
        expect(received).toEqual(["a"]);
    });

    it("onClosed 钩子在 close 时调用一次（资源清理）", () => {
        const transport = new TestTransport();
        expect(transport.closedHookCalls).toBe(0);
        transport.close();
        expect(transport.closedHookCalls).toBe(1);
    });

    it("write 直达子类实现（基类不拦截）", () => {
        const transport = new TestTransport();
        transport.write("line1");
        transport.write("line2");
        expect(transport.written).toEqual(["line1", "line2"]);
    });
});

/** 最小 fake ChildProcess：PassThrough stdout / 消音 stdin / 可选 stderr / close 注册表。 */
class FakeChildProcess extends EventEmitter {
    readonly stdout = new PassThrough();
    readonly stdin: Writable;
    readonly stderr: PassThrough | null;
    constructor(options: { stderr?: boolean; stdin?: Writable } = {}) {
        super();
        this.stdin =
            options.stdin ?? new Writable({ write: (_chunk, _encoding, callback) => callback() });
        this.stderr = options.stderr === true ? new PassThrough() : null;
    }
}

function createControlledTransport() {
    const stdin = new ControlledWritable();
    const child = new FakeChildProcess({ stdin });
    const onWriteError = vi.fn();
    const transport = new ChildProcessIpcTransport(child as unknown as ChildProcess, onWriteError);
    const onClose = vi.fn();
    transport.onClose(onClose);
    const client = new NapukettoIpcClient(transport);
    return { stdin, child, onWriteError, transport, onClose, client };
}

/** 等待 readline 从流中收行（write 异步推进，两拍 setImmediate 收齐）。 */
async function flushStreams(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("ChildProcessIpcTransport", () => {
    it("stdio 未启用（stdout/stdin 为 null）抛 KernelError", () => {
        const bare = { stdout: null, stdin: null } as unknown as ChildProcess;
        expect(() => new ChildProcessIpcTransport(bare)).toThrow(
            "子进程 stdio 未启用（需要 stdout/stdin pipe）",
        );
    });

    it("stdout 协议行分发、原生噪音行静默丢弃（不进 onLine）", async () => {
        const child = new FakeChildProcess();
        const transport = new ChildProcessIpcTransport(child as unknown as ChildProcess);
        const received: string[] = [];
        transport.onLine((line) => {
            received.push(line);
        });
        child.stdout.write('{"v":1,"type":"ping"}\n');
        child.stdout.write("<MMKV> close finish, remains = 0\n");
        child.stdout.write('{"v":1,"type":"pong"}\n');
        child.stdout.write("loaded [mmkv.default] with 0 key-values\n");
        await flushStreams();
        expect(received).toEqual(['{"v":1,"type":"ping"}', '{"v":1,"type":"pong"}']);
        transport.close();
    });

    it("stderr 透传：原生噪音行过滤、其余带前缀透传", async () => {
        const child = new FakeChildProcess({ stderr: true });
        const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
        const transport = new ChildProcessIpcTransport(child as unknown as ChildProcess);
        child.stderr?.write("wine: could not load qq.exe\n");
        child.stderr?.write("<MMKV> close finish, remains = 0\n");
        await flushStreams();
        expect(stderrSpy).toHaveBeenCalledTimes(1);
        expect(stderrSpy).toHaveBeenCalledWith("[napuketto 子进程] wine: could not load qq.exe\n");
        stderrSpy.mockRestore();
        transport.close();
    });

    it("子进程 close 事件 → 通道关闭（onClose 通知一次）", () => {
        const child = new FakeChildProcess();
        const transport = new ChildProcessIpcTransport(child as unknown as ChildProcess);
        let closed = 0;
        transport.onClose(() => {
            closed += 1;
        });
        child.emit("close");
        expect(closed).toBe(1);
    });

    it.each(["end", "destroy"] as const)("stdin 已 %s：写入前立即关闭通道", async (method) => {
        const { stdin, onWriteError, onClose, client } = createControlledTransport();
        const pending = expect(client.request("pending")).rejects.toMatchObject({ code: "CLOSED" });
        stdin.completeWrite();
        stdin[method]();

        const next = client.request("after-end");
        expect(client.alive).toBe(false);
        await expect(next).rejects.toMatchObject({ code: "CLOSED" });
        await pending;
        expect(stdin.written).toHaveLength(1);
        expect(onWriteError).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ code: "IPC_STDIN_UNAVAILABLE" }),
        );
        expect(onClose).toHaveBeenCalledOnce();
    });

    it("提交的写入异步失败时拒绝所有在途请求，回调和 error 事件只关闭一次", async () => {
        const { stdin, child, onWriteError, transport, onClose, client } =
            createControlledTransport();
        const pending = [client.request("first"), client.request("queued")].map((request) =>
            expect(request).rejects.toMatchObject({ code: "CLOSED" }),
        );
        expect(client.alive).toBe(true);
        const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
        stdin.completeWrite(error);
        await flushStreams();
        expect(client.alive).toBe(false);
        await Promise.all(pending);
        await expect(client.request("later")).rejects.toMatchObject({ code: "CLOSED" });
        child.emit("close");
        transport.close();
        expect(onClose).toHaveBeenCalledOnce();
        expect(onWriteError).toHaveBeenCalledExactlyOnceWith(error);
        expect(stdin.listenerCount("error")).toBe(0);
    });

    it("stdin 无 error 事件时也处理已提交写入的回调错误", async () => {
        const { stdin, onWriteError, client } = createControlledTransport();
        stdin.cork();
        const pending = expect(client.request("corked")).rejects.toMatchObject({ code: "CLOSED" });
        expect(stdin.writableLength).toBeGreaterThan(0);
        stdin.destroy();
        await flushStreams();
        expect(client.alive).toBe(false);
        await pending;
        expect(onWriteError).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ code: "ERR_STREAM_DESTROYED" }),
        );
    });

    it("没有待完成的写入时也捕获 stdin 流错误", async () => {
        const { stdin, onWriteError, onClose, client } = createControlledTransport();
        const pending = expect(client.request("pending")).rejects.toMatchObject({ code: "CLOSED" });
        stdin.completeWrite();
        const error = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
        stdin.destroy(error);
        await flushStreams();
        expect(client.alive).toBe(false);
        await pending;
        expect(onClose).toHaveBeenCalledOnce();
        expect(onWriteError).toHaveBeenCalledExactlyOnceWith(error);
    });

    it.each(["client", "child"])("%s 提前关闭后仍处理已提交写入的晚到 error", async (mode) => {
        const { stdin, child, onWriteError, onClose, client } = createControlledTransport();
        const pending = expect(client.request("pending")).rejects.toMatchObject({ code: "CLOSED" });
        if (mode === "client") {
            client.close();
        } else {
            child.emit("close");
        }
        await pending;
        const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
        stdin.completeWrite(error);
        await flushStreams();

        expect(onClose).toHaveBeenCalledOnce();
        expect(onWriteError).toHaveBeenCalledExactlyOnceWith(error);
        expect(stdin.listenerCount("error")).toBe(0);
    });

    it("正常写入在背压下仍发送完整行并接收响应", async () => {
        const { stdin, child, onWriteError, client } = createControlledTransport();
        const pending = client.request("example");
        expect(stdin.writableNeedDrain).toBe(true);
        expect(stdin.written).toEqual([
            '{"v":1,"type":"action","id":1,"payload":{"action":"example"}}\n',
        ]);
        stdin.completeWrite();
        child.stdout.write('{"v":1,"type":"result","id":1,"payload":{"ok":true,"value":"ok"}}\n');
        await expect(pending).resolves.toBe("ok");
        expect(client.alive).toBe(true);
        expect(onWriteError).not.toHaveBeenCalled();
        client.close();
        stdin.destroy();
    });

    it.each(["主动关闭", "子进程关闭"])("%s 后移除 stdout、stderr 和 child 监听", (mode) => {
        const child = new FakeChildProcess({ stderr: true });
        const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
        try {
            const transport = new ChildProcessIpcTransport(child as unknown as ChildProcess);
            const onLine = vi.fn();
            const onClose = vi.fn();
            transport.onLine(onLine);
            transport.onClose(onClose);
            if (mode === "主动关闭") {
                transport.close();
            } else {
                child.emit("close");
            }
            child.stdout.write("late stdout\n");
            child.stderr?.write("late stderr\n");
            child.emit("close");
            expect(onLine).not.toHaveBeenCalled();
            expect(stderrSpy).not.toHaveBeenCalled();
            expect(onClose).toHaveBeenCalledOnce();
            expect(child.listenerCount("close")).toBe(0);
            for (const event of ["data", "end", "error"]) {
                expect(child.stdout.listenerCount(event)).toBe(0);
                expect(child.stderr?.listenerCount(event)).toBe(0);
            }
        } finally {
            stderrSpy.mockRestore();
        }
    });
});
