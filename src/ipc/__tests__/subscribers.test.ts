/**
 * subscribers.test.ts：SubscriberSet 单测。
 *
 * 覆盖：add/dispatch 基础语义、退订（幂等）、重复订阅去重、
 * 快照遍历（回调内增删订阅不影响本次通知）、clear。
 */
import { describe, expect, it } from "vitest";
import { SubscriberSet } from "../transport.js";

describe("SubscriberSet", () => {
    it("add 订阅 → dispatch 通知", () => {
        const set = new SubscriberSet<[number]>();
        const received: number[] = [];
        set.add((value) => {
            received.push(value);
        });
        set.dispatch(1);
        set.dispatch(2);
        expect(received).toEqual([1, 2]);
    });

    it("add 返回退订函数 → 退订后不再收到（重复退订幂等）", () => {
        const set = new SubscriberSet<[]>();
        const calls: number[] = [];
        const unsubscribe = set.add(() => {
            calls.push(1);
        });
        set.dispatch();
        unsubscribe();
        unsubscribe(); // 幂等：重复退订不抛错
        set.dispatch();
        expect(calls).toEqual([1]);
    });

    it("同一 handler 重复 add → dispatch 只通知一次", () => {
        const set = new SubscriberSet<[]>();
        const received: number[] = [];
        const wrapped = () => {
            received.push(1);
        };
        set.add(wrapped);
        set.add(wrapped); // 重复订阅同一引用（Set 去重）
        set.dispatch();
        expect(received).toEqual([1]);
    });

    it("快照遍历：回调内退订不影响本次通知", () => {
        const set = new SubscriberSet<[]>();
        const order: string[] = [];
        set.add(() => {
            order.push("a");
            // 在 a 回调中退订 b——本次通知 b 仍应收到（快照遍历）
            unsubscribeB();
        });
        const unsubscribeB = set.add(() => {
            order.push("b");
        });
        set.dispatch();
        expect(order).toEqual(["a", "b"]);
        // 下一轮 b 已退订
        set.dispatch();
        expect(order).toEqual(["a", "b", "a"]);
    });

    it("快照遍历：回调内新增订阅不影响本次通知", () => {
        const set = new SubscriberSet<[]>();
        const order: string[] = [];
        set.add(() => {
            order.push("a");
            set.add(() => {
                order.push("c");
            });
        });
        set.add(() => {
            order.push("b");
        });
        set.dispatch();
        expect(order).toEqual(["a", "b"]); // c 本轮不收到
        set.dispatch();
        expect(order).toEqual(["a", "b", "a", "b", "c"]); // 下轮 c 收到
    });

    it("clear 清空全部订阅", () => {
        const set = new SubscriberSet<[]>();
        const calls: number[] = [];
        set.add(() => {
            calls.push(1);
        });
        set.add(() => {
            calls.push(2);
        });
        set.clear();
        set.dispatch();
        expect(calls).toEqual([]);
    });

    it("无订阅时 dispatch 不抛错", () => {
        const set = new SubscriberSet<[string]>();
        expect(() => set.dispatch("x")).not.toThrow();
    });

    it("多参数订阅", () => {
        const set = new SubscriberSet<[string, number]>();
        const received: [string, number][] = [];
        set.add((name, count) => {
            received.push([name, count]);
        });
        set.dispatch("a", 1);
        set.dispatch("b", 2);
        expect(received).toEqual([
            ["a", 1],
            ["b", 2],
        ]);
    });
});
