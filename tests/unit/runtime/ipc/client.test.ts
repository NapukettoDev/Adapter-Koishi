/**
 * client.test.ts：NapukettoIpcClient 单测。
 *
 * 覆盖：请求-响应匹配（成功 / 失败 / 超时 / 关闭 reject / 迟到响应忽略 /
 * id 递增）、心跳（ping 自动回 pong）、事件分发（收窄 + 退订）、
 * result 不派发给事件订阅者。
 */

import { IPC_VERSION } from "@napuketto/loader";
import { describe, expect, it, vi } from "vitest";
import {
    decodeIpcMessage,
    encodeIpcMessage,
    type IpcMessage,
    NapukettoIpcClient,
} from "../../../../src/runtime/ipc/index.js";
import type { IpcLineTransport } from "../../../../src/runtime/ipc/transport.js";
import { captureAction, MemoryLinePair } from "../../../helpers/ipc.js";

/** 可编排写入行为的传输：模拟同步响应、同步抛错或重入关闭。 */
class ScriptedTransport implements IpcLineTransport {
    readonly written: string[] = [];
    closed = false;
    private lineHandler: ((line: string) => void) | undefined;

    constructor(private readonly onWrite?: (line: string) => void) {}

    write(line: string): void {
        this.written.push(line);
        this.onWrite?.(line);
    }

    onLine(callback: (line: string) => void): () => void {
        this.lineHandler = callback;
        return () => {
            if (this.lineHandler === callback) {
                this.lineHandler = undefined;
            }
        };
    }

    onClose(_callback: () => void): () => void {
        return () => {};
    }

    close(): void {
        this.closed = true;
    }

    receive(line: string): void {
        this.lineHandler?.(line);
    }
}

class ThrowingTransport extends ScriptedTransport {
    override write(): void {
        throw new Error("stdin 已损坏");
    }
}

describe("NapukettoIpcClient 请求-响应", () => {
    it("action 请求 → result 成功响应", async () => {
        const pair = new MemoryLinePair();
        const client = new NapukettoIpcClient(pair);
        const sent: IpcMessage[] = [];
        pair.peer.onLine((line) => {
            const msg = decodeIpcMessage(line);
            if (msg !== null) {
                sent.push(msg);
            }
        });

        const promise = client.request("send_message", { peerUin: "123" });
        expect(sent).toHaveLength(1);
        const request = sent[0] as Extract<IpcMessage, { type: "action" }>;
        expect(request.id).toBeTypeOf("number");
        expect(request.payload.action).toBe("send_message");

        pair.peer.write(
            encodeIpcMessage({
                v: IPC_VERSION,
                type: "result",
                id: request.id,
                payload: { ok: true, value: { msgId: 42 } },
            }),
        );
        await expect(promise).resolves.toEqual({ msgId: 42 });
        client.close();
    });

    it("result 失败 → reject IpcError（携带远端错误码）", async () => {
        const pair = new MemoryLinePair();
        const client = new NapukettoIpcClient(pair);
        const captured = captureAction(pair); // 先注册捕获，再发请求
        const promise = client.request("get_msg");
        const request = await captured;
        expect(request).not.toBeNull();
        if (request === null) {
            return; // 不应发生；防御分支（避免 non-null assertion）
        }

        pair.peer.write(
            encodeIpcMessage({
                v: IPC_VERSION,
                type: "result",
                id: request.id,
                payload: { ok: false, error: { code: "NOT_FOUND", message: "消息不存在" } },
            }),
        );
        // 错误码 + 名称断言（message 已含 action 名前缀，见 client.ts handleResult；
        // vitest 对 Error 实例的 toMatchObject 不比较 message 字段）
        await expect(promise).rejects.toMatchObject({
            name: "IpcError",
            code: "NOT_FOUND",
        });
        client.close();
    });

    it("超时 → reject IpcError(TIMEOUT) 并清理 pending", async () => {
        vi.useFakeTimers();
        try {
            const pair = new MemoryLinePair();
            const client = new NapukettoIpcClient(pair, { requestTimeoutMs: 1000 });
            const promise = client.request("get_msg");
            // 先挂 rejection handler，避免 unhandled rejection
            const assertion = expect(promise).rejects.toMatchObject({ code: "TIMEOUT" });
            await vi.advanceTimersByTimeAsync(1001);
            await assertion;

            // 超时后到达的迟到 result 不应触发 unhandled rejection
            pair.peer.write(
                encodeIpcMessage({
                    v: IPC_VERSION,
                    type: "result",
                    id: 1,
                    payload: { ok: true, value: { late: true } },
                }),
            );
            client.close();
        } finally {
            vi.useRealTimers();
        }
    });

    it("通道关闭 → 所有 pending reject(CLOSED)", async () => {
        const pair = new MemoryLinePair();
        const client = new NapukettoIpcClient(pair);
        const captured = captureAction(pair); // 先注册捕获，再发请求
        const promise = client.request("get_msg");
        await captured;
        client.close();
        await expect(promise).rejects.toMatchObject({ code: "CLOSED" });
    });

    it("close 后 request 立即 reject(CLOSED)", async () => {
        const pair = new MemoryLinePair();
        const client = new NapukettoIpcClient(pair);
        client.close();
        await expect(client.request("get_msg")).rejects.toMatchObject({ code: "CLOSED" });
    });

    it("request id 单调递增", async () => {
        const pair = new MemoryLinePair();
        const client = new NapukettoIpcClient(pair);
        const ids: number[] = [];
        pair.peer.onLine((line) => {
            const msg = decodeIpcMessage(line);
            if (msg?.type === "action") {
                ids.push(msg.id);
            }
        });
        client.request("a").catch(() => {});
        client.request("b").catch(() => {});
        expect(ids).toEqual([1, 2]);
        client.close();
    });
});

