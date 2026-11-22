/**
 * pending.test.ts：PendingRequests 单测（自 client.ts 拆出的请求生命周期）。
 *
 * 覆盖：id 单调递增 / 成功 resolve / 失败 reject（带动作名 + 错误码透传）/
 * 迟到响应忽略（resolve/reject 返回 false）/ 超时 reject IpcError(TIMEOUT)/
 * rejectAll 全部 CLOSED（幂等）/ 超时后条目清理。
 */
import { describe, expect, it, vi } from "vitest";
import { PendingRequests } from "../../../../src/runtime/ipc/pending.js";

describe("PendingRequests", () => {
    it("id 单调递增", async () => {
        const pr = new PendingRequests();
        const a = pr.add("a", 1_000);
        const b = pr.add("b", 1_000);
        expect(b.id).toBe(a.id + 1);
        // 清理 pending，避免未处理 rejection
        const assertionA = expect(a.promise).rejects.toMatchObject({ code: "CLOSED" });
        const assertionB = expect(b.promise).rejects.toMatchObject({ code: "CLOSED" });
        pr.rejectAll();
        await assertionA;
        await assertionB;
    });

    it("成功响应 → resolve 对应值并返回 true", async () => {
        const pr = new PendingRequests();
        const { id, promise } = pr.add("sendMessage", 1_000);
        const assertion = expect(promise).resolves.toBe("ok");
        expect(pr.resolve(id, "ok")).toBe(true);
        await assertion;
    });

    it("失败响应 → reject 带动作名与错误码透传", async () => {
        const pr = new PendingRequests();
        const { id, promise } = pr.add("sendMessage", 1_000);
        const assertion = expect(promise).rejects.toMatchObject({
            name: "IpcError",
            code: "BUSY",
            message: "动作 sendMessage 失败: 忙",
        });
        expect(pr.reject(id, { code: "BUSY", message: "忙" })).toBe(true);
        await assertion;
    });

    it("迟到响应（条目不存在）→ 返回 false 忽略，不抛错", () => {
        const pr = new PendingRequests();
        expect(pr.resolve(42, "x")).toBe(false);
        expect(pr.reject(42, { code: "X", message: "x" })).toBe(false);
    });

    it("超时 → reject IpcError(TIMEOUT)，消息带超时值与动作名", async () => {
        vi.useFakeTimers();
        try {
            const pr = new PendingRequests();
            const { promise } = pr.add("sendMessage", 1_000);
            const assertion = expect(promise).rejects.toMatchObject({
                name: "IpcError",
                code: "TIMEOUT",
                message: "动作超时（1000ms）: sendMessage",
            });
            vi.advanceTimersByTime(1_001);
            await assertion;
        } finally {
            vi.useRealTimers();
        }
    });

    it("超时后条目清理 → 迟到 resolve 返回 false", async () => {
        vi.useFakeTimers();
        try {
            const pr = new PendingRequests();
            const { id, promise } = pr.add("a", 1_000);
            const assertion = expect(promise).rejects.toMatchObject({ code: "TIMEOUT" });
            vi.advanceTimersByTime(1_001);
            await assertion;
            expect(pr.resolve(id, "x")).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it("rejectAll → 全部 reject CLOSED（幂等，二次调用无操作）", async () => {
        const pr = new PendingRequests();
        const a = pr.add("a", 1_000);
        const b = pr.add("b", 1_000);
        const assertionA = expect(a.promise).rejects.toMatchObject({ code: "CLOSED" });
        const assertionB = expect(b.promise).rejects.toMatchObject({ code: "CLOSED" });
        pr.rejectAll();
        pr.rejectAll(); // 幂等：无 pending 时 no-op
        await assertionA;
        await assertionB;
    });
});
