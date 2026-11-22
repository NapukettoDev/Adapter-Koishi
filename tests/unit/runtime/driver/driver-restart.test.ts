/**
 * driver-restart.test.ts：NapukettoDriver 重启 + 心跳失联单测。
 */
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { NapukettoDriver } from "../../../../src/runtime/driver/driver.js";
import type { DriverLauncher } from "../../../../src/runtime/driver/types.js";
import { createHarness, FakeChild, flush } from "../../../helpers/driver.js";
import { ControlledWritable } from "../../../helpers/ipc.js";

describe("NapukettoDriver 重启", () => {
    it("手动重启不消耗崩溃重试配额，并等待旧宿主退出", async () => {
        vi.useFakeTimers();
        try {
            const onExit = vi.fn();
            const { driver, spawns } = createHarness(
                { onExit },
                { restart: { maxRetries: 0, backoffMs: 100 } },
            );
            driver.start();
            await flush();
            expect(driver.restartLogin()).toBe(true);
            expect(driver.restartLogin()).toBe(false);
            expect(driver.currentClient).toBeNull();
            await vi.advanceTimersByTimeAsync(5_000);
            expect(spawns[0]?.signals).toEqual(["SIGTERM"]);
            expect(spawns).toHaveLength(1);

            spawns[0]?.emitExit(null, "SIGTERM");
            await vi.advanceTimersByTimeAsync(100);
            expect(onExit).toHaveBeenCalledExactlyOnceWith({
                code: null,
                signal: "SIGTERM",
                reason: "restart",
            });
            expect(spawns).toHaveLength(2);
            expect(driver.restartAttempts).toBe(0);
            spawns[1]?.emitExit(1, null);
            expect(driver.currentState).toBe("failed");
        } finally {
            vi.useRealTimers();
        }
    });

    it("等待手动重启期间停用 Bot 会取消重启", async () => {
        vi.useFakeTimers();
        try {
            const { driver, spawns } = createHarness({});
            driver.start();
            await flush();
            expect(driver.restartLogin()).toBe(true);
            const stopping = driver.stop();
            spawns[0]?.emitExit(0, null);
            await stopping;
            await vi.advanceTimersByTimeAsync(100);
            expect(driver.currentState).toBe("stopped");
            expect(spawns).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("stdin 写入失败后关闭客户端，宿主真实退出后才释放账号并安排重启", async () => {
        vi.useFakeTimers();
        try {
            const stdin = new ControlledWritable();
            const child = Object.assign(new FakeChild(), {
                stdin,
                stdout: new PassThrough(),
                stderr: null,
            });
            const replacement = Object.assign(new FakeChild(), {
                stdin: new PassThrough(),
                stdout: new PassThrough(),
                stderr: null,
            });
            const launch = vi.fn<DriverLauncher>(async () => ({ child: replacement }));
            launch.mockImplementationOnce(async () => ({ child }));
            const accountDir = "ipc-stdin-failure";
            const onExit = vi.fn();
            const onIpcWriteError = vi.fn();
            const driver = new NapukettoDriver({
                launch,
                accountDir,
                restart: { backoffMs: 100 },
                events: { onExit, onIpcWriteError },
            });
            driver.start();
            await flush();
            const client = driver.currentClient;
            if (client === null) {
                throw new Error("IPC 通道尚未打开");
            }
            const pending = expect(client.request("pending")).rejects.toMatchObject({
                code: "CLOSED",
            });
            const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
            stdin.completeWrite(error);
            await vi.advanceTimersByTimeAsync(500);
            await pending;
            expect(driver.currentClient).toBeNull();
            expect(onIpcWriteError).toHaveBeenCalledExactlyOnceWith(error);
            expect(onExit).not.toHaveBeenCalled();
            expect(launch).toHaveBeenCalledTimes(1);
            expect(child.signals).toEqual([]);

            const blocked = createHarness({}, { accountDir });
            blocked.driver.start();
            await flush();
            expect(blocked.spawns).toHaveLength(0);

            child.emitExit(1, null);
            expect(onExit).toHaveBeenCalledExactlyOnceWith({
                code: 1,
                signal: null,
                reason: "crash",
            });
            expect(driver.currentState).toBe("restarting");
            await vi.advanceTimersByTimeAsync(100);
            expect(launch).toHaveBeenCalledTimes(2);
            expect(driver.currentClient).not.toBeNull();
            const stopping = driver.stop();
            replacement.emitExit(0, null);
            await stopping;
            replacement.stdin.destroy();
        } finally {
            vi.useRealTimers();
        }
    });

    it("崩溃 → 退避重启 → ready 重置计数", async () => {
        vi.useFakeTimers();
        try {
            const onReady = vi.fn();
            const { driver, spawns, emit } = createHarness({ onReady });
            driver.start();
            await flush();
            expect(spawns.length).toBe(1);

            // 第 1 轮崩溃（code=1）→ restarting，退避 100ms
            spawns[0]?.emitExit(1, null);
            expect(driver.currentState).toBe("restarting");
            await vi.advanceTimersByTimeAsync(150);
            expect(spawns.length).toBe(2);

            // 第 2 轮 ready → restartCount 重置 0
            emit("ready");
            await flush();
            expect(driver.currentState).toBe("ready");
            expect(driver.restartAttempts).toBe(0);
            void driver.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it("崩溃次数达上限 → failed + onError", async () => {
        vi.useFakeTimers();
        try {
            const onError = vi.fn();
            const { driver, spawns } = createHarness(
                { onError },
                {
                    restart: { maxRetries: 1, backoffMs: 100 },
                },
            );
            driver.start();
            await flush();

            // 第 1 次崩溃 → 重启
            spawns[0]?.emitExit(1, null);
            await vi.advanceTimersByTimeAsync(150);
            expect(spawns.length).toBe(2);

            // 第 2 次崩溃 → 已达上限 → failed
            spawns[1]?.emitExit(1, null);
            expect(driver.currentState).toBe("failed");
            expect(onError).toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it("主动停止取消已安排的退避重启", async () => {
        vi.useFakeTimers();
        try {
            const { driver, spawns } = createHarness();
            driver.start();
            await flush();
            spawns[0]?.emitExit(1, null);
            expect(driver.currentState).toBe("restarting");
            await driver.stop();
            await vi.advanceTimersByTimeAsync(500);
            expect(driver.currentState).toBe("stopped");
            expect(spawns).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("心跳失联后升级终止并等待真实退出，只重启一次", async () => {
        vi.useFakeTimers();
        try {
            const onExit = vi.fn();
            const onReady = vi.fn();
            const { driver, spawns, emit } = createHarness({ onExit, onReady });
            driver.start();
            await flush();
            expect(spawns.length).toBe(1);

            // spawn 后 45s 内无任何消息 → 失联（兜 dlopen/登录卡死）
            await vi.advanceTimersByTimeAsync(46_000);
            expect(spawns[0]?.signals).toEqual(["SIGTERM"]);
            expect(driver.currentState).toBe("terminating");
            expect(driver.currentClient).toBeNull();
            emit("ready");
            expect(onReady).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(5_100);
            expect(spawns[0]?.signals).toEqual(["SIGTERM", "SIGKILL"]);
            expect(spawns).toHaveLength(1);
            expect(onExit).not.toHaveBeenCalled();
            spawns[0]?.emitExit(null, "SIGKILL");
            await vi.advanceTimersByTimeAsync(150);
            expect(spawns.length).toBe(2);
            spawns[0]?.emitExit(1, null);
            expect(spawns[0]?.listenerCount("error")).toBe(0);
            expect(onExit).toHaveBeenCalledExactlyOnceWith({
                code: null,
                signal: "SIGKILL",
                reason: "stale",
            });
            expect(driver.currentState).toBe("booting");
            void driver.stop();
            spawns[1]?.emitExit(0, null);
        } finally {
            vi.useRealTimers();
        }
    });

    it("心跳失联后收到消息则不再误判", async () => {
        vi.useFakeTimers();
        try {
            const { driver, spawns, emit } = createHarness();
            driver.start();
            await flush();
            // 30s 时收到一条 status（seenAt 更新）
            await vi.advanceTimersByTimeAsync(30_000);
            emit("sessioning");
            // 再过 20s（<45s 阈值）不误判
            await vi.advanceTimersByTimeAsync(20_000);
            expect(spawns[0]?.signals).toEqual([]);
            void driver.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it("发送信号失败后继续等待，逾期不重启，迟到退出释放账号", async () => {
        vi.useFakeTimers();
        try {
            const options = { accountDir: "unconfirmed-exit" };
            const onError = vi.fn();
            const onExit = vi.fn();
            const { driver, spawns } = createHarness({ onError, onExit }, options);
            driver.start();
            await flush();
            const child = spawns[0];
            if (child === undefined) {
                throw new Error("子进程未启动");
            }
            child.killResult = false;
            await vi.advanceTimersByTimeAsync(46_000);
            child.emit("error", new Error("发送信号异常"));
            expect(driver.currentState).toBe("terminating");
            await vi.advanceTimersByTimeAsync(25_000);
            expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
            expect(driver.currentState).toBe("failed");
            expect(onError).toHaveBeenCalledWith(
                expect.objectContaining({ code: "SIGNAL_FAILED" }),
            );
            expect(onError).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    code: "EXIT_TIMEOUT",
                    message: expect.stringContaining("9999"),
                }),
            );
            expect(onExit).not.toHaveBeenCalled();
            expect(spawns).toHaveLength(1);
            const blocked = createHarness({}, options);
            blocked.driver.start();
            await flush();
            expect(blocked.spawns).toHaveLength(0);
            expect(blocked.driver.currentState).toBe("failed");

            child.emitExit(null, "SIGKILL");
            expect(child.listenerCount("exit")).toBe(0);
            expect(child.listenerCount("error")).toBe(0);
            await vi.advanceTimersByTimeAsync(1_000);
            expect(onExit).not.toHaveBeenCalled();
            expect(spawns).toHaveLength(1);
            const next = createHarness({}, options);
            next.driver.start();
            await flush();
            expect(next.spawns).toHaveLength(1);
            const stopping = next.driver.stop();
            next.spawns[0]?.emitExit(0, null);
            await stopping;
        } finally {
            vi.useRealTimers();
        }
    });

    it("主动停止接管正在等待的失联进程，退出与升级定时器竞争时只完成一次", async () => {
        vi.useFakeTimers();
        try {
            const onExit = vi.fn();
            const { driver, spawns } = createHarness({ onExit });
            driver.start();
            await flush();
            setTimeout(() => spawns[0]?.emitExit(0, null), 51_000);
            await vi.advanceTimersByTimeAsync(46_000);
            const stopping = driver.stop();
            await vi.advanceTimersByTimeAsync(25_000);
            await stopping;
            expect(spawns[0]?.signals).toEqual(["SIGTERM"]);
            expect(driver.currentState).toBe("stopped");
            expect(onExit).toHaveBeenCalledExactlyOnceWith({
                code: 0,
                signal: null,
                reason: "stop",
            });
            expect(spawns).toHaveLength(1);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it.each([
        [78, undefined],
        [1, "INVALID_PARAM"],
    ] as const)("退出码 %s / 状态错误 %s：配置错误停止重试", async (exitCode, statusCode) => {
        vi.useFakeTimers();
        try {
            const onError = vi.fn();
            const { driver, spawns, emit } = createHarness({ onError });
            driver.start();
            await flush();
            if (statusCode !== undefined) {
                emit("failed", "bootstrap 失败", statusCode);
                expect(driver.currentState).toBe("booting");
            }
            spawns[0]?.emitExit(exitCode, null);
            await vi.advanceTimersByTimeAsync(10_000);
            expect(driver.currentState).toBe("failed");
            expect(spawns).toHaveLength(1);
            expect(onError).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({
                    code: "INVALID_PARAM",
                    message: expect.stringContaining("napuketto-boot.log"),
                }),
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it.each([undefined, "UNKNOWN", "NOT_LOGIN", "INVALID_STATE"])(
        "引导失败类别 %s 保留退避，不按文案判定",
        async (statusCode) => {
            vi.useFakeTimers();
            try {
                const { driver, spawns, emit } = createHarness();
                driver.start();
                await flush();
                emit("failed", "配置校验失败", statusCode);
                spawns[0]?.emitExit(1, null);
                await vi.advanceTimersByTimeAsync(99);
                expect(spawns).toHaveLength(1);
                await vi.advanceTimersByTimeAsync(1);
                expect(spawns).toHaveLength(2);
                const stopping = driver.stop();
                spawns[1]?.emitExit(0, null);
                await stopping;
            } finally {
                vi.useRealTimers();
            }
        },
    );
});