describe("NapukettoIpcClient 请求原子性", () => {
    it("编码失败 → reject IPC_ENCODE_FAILED，pending 与定时器清理，通道继续可用", async () => {
        const pair = new MemoryLinePair();
        const client = new NapukettoIpcClient(pair);
        const sent: IpcMessage[] = [];
        pair.peer.onLine((line) => {
            const msg = decodeIpcMessage(line);
            if (msg !== null) {
                sent.push(msg);
            }
        });
        const circular: Record<string, unknown> = {};
        circular["self"] = circular;

        await expect(client.request("bad", circular)).rejects.toMatchObject({
            code: "IPC_ENCODE_FAILED",
        });
        expect(client.pendingCount).toBe(0);
        expect(client.alive).toBe(true);

        const next = client.request("ok");
        const request = sent[0] as Extract<IpcMessage, { type: "action" }>;
        expect(request.id).toBe(2); // 失败的请求已消费 id，但不复用、不残留
        pair.peer.write(
            encodeIpcMessage({
                v: IPC_VERSION,
                type: "result",
                id: request.id,
                payload: { ok: true, value: "done" },
            }),
        );
        await expect(next).resolves.toBe("done");
        client.close();
    });

    it("出站行超过上限 → reject IPC_LINE_TOO_LARGE，后续正常帧不受影响", async () => {
        const pair = new MemoryLinePair();
        const client = new NapukettoIpcClient(pair, { maxLineBytes: 128 });
        const sent: IpcMessage[] = [];
        pair.peer.onLine((line) => {
            const msg = decodeIpcMessage(line);
            if (msg !== null) {
                sent.push(msg);
            }
        });

        await expect(
            client.request("send_message", { text: "x".repeat(256) }),
        ).rejects.toMatchObject({ code: "IPC_LINE_TOO_LARGE" });
        expect(client.pendingCount).toBe(0);
        expect(client.alive).toBe(true);
        expect(sent).toHaveLength(0);

        const next = client.request("ok");
        const request = sent[0] as Extract<IpcMessage, { type: "action" }>;
        expect(Buffer.byteLength(encodeIpcMessage(request), "utf8") - 1).toBeLessThanOrEqual(128);
        pair.peer.write(
            encodeIpcMessage({
                v: IPC_VERSION,
                type: "result",
                id: request.id,
                payload: { ok: true, value: "small" },
            }),
        );
        await expect(next).resolves.toBe("small");
        client.close();
    });

    it("正常较大帧在上限内可发送并收到响应", async () => {
        const pair = new MemoryLinePair();
        const client = new NapukettoIpcClient(pair, { maxLineBytes: 4096 });
        const captured = captureAction(pair);
        const request = client.request("send_message", { text: "x".repeat(2000) });
        const action = await captured;
        expect(action).not.toBeNull();
        if (action === null) {
            return;
        }
        pair.peer.write(
            encodeIpcMessage({
                v: IPC_VERSION,
                type: "result",
                id: action.id,
                payload: { ok: true, value: "large-ok" },
            }),
        );
        await expect(request).resolves.toBe("large-ok");
        client.close();
    });

    it("在途容量上限 → 超限请求立即 IPC_QUEUE_FULL，释放后可继续", async () => {
        const pair = new MemoryLinePair();
        const client = new NapukettoIpcClient(pair, { maxPending: 1 });
        const sent: IpcMessage[] = [];
        pair.peer.onLine((line) => {
            const msg = decodeIpcMessage(line);
            if (msg !== null) {
                sent.push(msg);
            }
        });

        const first = client.request("first");
        await expect(client.request("second")).rejects.toMatchObject({
            code: "IPC_QUEUE_FULL",
        });
        expect(client.pendingCount).toBe(1);
        const request = sent[0] as Extract<IpcMessage, { type: "action" }>;
        pair.peer.write(
            encodeIpcMessage({
                v: IPC_VERSION,
                type: "result",
                id: request.id,
                payload: { ok: true, value: "first" },
            }),
        );
        await expect(first).resolves.toBe("first");
        expect(client.pendingCount).toBe(0);

        const third = client.request("third");
        expect(client.pendingCount).toBe(1);
        client.close();
        await expect(third).rejects.toMatchObject({ code: "CLOSED" });
    });

    it("同步发送失败 → reject IPC_SEND_FAILED 并关闭通道", async () => {
        const client = new NapukettoIpcClient(new ThrowingTransport());
        await expect(client.request("send")).rejects.toMatchObject({
            code: "IPC_SEND_FAILED",
        });
        expect(client.pendingCount).toBe(0);
        expect(client.alive).toBe(false);
        await expect(client.request("later")).rejects.toMatchObject({ code: "CLOSED" });
    });

    it("发送期间重入关闭 → reject CLOSED，pending 清空", async () => {
        const holder: { client: NapukettoIpcClient | undefined } = { client: undefined };
        const transport = new ScriptedTransport(() => holder.client?.close());
        const client = new NapukettoIpcClient(transport);
        holder.client = client;

        await expect(client.request("close-in-write")).rejects.toMatchObject({ code: "CLOSED" });
        expect(client.pendingCount).toBe(0);
        expect(client.alive).toBe(false);
        expect(transport.closed).toBe(true);
    });

    it("响应在 write 内同步到达 → 仍按 id 正确 resolve", async () => {
        let transport: ScriptedTransport;
        transport = new ScriptedTransport((line) => {
            const msg = decodeIpcMessage(line);
            if (msg?.type === "action") {
                transport.receive(
                    encodeIpcMessage({
                        v: IPC_VERSION,
                        type: "result",
                        id: msg.id,
                        payload: { ok: true, value: "sync" },
                    }),
                );
            }
        });
        const client = new NapukettoIpcClient(transport);
        await expect(client.request("echo")).resolves.toBe("sync");
        expect(client.pendingCount).toBe(0);
        client.close();
    });

    it("控制指令同步发送失败返回 false 并关闭通道", () => {
        const client = new NapukettoIpcClient(new ThrowingTransport());
        expect(client.sendControl({ command: "status" })).toBe(false);
        expect(client.alive).toBe(false);
    });

    it("关闭后发送控制指令返回 false（不抛错）", () => {
        const client = new NapukettoIpcClient(new MemoryLinePair());
        client.close();
        expect(client.sendControl({ command: "status" })).toBe(false);
    });
});

