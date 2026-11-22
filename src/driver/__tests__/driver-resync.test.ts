/**
 * driver-resync.test.ts：状态重同步单测（2026-09-06「能收不能发」事故自愈链路）。
 *
 * 场景：ready 等关键 status 消息被子进程 stdout 并发写撕裂丢失——事件照常
 * 到达时需等客户端就绪才能派发。自愈链路：
 * 事件触发 / booting 定期（20s）→ control status 查询 → 子进程重播最近
 * status → 幂等守卫防重复 onReady。
 */
import { describe, expect, it, vi } from "vitest";
import { createHarness, type DriverHarness, flush } from "../../__test-utils__/driver.js";
import { encodeIpcMessage, IPC_VERSION, type IpcMessage } from "../../ipc/index.js";

/** 模拟子进程发事件消息（发给最近一次 spawn 的 client；不依赖 ready）。 */
function emitEvent(harness: DriverHarness): void {
    const pair = harness.peers.at(-1);
    if (pair === undefined) {
        throw new Error("尚无 spawn");
    }
    const msg: IpcMessage = {
        v: IPC_VERSION,
        type: "event",
        payload: { service: "Msg", name: "onRecvMsg", args: [] },
    };
    pair.peer.write(encodeIpcMessage(msg));
}

/** 捕获 client → 子进程 的 control status 查询（监听传输对端；stop 也会发
 * control，此处只统计 status 查询）。 */
function captureControls(harness: DriverHarness, onQuery?: () => void): IpcMessage[] {
    const controls: IpcMessage[] = [];
    const pair = harness.peers.at(-1);
    if (pair === undefined) {
        throw new Error("尚无 spawn");
    }
    pair.peer.onLine((line) => {
        const msg = JSON.parse(line) as IpcMessage;
        if (msg.type === "control" && msg.payload.command === "status") {
            controls.push(msg);
            onQuery?.();
        }
    });
    return controls;
}

describe("NapukettoDriver 状态重同步", () => {
    it("sessioning 中收到 event → 查询到 sessioning → 仍等待 ready", async () => {
        const onEvent = vi.fn();
        const harness = createHarness({ onEvent });
        harness.driver.start();
        await flush();
        harness.emit("sessioning");
        const controls = captureControls(harness, () => harness.emit("sessioning"));
        emitEvent(harness);
        expect(controls).toEqual([
            { v: IPC_VERSION, type: "control", payload: { command: "status" } },
        ]);
        expect(harness.driver.currentState).toBe("booting");
        expect(onEvent).not.toHaveBeenCalled();
        harness.emit("ready");
        expect(onEvent).toHaveBeenCalledOnce();
        void harness.driver.stop();
    });

    it("事件风暴节流：连续 event 只查一次（5s 下限）", async () => {
        const harness = createHarness();
        harness.driver.start();
        await flush();
        const controls = captureControls(harness);
        emitEvent(harness);
        emitEvent(harness);
        emitEvent(harness);
        expect(controls).toHaveLength(1);
        void harness.driver.stop();
    });

    it("ready 后收到 event 不再查询", async () => {
        const harness = createHarness();
        harness.driver.start();
        await flush();
        harness.emit("ready");
        await flush();
        const controls = captureControls(harness);
        emitEvent(harness);
        expect(controls).toHaveLength(0);
        void harness.driver.stop();
    });

    it("booting 定期查询（20s）且 ready 后停表", async () => {
        vi.useFakeTimers();
        try {
            const harness = createHarness();
            harness.driver.start();
            await flush();
            const controls = captureControls(harness);
            await vi.advanceTimersByTimeAsync(20_000);
            expect(controls).toHaveLength(1);
            await vi.advanceTimersByTimeAsync(20_000);
            expect(controls).toHaveLength(2);
            harness.emit("ready");
            await flush();
            await vi.advanceTimersByTimeAsync(60_000);
            expect(controls).toHaveLength(2); // 离开 booting 不再定期查询
            void harness.driver.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it("ready 丢失自愈：event 触发查询 → 子进程重播 ready → onReady 一次", async () => {
        const onReady = vi.fn();
        const onEvent = vi.fn();
        const harness = createHarness({ onReady, onEvent });
        harness.driver.start();
        await flush();
        // 模拟子进程：ready 已发出但被撕裂丢失，仅 event 到达；收到 status 查询
        // 后重播 ready（对齐子进程 ipc-server 的 control status 行为）
        captureControls(harness, () => harness.emit("ready"));
        emitEvent(harness);
        await flush();
        expect(harness.driver.currentState).toBe("ready");
        expect(onReady).toHaveBeenCalledOnce();
        expect(onEvent).toHaveBeenCalledOnce();
        expect(onReady).toHaveBeenCalledBefore(onEvent);
        void harness.driver.stop();
    });

    it("软重登重播 ready：不重复 onReady，仍转发 logged_in 供上层校验账号", async () => {
        const onReady = vi.fn();
        const onLogin = vi.fn();
        const { driver, emit, peers, spawns } = createHarness({ onReady, onLogin });
        driver.start();
        await flush();
        emit("ready");
        const client = driver.currentClient;
        emit("sessioning");
        emit("ready");
        const login = { state: "logged_in", selfInfo: { uin: "2", uid: "u2", nick: "n" } } as const;
        peers[0]?.peer.write(encodeIpcMessage({ v: IPC_VERSION, type: "login", payload: login }));
        expect(driver.currentState).toBe("ready");
        expect(driver.currentClient).toBe(client);
        expect(onReady).toHaveBeenCalledOnce();
        expect(onLogin).toHaveBeenCalledExactlyOnceWith(login);
        void driver.stop();
        spawns[0]?.emitExit(0, null);
    });

    it("onJunkLine 透传：子进程脏行触发回调", async () => {
        const junk: string[] = [];
        const harness = createHarness({}, { onJunkLine: (line) => junk.push(line) });
        harness.driver.start();
        await flush();
        const line = "[00:13:40.523] INFO (kernel/4242): 撕裂的日志行\n";
        harness.peers[0]?.peer.write(line);
        expect(junk).toEqual([line]);
        void harness.driver.stop();
    });

    it("停止后 booting 查询定时器不再触发", async () => {
        vi.useFakeTimers();
        try {
            const harness = createHarness();
            harness.driver.start();
            await flush();
            const controls = captureControls(harness);
            void harness.driver.stop();
            await vi.advanceTimersByTimeAsync(60_000);
            expect(controls).toHaveLength(0);
        } finally {
            vi.useRealTimers();
        }
    });
});
