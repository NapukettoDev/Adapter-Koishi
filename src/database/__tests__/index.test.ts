/**
 * index.test.ts：数据库模块单测（docs/internals/bot.md）。
 *
 * 覆盖：channel/user 命中直返 / 未命中原子创建（upsert 幂等）/ 同 key 串行 /
 * 异 key 并行 / ctx.database 不可用降级 / 失败降级（单次告警）/ autoAuthorize=0
 * 跳过 user 预热。
 */

import type { Context } from "koishi";
import { describe, expect, it, vi } from "vitest";
import { NapukettoDatabase } from "../index.js";

/** 构造 mock ctx（database + logger，root 循环指向自身），类型宽松 cast。 */
function mockCtx(overrides: { database?: unknown; warn?: ReturnType<typeof vi.fn> }): Context {
    const self = {
        ...(overrides.database !== undefined ? { database: overrides.database } : {}),
        logger: () => ({ warn: overrides.warn ?? vi.fn() }),
        // NapukettoDatabase 构造收 ctx.root（docs/internals/bot.md）；mock root 指向自身
        root: null as unknown,
    };
    self.root = self;
    return self as unknown as Context;
}

/** 已存在的 channel 行（get 命中）。 */
const EXISTING_ROW = [{ id: "g1", platform: "onebot" }];

/** 冲刷微任务队列（ensure 链有多级 await，需多轮才到 db 调用）。 */
async function flushMicrotasks(rounds = 8): Promise<void> {
    for (let i = 0; i < rounds; i++) {
        await Promise.resolve();
    }
}

