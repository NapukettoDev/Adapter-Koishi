/**
 * driver.test.ts：NapukettoDriver 启动 + 停止单测。
 *
 * 用 FakeChild + MemoryLinePair 注入（test-utils.ts），不依赖真实子进程。
 */
import { describe, expect, it, vi } from "vitest";
import type { IpcMessage } from "../../ipc/index.js";
import { MemoryLinePair } from "../../ipc/test-utils.js";
import { NapukettoDriver } from "../driver.js";
import { createHarness, flush } from "../test-utils.js";

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
        driver.stop();
    });

    it("start 幂等（非 idle 忽略）", async () => {
        const { driver, spawns } = createHarness();
        driver.start();
        await flush();
        const count = spawns.length;
        driver.start();
        expect(spawns.length).toBe(count);
        driver.stop();
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
});

describe("NapukettoDriver 停止", () => {
    it("launch 返回前停止 → 回收随后返回的子进程", async () => {
        const onReady = vi.fn();
        const { driver, peers, spawns } = createHarness({ onReady });
        driver.start();
        driver.stop();
        await flush();

        expect(spawns[0]?.killed).toBe(true);
        expect(peers).toHaveLength(0);
        expect(driver.currentClient).toBeNull();
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
        driver.stop();
        expect(driver.currentState).toBe("stopping");
        expect(received.some((m) => m.type === "control")).toBe(true);

        // 子进程收到 stop 后退出 → finishStop
        spawns[0]?.emitExit(0, null);
        await flush();
        expect(driver.currentState).toBe("stopped");
        expect(onExit).toHaveBeenCalledWith(expect.objectContaining({ code: 0, reason: "crash" }));
    });

    it("stop 后子进程不退出 → 5s 超时强杀 → stopped", async () => {
        vi.useFakeTimers();
        try {
            const { driver, spawns } = createHarness();
            driver.start();
            await flush();
            driver.stop();
            // 子进程不退出：超时后强杀 + finishStop
            await vi.advanceTimersByTimeAsync(5_100);
            expect(spawns[0]?.killed).toBe(true);
            expect(driver.currentState).toBe("stopped");
        } finally {
            vi.useRealTimers();
        }
    });

    it("stop 后不重启（即便随后 exit）", async () => {
        const { driver, spawns } = createHarness();
        driver.start();
        await flush();
        driver.stop();
        spawns[0]?.emitExit(1, null);
        await flush();
        expect(driver.currentState).toBe("stopped");
    });
});
