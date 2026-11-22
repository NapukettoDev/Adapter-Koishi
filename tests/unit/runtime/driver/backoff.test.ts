/**
 * backoff.test.ts：指数退避纯函数单测。
 */
import { describe, expect, it } from "vitest";
import { backoffDelay } from "../../../../src/runtime/driver/supervision.js";

describe("backoffDelay", () => {
    it("第 1 次 = base", () => {
        expect(backoffDelay(1, 1_000, 2)).toBe(1_000);
    });

    it("指数增长：1000/2000/4000", () => {
        expect(backoffDelay(1, 1_000, 2)).toBe(1_000);
        expect(backoffDelay(2, 1_000, 2)).toBe(2_000);
        expect(backoffDelay(3, 1_000, 2)).toBe(4_000);
    });

    it("maxMs 封顶", () => {
        expect(backoffDelay(5, 1_000, 2, 4_000)).toBe(4_000);
    });

    it("attempt=0 兜底 = base", () => {
        expect(backoffDelay(0, 500, 3)).toBe(500);
    });
});
