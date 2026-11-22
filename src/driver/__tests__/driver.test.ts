/**
 * driver.test.ts：NapukettoDriver 启动 + 停止单测。
 *
 * 用 FakeChild + MemoryLinePair 注入（test-utils.ts），不依赖真实子进程。
 */
import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { createHarness, flush } from "../../__test-utils__/driver.js";
import { MemoryLinePair } from "../../__test-utils__/ipc.js";
import { encodeIpcMessage, IPC_VERSION, type IpcMessage } from "../../ipc/index.js";
import { NapukettoDriver } from "../driver.js";

describe("NapukettoDriver 启动", () => {
    it("正常启动 → status.ready → state=ready + onReady", async () => {
        const onReady = vi.fn();
        const { driver, emit } = createHarness({ onReady });
        driver.start();
        await flush();
        expect(driver.currentState).toBe("booting");
        emit("ready");
        await flush();
        expect(driver.currentState).toBe("ready");
        expect(onReady).toHaveBeenCalledTimes(1);
        void driver.stop();
    });

    it("start 幂等（非 idle 忽略）", async () => {
        const { driver, spawns } = createHarness();
        driver.start();
        await flush();
        const count = spawns.length;
        driver.start();
        expect(spawns.length).toBe(count);
        void driver.stop();
    });

    it("spawn 抛错 → failed + onError", async () => {
        const onError = vi.fn();
        const driver = new NapukettoDriver({
            launch: async () => {
                throw new Error("self-host.cjs 缺失");
            },
            createTransport: () => new MemoryLinePair(),
            events: { onError },
        });
        driver.start();
        await flush();
        expect(driver.currentState).toBe("failed");
        expect(onError).toHaveBeenCalled();
    });

    it("Node 启动失败且无 PID 时可完成清理", async () => {
        const failure = Promise.withResolvers<unknown>();
        const onExit = vi.fn();
        const driver = new NapukettoDriver({
            launch: async () => ({ child: spawn(`${process.execPath}.missing`) }),
            events: { onExit, onError: failure.resolve },
        });
        driver.start();
        await expect(failure.promise).resolves.toMatchObject({ code: "ENOENT" });
        expect(driver.currentState).toBe("failed");
        expect(onExit).toHaveBeenCalledExactlyOnceWith({
            code: null,
            signal: null,
            reason: "spawn-error",
        });
    });

    it("真实子进程以 78 退出时停止重试", async () => {
        const failure = Promise.withResolvers<unknown>();
        const driver = new NapukettoDriver({
            launch: async () => ({ child: spawn(process.execPath, ["-e", "process.exit(78)"]) }),
            events: { onError: failure.resolve },
        });
        driver.start();
        await expect(failure.promise).resolves.toMatchObject({ code: "INVALID_PARAM" });
        expect(driver.currentState).toBe("failed");
        expect(driver.restartAttempts).toBe(0);
    });

    it.skipIf(process.platform !== "linux")(
        "Linux 宿主忽略 SIGTERM 时等待 SIGKILL 的真实退出事件",
        async () => {
            vi.useFakeTimers();
            const status = encodeIpcMessage({
                v: IPC_VERSION,
                type: "status",
                payload: { phase: "ready" },
            });
            const script = [
                'process.on("SIGTERM", () => {})',
                `process.stdout.write(${JSON.stringify(status)})`,
                "setInterval(() => {}, 1000)",
            ].join("\n");
            const child = spawn(process.execPath, ["-e", script]);
            const ready = Promise.withResolvers<void>();
            const exited = Promise.withResolvers<unknown>();
            const driver = new NapukettoDriver({
                launch: async () => ({ child }),
                heartbeatTimeoutMs: 1_000,
                restart: { maxRetries: 0 },
                events: { onReady: ready.resolve, onExit: exited.resolve },
            });
            try {
                driver.start();
                await ready.promise;
                await vi.advanceTimersByTimeAsync(2_000);
                expect(driver.currentState).toBe("terminating");
                expect(child.killed).toBe(true);
                expect(child.signalCode).toBeNull();
                await vi.advanceTimersByTimeAsync(5_000);
                await expect(exited.promise).resolves.toEqual({
                    code: null,
                    signal: "SIGKILL",
                    reason: "stale",
                });
            } finally {
                if (child.exitCode === null && child.signalCode === null) {
                    child.kill("SIGKILL");
                }
                vi.useRealTimers();
            }
        },
    );
});