describe("NapukettoIpcClient 心跳", () => {
    it("收到 ping 自动回 pong，并记录 pingAt/seenAt", () => {
        vi.useFakeTimers();
        try {
            const pair = new MemoryLinePair();
            const client = new NapukettoIpcClient(pair);
            const sent: IpcMessage[] = [];
            pair.peer.onLine((line) => {
                const msg = decodeIpcMessage(line);
                if (msg !== null) {
                    sent.push(msg);
                }
            });

            vi.setSystemTime(1000);
            pair.peer.write(encodeIpcMessage({ v: IPC_VERSION, type: "ping" }));
            expect(sent).toEqual([{ v: IPC_VERSION, type: "pong" }]);
            expect(client.pingAt).toBe(1000);
            expect(client.seenAt).toBe(1000);
            client.close();
        } finally {
            vi.useRealTimers();
        }
    });

    it("收到 pong 记录 pongAt", () => {
        vi.useFakeTimers();
        try {
            const pair = new MemoryLinePair();
            const client = new NapukettoIpcClient(pair);
            vi.setSystemTime(2000);
            pair.peer.write(encodeIpcMessage({ v: IPC_VERSION, type: "pong" }));
            expect(client.pongAt).toBe(2000);
            client.close();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("NapukettoIpcClient 事件分发", () => {
    it("on(event) 收窄类型 + 退订后不再收到", () => {
        const pair = new MemoryLinePair();
        const client = new NapukettoIpcClient(pair);
        const services: string[] = [];
        const unsubscribe = client.on("event", (message) => {
            services.push(message.payload.service);
        });

        pair.peer.write(
            encodeIpcMessage({
                v: IPC_VERSION,
                type: "event",
                payload: { service: "Msg", name: "onRecvMsg", args: [] },
            }),
        );
        expect(services).toEqual(["Msg"]);

        unsubscribe();
        pair.peer.write(
            encodeIpcMessage({
                v: IPC_VERSION,
                type: "event",
                payload: { service: "Group", name: "onGroupListUpdate", args: [] },
            }),
        );
        expect(services).toEqual(["Msg"]);
        client.close();
    });

    it("result 不派发给事件订阅者", () => {
        const pair = new MemoryLinePair();
        const client = new NapukettoIpcClient(pair);
        const seen: string[] = [];
        client.on("result", () => {
            seen.push("result");
        });
        pair.peer.write(
            encodeIpcMessage({
                v: IPC_VERSION,
                type: "result",
                id: 999,
                payload: { ok: true },
            }),
        );
        expect(seen).toEqual([]);
        client.close();
    });

    it("无法解析的行 → onJunkLine 回调且不影响后续消息", () => {
        const pair = new MemoryLinePair();
        const onJunkLine = vi.fn();
        const client = new NapukettoIpcClient(pair, { onJunkLine });
        const phases: string[] = [];
        client.on("status", (message) => phases.push(message.payload.phase));

        const torn = "[00:13:40.523] INFO (kernel/4242): 撕裂的日志行\n";
        pair.peer.write(torn);
        pair.peer.write(
            encodeIpcMessage({ v: IPC_VERSION, type: "status", payload: { phase: "booting" } }),
        );
        expect(onJunkLine).toHaveBeenCalledExactlyOnceWith();
        expect(phases).toEqual(["booting"]);
        client.close();
    });

    it("onJunkLine 自身抛错也不阻断后续消息", () => {
        const pair = new MemoryLinePair();
        const client = new NapukettoIpcClient(pair, {
            onJunkLine: () => {
                throw new Error("诊断回调爆炸");
            },
        });
        const phases: string[] = [];
        client.on("status", (message) => phases.push(message.payload.phase));
        pair.peer.write("not json\n");
        pair.peer.write(
            encodeIpcMessage({ v: IPC_VERSION, type: "status", payload: { phase: "ready" } }),
        );
        expect(phases).toEqual(["ready"]);
        client.close();
    });

    it("单个消息订阅者抛错 → 隔离并诊断，其余订阅者与后续行继续", () => {
        const pair = new MemoryLinePair();
        const onHandlerError = vi.fn();
        const client = new NapukettoIpcClient(pair, { onHandlerError });
        const phases: string[] = [];
        client.on("status", () => {
            throw new Error("订阅者爆炸");
        });
        client.on("status", (message) => phases.push(message.payload.phase));

        pair.peer.write(
            encodeIpcMessage({ v: IPC_VERSION, type: "status", payload: { phase: "booting" } }),
        );
        pair.peer.write(
            encodeIpcMessage({ v: IPC_VERSION, type: "status", payload: { phase: "ready" } }),
        );
        expect(phases).toEqual(["booting", "ready"]);
        expect(onHandlerError).toHaveBeenCalledTimes(2);
        expect(onHandlerError).toHaveBeenCalledWith(
            expect.objectContaining({ message: "订阅者爆炸" }),
            "status",
        );
        client.close();
    });

    it("status / login / qr 均能派发", () => {
        const pair = new MemoryLinePair();
        const client = new NapukettoIpcClient(pair);
        const received: string[] = [];
        client.on("status", (message) => received.push(message.payload.phase));
        client.on("login", (message) => received.push(message.payload.state));
        client.on("qr", () => received.push("qr"));

        pair.peer.write(
            encodeIpcMessage({
                v: IPC_VERSION,
                type: "status",
                payload: { phase: "ready" },
            }),
        );
        pair.peer.write(
            encodeIpcMessage({
                v: IPC_VERSION,
                type: "login",
                payload: { state: "logged_in" },
            }),
        );
        pair.peer.write(
            encodeIpcMessage({
                v: IPC_VERSION,
                type: "qr",
                payload: { pngBase64: "aGk=", qrcodeUrl: "https://x" },
            }),
        );
        expect(received).toEqual(["ready", "logged_in", "qr"]);
        client.close();
    });
});
