/**
 * driver-events.test.ts：NapukettoDriver 事件转发单测（login/qr/event/log）。
 */
import { describe, expect, it, vi } from "vitest";
import { NapukettoEventBridge } from "../../events/bridge.js";
import { makeRawMessage, mockH } from "../../events/test-utils.js";
import {
    decodeIpcMessage,
    encodeIpcMessage,
    IPC_VERSION,
    type IpcEventPayload,
    type NapukettoIpcClient,
} from "../../ipc/index.js";
import type { MemoryLinePair } from "../../ipc/test-utils.js";
import { createHarness, flush } from "../test-utils.js";

function emitMessage(pair: MemoryLinePair | undefined, sequence: number): void {
    pair?.peer.write(
        encodeIpcMessage({
            v: IPC_VERSION,
            type: "event",
            payload: { service: "Msg", name: "onRecvMsg", args: [sequence] },
        }),
    );
}

describe("NapukettoDriver 事件转发", () => {
    it("login/qr/event/log 透传给 events 回调", async () => {
        const onLogin = vi.fn();
        const onQr = vi.fn();
        const onEvent = vi.fn();
        const onLog = vi.fn();
        const { driver, emit, peers, spawns } = createHarness({ onLogin, onQr, onEvent, onLog });
        driver.start();
        await flush();
        const pair = peers[0]?.peer;
        expect(pair).toBeDefined();

        pair?.write(
            encodeIpcMessage({
                v: IPC_VERSION,
                type: "login",
                payload: { state: "logged_in", selfInfo: { uin: "1", uid: "u1", nick: "n" } },
            }),
        );
        pair?.write(
            encodeIpcMessage({
                v: IPC_VERSION,
                type: "qr",
                payload: { pngBase64: "aGk=", qrcodeUrl: "https://x" },
            }),
        );
        expect(onLogin).toHaveBeenCalled();
        expect(onQr).toHaveBeenCalled();
        emit("ready");
        pair?.write(
            encodeIpcMessage({
                v: IPC_VERSION,
                type: "event",
                payload: { service: "Msg", name: "onRecvMsg", args: [] },
            }),
        );
        pair?.write(
            encodeIpcMessage({
                v: IPC_VERSION,
                type: "log",
                payload: { level: "info", message: "hi" },
            }),
        );
        expect(onEvent).toHaveBeenCalledWith({ service: "Msg", name: "onRecvMsg", args: [] });
        expect(onLog).toHaveBeenCalledWith({ level: "info", message: "hi" });
        driver.stop();
        spawns[0]?.emitExit(0, null);
    });

    it("onReady 完成客户端绑定后，按到达顺序回放一次", async () => {
        let clientRef: NapukettoIpcClient | null = null;
        const onReady = vi.fn(() => {
            clientRef = driver.currentClient;
            emitMessage(peers[0], 3);
        });
        const onEvent = vi.fn((_payload: IpcEventPayload) => {
            expect(clientRef).not.toBeNull();
            expect(clientRef).toBe(driver.currentClient);
        });
        const { driver, emit, peers, spawns } = createHarness({ onReady, onEvent });
        driver.start();
        await flush();
        emit("sessioning");
        emitMessage(peers[0], 1);
        emitMessage(peers[0], 2);
        expect(onEvent).not.toHaveBeenCalled();

        emit("ready");
        emit("ready");
        emitMessage(peers[0], 4);
        expect(onReady).toHaveBeenCalledOnce();
        expect(onEvent.mock.calls.map(([payload]) => payload.args[0])).toEqual([1, 2, 3, 4]);
        driver.stop();
        spawns[0]?.emitExit(0, null);
    });

    it("过滤首启、软重登和重启时的旧消息，保留握手期消息", async () => {
        vi.useFakeTimers();
        const initial = 1_800_000_000_000;
        const dispatch = vi.fn();
        const bridge = new NapukettoEventBridge({ dispatch, selfId: () => "1", h: mockH() });
        const onReady = vi.fn();
        const { driver, emit, peers, spawns } = createHarness({
            onEventSubscription: () => bridge.resetMessageBaseline(),
            onEvent: (payload) => bridge.handle(payload),
            onReady,
        });
        const recv = (at: MemoryLinePair | undefined, ...entries: [string, string][]) => {
            at?.peer.write(
                encodeIpcMessage({
                    v: IPC_VERSION,
                    type: "event",
                    payload: {
                        service: "Msg",
                        name: "onRecvMsg",
                        args: [
                            entries.map(([msgId, msgTime]) => makeRawMessage({ msgId, msgTime })),
                        ],
                    },
                }),
            );
        };
        const dispatchedIds = () => dispatch.mock.calls.map(([fields]) => fields.messageId);
        try {
            vi.setSystemTime(initial);
            driver.start();
            await flush();
            vi.setSystemTime(initial + 10_000);
            emit("sessioning");
            recv(
                peers[0],
                ["old-seconds", String(initial / 1000 - 6)],
                ["old-millis", String(initial - 5_001)],
                ["within-grace", String(initial / 1000 - 5)],
                ["handshake", String(initial + 123)],
                ["invalid-time", "NaN"],
            );
            expect(dispatch).not.toHaveBeenCalled();

            vi.setSystemTime(initial + 20_000);
            emit("ready");
            await flush();
            expect(
                dispatch.mock.calls.map(([fields]) => [fields.messageId, fields.timestamp]),
            ).toEqual([
                ["within-grace", initial - 5_000],
                ["handshake", initial + 123],
                ["invalid-time", initial + 20_000],
            ]);

            vi.setSystemTime(initial + 30_000);
            emit("sessioning");
            vi.setSystemTime(initial + 40_000);
            emit("sessioning");
            recv(
                peers[0],
                ["soft-old", String(initial + 20_000)],
                ["soft-new", String(initial + 29_000)],
            );
            emit("ready");
            await flush();
            expect(onReady).toHaveBeenCalledOnce();
            expect(dispatchedIds()).toEqual([
                "within-grace",
                "handshake",
                "invalid-time",
                "soft-new",
            ]);

            spawns[0]?.emitExit(1, null);
            await vi.advanceTimersByTimeAsync(100);
            recv(
                peers[1],
                ["restart-old", String(initial + 30_000)],
                ["restart-new", String(Date.now())],
            );
            emit("ready");
            await flush();
            expect(onReady).toHaveBeenCalledTimes(2);
            expect(dispatchedIds()).toEqual([
                "within-grace",
                "handshake",
                "invalid-time",
                "soft-new",
                "restart-new",
            ]);
        } finally {
            driver.stop();
            spawns.at(-1)?.emitExit(0, null);
            vi.useRealTimers();
        }
    });

    it("启动期事件最多保留最近 256 条，并保持顺序", async () => {
        const onEvent = vi.fn();
        const { driver, emit, peers, spawns } = createHarness({ onEvent });
        driver.start();
        await flush();
        for (let sequence = 0; sequence < 258; sequence++) {
            emitMessage(peers[0], sequence);
        }
        emit("ready");
        expect(onEvent.mock.calls.map(([payload]) => payload.args[0])).toEqual(
            Array.from({ length: 256 }, (_, index) => index + 2),
        );
        driver.stop();
        spawns[0]?.emitExit(0, null);
    });

    it("引导中退出后忽略旧进程的尾部消息，重启只回放新进程的事件", async () => {
        vi.useFakeTimers();
        try {
            const onReady = vi.fn();
            const onEvent = vi.fn();
            const { driver, emit, peers, spawns } = createHarness({ onReady, onEvent });
            driver.start();
            await flush();
            emitMessage(peers[0], 1);
            spawns[0]?.emitExit(1, null);
            expect(driver.currentClient).toBeNull();
            emit("ready");
            emitMessage(peers[0], 2);
            expect(driver.currentState).toBe("restarting");
            expect(onReady).not.toHaveBeenCalled();
            expect(onEvent).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(100);
            // 新进程第一次查询不受上一轮 5s 节流影响。
            peers[1]?.peer.onLine((line) => {
                const message = decodeIpcMessage(line);
                if (message?.type === "control" && message.payload.command === "status") {
                    emit("ready");
                }
            });
            emitMessage(peers[1], 3);
            expect(onReady).toHaveBeenCalledOnce();
            expect(onEvent).toHaveBeenCalledExactlyOnceWith({
                service: "Msg",
                name: "onRecvMsg",
                args: [3],
            });
            driver.stop();
            spawns[1]?.emitExit(0, null);
        } finally {
            vi.useRealTimers();
        }
    });

    it.each(["before-ready", "on-ready"])("停止时丢弃暂存与后续事件（%s）", async (when) => {
        const onEvent = vi.fn();
        const onReady = vi.fn(() => driver.stop());
        const { driver, emit, peers, spawns } = createHarness({ onReady, onEvent });
        driver.start();
        await flush();
        emitMessage(peers[0], 1);
        if (when === "before-ready") {
            driver.stop();
        }
        // on-ready 场景模拟 Bot 在账号校验失败后同步停止驱动。
        emit("ready");
        emitMessage(peers[0], 2);
        expect(onReady).toHaveBeenCalledTimes(when === "on-ready" ? 1 : 0);
        expect(onEvent).not.toHaveBeenCalled();
        spawns[0]?.emitExit(0, null);
        expect(driver.currentState).toBe("stopped");
    });
});