describe("NapukettoDatabase", () => {
    it("已存在 → 命中直返，不写入", async () => {
        const db = {
            get: vi.fn().mockResolvedValue(EXISTING_ROW),
            upsert: vi.fn(),
        };
        const database = new NapukettoDatabase(mockCtx({ database: db }));
        await database.ensureChannel({ platform: "onebot", id: "g1" });
        expect(db.get).toHaveBeenCalledWith("channel", { id: "g1", platform: "onebot" }, ["id"]);
        expect(db.upsert).not.toHaveBeenCalled();
    });

    it("未命中 → upsert 原子创建（业务字段 + createdAt，upsert 键为主键）", async () => {
        const db = {
            get: vi.fn().mockResolvedValue([]),
            upsert: vi.fn().mockResolvedValue(undefined),
        };
        const database = new NapukettoDatabase(mockCtx({ database: db }));
        await database.ensureChannel({
            platform: "onebot",
            id: "g1",
            guildId: "g1",
            assignee: "10086",
        });
        expect(db.upsert).toHaveBeenCalledWith(
            "channel",
            [
                expect.objectContaining({
                    id: "g1",
                    platform: "onebot",
                    guildId: "g1",
                    assignee: "10086",
                }),
            ],
            ["id", "platform"],
        );
        const row = db.upsert.mock.calls[0]?.[1]?.[0] as { createdAt?: unknown };
        expect(row.createdAt).toBeInstanceOf(Date);
    });

    it("同 channel 并发 ensure → 串行排队（前序 upsert 挂起时后续不开始）", async () => {
        let releaseGate: (value?: unknown) => void = () => undefined;
        const gate = new Promise((resolve) => {
            releaseGate = resolve;
        });
        const db = {
            get: vi.fn().mockResolvedValue([]),
            upsert: vi.fn().mockImplementation((_table: string, rows: Array<{ id: string }>) => {
                if (rows[0]?.id === "g1") {
                    return gate; // 第一次 upsert 挂起
                }
                return Promise.resolve();
            }),
        };
        const database = new NapukettoDatabase(mockCtx({ database: db }));
        const first = database.ensureChannel({ platform: "onebot", id: "g1" });
        const second = database.ensureChannel({ platform: "onebot", id: "g1" });
        await flushMicrotasks();
        // 前序 upsert 挂起中：第二个 ensure 的 get 不应被调用
        expect(db.get).toHaveBeenCalledTimes(1);
        releaseGate();
        await Promise.all([first, second]);
        expect(db.get).toHaveBeenCalledTimes(2);
        expect(db.upsert).toHaveBeenCalledTimes(2);
    });

    it("不同 channel 并发 → 并行不互相阻塞", async () => {
        let releaseGate: (value?: unknown) => void = () => undefined;
        const gate = new Promise((resolve) => {
            releaseGate = resolve;
        });
        const db = {
            get: vi.fn().mockResolvedValue([]),
            upsert: vi.fn().mockImplementation((_table: string, rows: Array<{ id: string }>) => {
                if (rows[0]?.id === "g1") {
                    return gate; // g1 挂起
                }
                return Promise.resolve();
            }),
        };
        const database = new NapukettoDatabase(mockCtx({ database: db }));
        const first = database.ensureChannel({ platform: "onebot", id: "g1" });
        const second = database.ensureChannel({ platform: "onebot", id: "g2" });
        await flushMicrotasks();
        // g1 挂起中 g2 已开始（不同 channel 不排队）
        expect(db.get).toHaveBeenCalledTimes(2);
        releaseGate();
        await Promise.all([first, second]);
    });

    it("ctx.database 不可用 → 降级跳过，不抛错", async () => {
        const warn = vi.fn();
        const database = new NapukettoDatabase(mockCtx({ warn }));
        await expect(
            database.ensureChannel({ platform: "onebot", id: "g1" }),
        ).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it("upsert 失败 → 不抛错、单次告警（同因不刷屏）", async () => {
        const warn = vi.fn();
        const db = {
            get: vi.fn().mockResolvedValue([]),
            upsert: vi.fn().mockRejectedValue(new Error("boom")),
        };
        const database = new NapukettoDatabase(mockCtx({ database: db, warn }));
        await expect(
            database.ensureChannel({ platform: "onebot", id: "g1" }),
        ).resolves.toBeUndefined();
        await database.ensureChannel({ platform: "onebot", id: "g2" });
        expect(warn).toHaveBeenCalledTimes(1);
    });

    // ── user 预热（ensureUser） ──

    it("user 已绑定 → 命中直返，不写入", async () => {
        const db = {
            get: vi.fn().mockResolvedValue([{ aid: 9 }]),
            create: vi.fn(),
            upsert: vi.fn(),
        };
        const database = new NapukettoDatabase(mockCtx({ database: db }));
        await database.ensureUser({ platform: "onebot", userId: "u1", authority: 1 });
        expect(db.get).toHaveBeenCalledWith("binding", { platform: "onebot", pid: "u1" }, ["aid"]);
        expect(db.create).not.toHaveBeenCalled();
        expect(db.upsert).not.toHaveBeenCalled();
    });

    it("user 未绑定 → create user + upsert binding（幂等，authority 透传）", async () => {
        const db = {
            get: vi.fn().mockResolvedValue([]),
            create: vi.fn().mockResolvedValue({ id: 42 }),
            upsert: vi.fn().mockResolvedValue(undefined),
        };
        const database = new NapukettoDatabase(mockCtx({ database: db }));
        await database.ensureUser({ platform: "onebot", userId: "u1", authority: 3 });
        expect(db.create).toHaveBeenCalledWith(
            "user",
            expect.objectContaining({ authority: 3, locales: [] }),
        );
        expect(db.upsert).toHaveBeenCalledWith(
            "binding",
            [{ aid: 42, bid: 42, pid: "u1", platform: "onebot" }],
            ["pid", "platform"],
        );
    });

    it("authority=0 → 跳过 user 预热（koishi autoAuthorize=0 不落库语义）", async () => {
        const db = {
            get: vi.fn(),
            create: vi.fn(),
            upsert: vi.fn(),
        };
        const database = new NapukettoDatabase(mockCtx({ database: db }));
        await database.ensureUser({ platform: "onebot", userId: "u1", authority: 0 });
        expect(db.get).not.toHaveBeenCalled();
        expect(db.create).not.toHaveBeenCalled();
    });

    it("user 与 channel 并发预热 → 不同 key 并行不互相阻塞", async () => {
        let releaseGate: (value?: unknown) => void = () => undefined;
        const gate = new Promise((resolve) => {
            releaseGate = resolve;
        });
        const db = {
            get: vi.fn().mockResolvedValue([]),
            create: vi.fn().mockResolvedValue({ id: 1 }),
            upsert: vi.fn().mockImplementation((_table: string, rows: Array<{ pid?: string }>) => {
                if (rows[0]?.pid === "u1") {
                    return gate; // user 挂起
                }
                return Promise.resolve();
            }),
        };
        const database = new NapukettoDatabase(mockCtx({ database: db }));
        const user = database.ensureUser({ platform: "onebot", userId: "u1", authority: 1 });
        const channel = database.ensureChannel({ platform: "onebot", id: "g1" });
        await flushMicrotasks();
        // user 挂起中 channel 已开始（channel: / user: key 隔离）
        expect(db.get).toHaveBeenCalledTimes(2);
        releaseGate();
        await Promise.all([user, channel]);
    });
});
