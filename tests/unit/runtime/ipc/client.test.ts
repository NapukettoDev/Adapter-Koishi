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
import { captureAction, MemoryLinePair } from "../../../helpers/ipc.js";

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
        const junk: string[] = [];
        const client = new NapukettoIpcClient(pair, {
            onJunkLine: (line) => junk.push(line),
        });
        const phases: string[] = [];
        client.on("status", (message) => phases.push(message.payload.phase));

        const torn = "[00:13:40.523] INFO (kernel/4242): 撕裂的日志行\n";
        pair.peer.write(torn);
        pair.peer.write(
            encodeIpcMessage({ v: IPC_VERSION, type: "status", payload: { phase: "booting" } }),
        );
        expect(junk).toEqual([torn]);
        expect(phases).toEqual(["booting"]);
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