describe("NapukettoDriver 停止", () => {
    it("launch 返回前停止 → 回收随后返回的子进程", async () => {
        const onReady = vi.fn();
        const { driver, peers, spawns } = createHarness({ onReady });
        driver.start();
        const stopping = driver.stop();
        await flush();

        expect(spawns[0]?.signals).toEqual(["SIGTERM"]);
        expect(peers).toHaveLength(0);
        expect(driver.currentClient).toBeNull();
        expect(driver.currentState).toBe("stopping");
        spawns[0]?.emitExit(null, "SIGTERM");
        await stopping;
        expect(driver.currentState).toBe("stopped");
        expect(onReady).not.toHaveBeenCalled();
    });

    it("stop → 发 control stop → 子进程退出 → stopped", async () => {
        const onExit = vi.fn();
        const { driver, spawns, peers } = createHarness({ onExit });
        driver.start();
        await flush();
        // 先注册监听（stop 同步发送，后注册会漏掉）；control 是 client 发出的 →
        // 监听对端（pair.peer）
        const received: IpcMessage[] = [];
        peers[0]?.peer.onLine((line) => {
            const msg = JSON.parse(line) as IpcMessage;
            received.push(msg);
        });
        const stopping = driver.stop();
        expect(driver.currentState).toBe("stopping");
        expect(received.some((m) => m.type === "control")).toBe(true);

        // 子进程收到 stop 后退出 → finishStop
        spawns[0]?.emitExit(0, null);
        await stopping;
        expect(driver.currentState).toBe("stopped");
        expect(onExit).toHaveBeenCalledExactlyOnceWith({ code: 0, signal: null, reason: "stop" });
    });

    it("stop 逐级终止，确认退出后才完成停止", async () => {
        vi.useFakeTimers();
        try {
            const { driver, spawns } = createHarness();
            driver.start();
            await flush();
            const stopping = driver.stop();
            expect(driver.stop()).toBe(stopping);
            expect(spawns[0]?.signals).toEqual([]);
            await vi.advanceTimersByTimeAsync(5_000);
            expect(spawns[0]?.signals).toEqual(["SIGTERM"]);
            await vi.advanceTimersByTimeAsync(5_000);
            expect(spawns[0]?.signals).toEqual(["SIGTERM", "SIGKILL"]);
            expect(driver.currentState).toBe("stopping");
            spawns[0]?.emitExit(null, "SIGKILL");
            await stopping;
            expect(driver.currentState).toBe("stopped");
        } finally {
            vi.useRealTimers();
        }
    });

    it("stop 后不重启（即便随后 exit）", async () => {
        const { driver, spawns } = createHarness();
        driver.start();
        await flush();
        void driver.stop();
        spawns[0]?.emitExit(1, null);
        await flush();
        expect(driver.currentState).toBe("stopped");
    });

    it("stop 的强制终止有界，超时时保留退出监听", async () => {
        vi.useFakeTimers();
        try {
            const onExit = vi.fn();
            const onError = vi.fn();
            const { driver, spawns } = createHarness({ onExit, onError });
            driver.start();
            await flush();
            const stopping = driver.stop();
            await vi.advanceTimersByTimeAsync(15_000);
            await stopping;
            expect(driver.currentState).toBe("failed");
            expect(spawns[0]?.listenerCount("exit")).toBe(1);
            expect(onError).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({ code: "EXIT_TIMEOUT" }),
            );
            expect(onExit).not.toHaveBeenCalled();
            spawns[0]?.emitExit(null, "SIGKILL");
            expect(driver.currentState).toBe("stopped");
            expect(onExit).not.toHaveBeenCalled();
            expect(spawns).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("确认停止后可再次启动，重启计数复位并重新占用账号目录", async () => {
        const options = { accountDir: "restart-after-stop" };
        const { driver, spawns, emit } = createHarness({}, options);
        driver.start();
        await flush();
        const stopping = driver.stop();
        spawns[0]?.emitExit(0, null);
        await stopping;
        expect(driver.currentState).toBe("stopped");

        driver.start();
        await flush();
        expect(spawns).toHaveLength(2);
        expect(driver.currentState).toBe("booting");
        emit("ready");
        await flush();
        expect(driver.currentState).toBe("ready");
        expect(driver.restartAttempts).toBe(0);

        const stopAgain = driver.stop();
        spawns[1]?.emitExit(0, null);
        await stopAgain;
    });

    it("停止尚未确认退出时再次 start 被忽略", async () => {
        const { driver, spawns } = createHarness();
        driver.start();
        await flush();
        const stopping = driver.stop();
        driver.start();
        await flush();
        expect(spawns).toHaveLength(1);
        expect(driver.currentState).toBe("stopping");
        spawns[0]?.emitExit(0, null);
        await stopping;
        expect(driver.currentState).toBe("stopped");
    });

    it("插件重载时同一数据目录等待旧宿主退出", async () => {
        const options = { accountDir: "reload-account" };
        const previous = createHarness({}, options);
        const next = createHarness({}, options);
        previous.driver.start();
        await flush();
        const stopping = previous.driver.stop();
        next.driver.start();
        await flush();
        expect(next.spawns).toHaveLength(0);
        expect(previous.driver.currentState).toBe("stopping");
        previous.spawns[0]?.emitExit(0, null);
        await stopping;
        await flush();
        expect(next.spawns).toHaveLength(1);
        expect(next.driver.currentState).toBe("booting");
        const stopNext = next.driver.stop();
        next.spawns[0]?.emitExit(0, null);
        await stopNext;
    });
});
