/**
 * database.test.ts：数据库预热单测（docs/internals/bot.md）。
 *
 * 覆盖：channel 命中直返 / 原子 create / 唯一键冲突回读；user 事务内 create user +
 * create binding / 绑定失败回滚与补偿 / 跨 Bot 同根共享队列 / 同 key 串行 / 异 key
 * 并行 / ctx.database 不可用降级 / 失败告警去重 / authority=0 跳过。
 *
 * 使用有状态假数据库，不加载 koishi 与 minato 运行时。
 */

import type { Context } from "koishi";
import { describe, expect, it, vi } from "vitest";
import { NapukettoDatabase } from "../../../src/bot/database.js";

type Table = "user" | "binding" | "channel";

interface UserRow {
    id: number;
    authority: number;
    locales: string[];
    createdAt: Date;
}

interface BindingRow {
    aid: number;
    bid: number;
    pid: string;
    platform: string;
}

interface ChannelRow {
    id: string;
    platform: string;
    assignee?: string;
    guildId?: string;
    createdAt?: Date;
}

type Row = Record<string, unknown>;

function uniqueError(message: string): Error {
    const error = new Error(message);
    (error as Error & { code?: string }).code = "SQLITE_CONSTRAINT";
    return error;
}

function matches(row: Row, query: Row): boolean {
    return Object.entries(query).every(([key, value]) => row[key] === value);
}

/** 有状态假数据库：主键约束、事务快照回滚、可注入创建门与创建钩子。 */
class FakeDatabase {
    readonly users: UserRow[] = [];
    readonly bindings: BindingRow[] = [];
    readonly channels: ChannelRow[] = [];

    nextUserId = 1;
    transactCalls = 0;
    rollbackOnError = true;
    beforeCreate: ((table: Table, data: Row) => void) | undefined = undefined;
    createGate: { table: Table; promise: Promise<void> } | undefined = undefined;

    private transactionChain: Promise<unknown> = Promise.resolve();

    readonly upsert = vi.fn(async () => ({}));

    readonly get = vi.fn(async (table: Table, query: Row): Promise<Row[]> => {
        const rows = this.rows(table) as unknown as Row[];
        return rows.filter((row) => matches(row, query)).map((row) => ({ ...row }));
    });

    readonly create = vi.fn(async (table: Table, data: Row): Promise<Row> => {
        this.beforeCreate?.(table, data);
        if (this.createGate?.table === table) {
            await this.createGate.promise;
        }
        if (table === "user") {
            const row: UserRow = {
                id: this.nextUserId++,
                authority: Number(data["authority"]),
                locales: Array.isArray(data["locales"]) ? (data["locales"] as string[]) : [],
                createdAt: (data["createdAt"] as Date | undefined) ?? new Date(),
            };
            this.users.push(row);
            return { ...row };
        }
        if (table === "binding") {
            const row = data as unknown as BindingRow;
            if (
                this.bindings.some((item) => item.pid === row.pid && item.platform === row.platform)
            ) {
                throw uniqueError("UNIQUE constraint failed: binding.pid, binding.platform");
            }
            this.bindings.push({ ...row });
            return { ...row };
        }
        const row = data as unknown as ChannelRow;
        if (this.channels.some((item) => item.id === row.id && item.platform === row.platform)) {
            throw uniqueError("UNIQUE constraint failed: channel.id, channel.platform");
        }
        this.channels.push({ ...row });
        return { ...row };
    });

    readonly remove = vi.fn(async (table: Table, query: Row): Promise<void> => {
        const rows = this.rows(table) as unknown as Row[];
        for (let index = rows.length - 1; index >= 0; index -= 1) {
            const row = rows[index];
            if (row !== undefined && matches(row, query)) rows.splice(index, 1);
        }
    });

    readonly transact = vi.fn(
        async (callback: (tx: FakeDatabase) => Promise<unknown>): Promise<unknown> => {
            this.transactCalls += 1;
            const run = this.transactionChain
                .catch(() => undefined)
                .then(async () => {
                    const snapshot = this.snapshot();
                    try {
                        return await callback(this);
                    } catch (error) {
                        if (this.rollbackOnError) this.restore(snapshot);
                        throw error;
                    }
                });
            this.transactionChain = run.catch(() => undefined);
            return run;
        },
    );

    /** 让下一次指定表的 create 挂起，返回放行函数。 */
    setCreateGate(table: Table): () => void {
        let release: () => void = () => undefined;
        const promise = new Promise<void>((resolve) => {
            release = resolve;
        });
        this.createGate = { table, promise };
        return () => {
            this.createGate = undefined;
            release();
        };
    }

    private rows(table: Table): UserRow[] | BindingRow[] | ChannelRow[] {
        if (table === "user") return this.users;
        if (table === "binding") return this.bindings;
        return this.channels;
    }

    private snapshot(): {
        users: UserRow[];
        bindings: BindingRow[];
        channels: ChannelRow[];
        nextUserId: number;
    } {
        return structuredClone({
            users: this.users,
            bindings: this.bindings,
            channels: this.channels,
            nextUserId: this.nextUserId,
        });
    }

    private restore(snapshot: {
        users: UserRow[];
        bindings: BindingRow[];
        channels: ChannelRow[];
        nextUserId: number;
    }): void {
        this.users.splice(0, this.users.length, ...snapshot.users);
        this.bindings.splice(0, this.bindings.length, ...snapshot.bindings);
        this.channels.splice(0, this.channels.length, ...snapshot.channels);
        this.nextUserId = snapshot.nextUserId;
    }
}

/** 构造 mock ctx（database + logger，root 循环指向自身）。 */
function mockCtx(options: {
    database?: unknown;
    root?: Context;
    warn?: ReturnType<typeof vi.fn>;
}): Context {
    const self = {
        ...(options.database !== undefined ? { database: options.database } : {}),
        logger: () => ({ warn: options.warn ?? vi.fn() }),
        root: options.root ?? (null as unknown as Context),
    };
    if (options.root === undefined) {
        self.root = self as unknown as Context;
    }
    return self as unknown as Context;
}

/** 冲刷微任务队列（ensure 链有多级 await，需多轮才到 db 调用）。 */
async function flushMicrotasks(rounds = 8): Promise<void> {
    for (let index = 0; index < rounds; index += 1) {
        await Promise.resolve();
    }
}

describe("NapukettoDatabase channel", () => {
    it("已存在 → 命中直返，不写入、不覆盖 assignee/createdAt", async () => {
        const db = new FakeDatabase();
        db.channels.push({
            id: "g1",
            platform: "onebot",
            assignee: "old",
            createdAt: new Date(1),
        });
        const database = new NapukettoDatabase(mockCtx({ database: db }));
        await database.ensureChannel({
            platform: "onebot",
            id: "g1",
            assignee: "new",
        });
        expect(db.get).toHaveBeenCalledWith("channel", { id: "g1", platform: "onebot" }, ["id"]);
        expect(db.create).not.toHaveBeenCalled();
        expect(db.upsert).not.toHaveBeenCalled();
        expect(db.channels[0]?.assignee).toBe("old");
        expect(db.channels[0]?.createdAt?.getTime()).toBe(1);
    });

    it("两个 Bot 争用已存在 channel（同根）→ 都只读，不覆盖 assignee", async () => {
        const db = new FakeDatabase();
        db.channels.push({
            id: "g1",
            platform: "onebot",
            assignee: "old",
            createdAt: new Date(1),
        });
        const root = mockCtx({ database: db });
        const first = new NapukettoDatabase(root);
        const second = new NapukettoDatabase(root);
        await Promise.all([
            first.ensureChannel({ platform: "onebot", id: "g1", assignee: "10001" }),
            second.ensureChannel({ platform: "onebot", id: "g1", assignee: "10002" }),
        ]);
        expect(db.create).not.toHaveBeenCalled();
        expect(db.channels[0]?.assignee).toBe("old");
        expect(db.channels[0]?.createdAt?.getTime()).toBe(1);
    });

    it("未命中 → 单条原子 create（业务字段 + createdAt）", async () => {
        const db = new FakeDatabase();
        const database = new NapukettoDatabase(mockCtx({ database: db }));
        await database.ensureChannel({
            platform: "onebot",
            id: "g1",
            guildId: "g1",
            assignee: "10086",
        });
        expect(db.create).toHaveBeenCalledWith(
            "channel",
            expect.objectContaining({
                id: "g1",
                platform: "onebot",
                guildId: "g1",
                assignee: "10086",
                createdAt: expect.any(Date),
            }),
        );
        expect(db.upsert).not.toHaveBeenCalled();
        expect(db.channels).toHaveLength(1);
        expect(db.channels[0]?.assignee).toBe("10086");
    });

    it("创建撞唯一键 → 回读赢家，不抛错、不改写已有 assignee", async () => {
        const db = new FakeDatabase();
        db.beforeCreate = (table, data) => {
            if (table !== "channel") return;
            // 模拟另一 Koishi 实例在本实例 get 之后、create 之前完成写入
            db.channels.push({
                id: String(data["id"]),
                platform: String(data["platform"]),
                assignee: "winner",
                createdAt: new Date(2),
            });
            throw uniqueError("UNIQUE constraint failed: channel.id, channel.platform");
        };
        const database = new NapukettoDatabase(mockCtx({ database: db }));
        await expect(
            database.ensureChannel({
                platform: "onebot",
                id: "g1",
                assignee: "loser",
            }),
        ).resolves.toBeUndefined();
        expect(db.channels).toHaveLength(1);
        expect(db.channels[0]?.assignee).toBe("winner");
        expect(db.upsert).not.toHaveBeenCalled();
    });

    it("同一 channel 跨 Bot 并发（同根）→ 共享队列串行，只 create 一次", async () => {
        const db = new FakeDatabase();
        const root = mockCtx({ database: db });
        const first = new NapukettoDatabase(root);
        const second = new NapukettoDatabase(root);
        const release = db.setCreateGate("channel");
        const a = first.ensureChannel({ platform: "onebot", id: "g1", assignee: "10001" });
        const b = second.ensureChannel({ platform: "onebot", id: "g1", assignee: "10002" });
        await flushMicrotasks();
        // 第一个 create 挂起：第二个 Bot 的 get 尚未开始
        expect(db.get).toHaveBeenCalledTimes(1);
        expect(db.create).toHaveBeenCalledTimes(1);
        release();
        await Promise.all([a, b]);
        expect(db.get).toHaveBeenCalledTimes(2);
        expect(db.create).toHaveBeenCalledTimes(1);
        expect(db.channels).toHaveLength(1);
        expect(db.channels[0]?.assignee).toBe("10001");
    });

    it("不同根上下文（模拟多 Koishi 实例）→ 不共享队列，靠唯一键回读收敛", async () => {
        const db = new FakeDatabase();
        const first = new NapukettoDatabase(mockCtx({ database: db }));
        const second = new NapukettoDatabase(mockCtx({ database: db }));
        const release = db.setCreateGate("channel");
        const a = first.ensureChannel({ platform: "onebot", id: "g1", assignee: "10001" });
        const b = second.ensureChannel({ platform: "onebot", id: "g1", assignee: "10002" });
        await flushMicrotasks();
        // 两个根各自排队，均已完成 get 并进入 create
        expect(db.get).toHaveBeenCalledTimes(2);
        expect(db.create).toHaveBeenCalledTimes(2);
        release();
        await Promise.all([a, b]);
        // 输家唯一键冲突后回读赢家；最终只有一行，assignee 不被后写覆盖
        expect(db.channels).toHaveLength(1);
        expect(["10001", "10002"]).toContain(db.channels[0]?.assignee);
        expect(db.upsert).not.toHaveBeenCalled();
    });

    it("不同 channel 并发 → 并行不互相阻塞", async () => {
        const db = new FakeDatabase();
        const release = db.setCreateGate("channel");
        const database = new NapukettoDatabase(mockCtx({ database: db }));
        const first = database.ensureChannel({ platform: "onebot", id: "g1" });
        const second = database.ensureChannel({ platform: "onebot", id: "g2" });
        await flushMicrotasks();
        expect(db.get).toHaveBeenCalledTimes(2);
        expect(db.create).toHaveBeenCalledTimes(2);
        release();
        await Promise.all([first, second]);
        expect(db.channels).toHaveLength(2);
    });

    it("创建失败（非唯一致）→ 不抛错，同因跨 channel 只告警一次", async () => {
        const warn = vi.fn();
        const db = new FakeDatabase();
        db.beforeCreate = () => {
            throw new Error("boom");
        };
        const database = new NapukettoDatabase(mockCtx({ database: db, warn }));
        await expect(
            database.ensureChannel({ platform: "onebot", id: "g1" }),
        ).resolves.toBeUndefined();
        await database.ensureChannel({ platform: "onebot", id: "g2" });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[1]).toBe("channel");
        expect(String(warn.mock.calls[0]?.[4])).toContain("boom");
    });
});

describe("NapukettoDatabase user", () => {
    it("已绑定 → 命中直返，不创建、不改写 binding", async () => {
        const db = new FakeDatabase();
        db.bindings.push({ aid: 9, bid: 9, pid: "u1", platform: "onebot" });
        const database = new NapukettoDatabase(mockCtx({ database: db }));
        await database.ensureUser({ platform: "onebot", userId: "u1", authority: 3 });
        expect(db.get).toHaveBeenCalledWith("binding", { platform: "onebot", pid: "u1" }, ["aid"]);
        expect(db.transact).not.toHaveBeenCalled();
        expect(db.create).not.toHaveBeenCalled();
        expect(db.upsert).not.toHaveBeenCalled();
        expect(db.bindings[0]?.aid).toBe(9);
    });

    it("两个 Bot 争用已存在 binding（同根）→ 都只读，不改写 aid", async () => {
        const db = new FakeDatabase();
        db.bindings.push({ aid: 9, bid: 9, pid: "u1", platform: "onebot" });
        const root = mockCtx({ database: db });
        const first = new NapukettoDatabase(root);
        const second = new NapukettoDatabase(root);
        await Promise.all([
            first.ensureUser({ platform: "onebot", userId: "u1", authority: 1 }),
            second.ensureUser({ platform: "onebot", userId: "u1", authority: 3 }),
        ]);
        expect(db.transact).not.toHaveBeenCalled();
        expect(db.create).not.toHaveBeenCalled();
        expect(db.bindings[0]?.aid).toBe(9);
    });

    it("未绑定 → 事务内 create user + create binding（authority 透传，不 upsert）", async () => {
        const db = new FakeDatabase();
        const database = new NapukettoDatabase(mockCtx({ database: db }));
        await database.ensureUser({ platform: "onebot", userId: "u1", authority: 3 });
        expect(db.transact).toHaveBeenCalledTimes(1);
        expect(db.create).toHaveBeenCalledWith(
            "user",
            expect.objectContaining({ authority: 3, locales: [] }),
        );
        expect(db.create).toHaveBeenCalledWith(
            "binding",
            expect.objectContaining({ aid: 1, bid: 1, pid: "u1", platform: "onebot" }),
        );
        expect(db.upsert).not.toHaveBeenCalled();
        expect(db.users).toHaveLength(1);
        expect(db.bindings).toHaveLength(1);
    });

    it("binding 创建失败（事务回滚）→ 无孤儿 user；重试后数据一致", async () => {
        const warn = vi.fn();
        const db = new FakeDatabase();
        let failBinding = true;
        db.beforeCreate = (table) => {
            if (table === "binding" && failBinding) throw new Error("binding boom");
        };
        const database = new NapukettoDatabase(mockCtx({ database: db, warn }));
        await expect(
            database.ensureUser({ platform: "onebot", userId: "u1", authority: 1 }),
        ).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(db.users).toHaveLength(0);
        expect(db.bindings).toHaveLength(0);

        failBinding = false;
        await database.ensureUser({ platform: "onebot", userId: "u1", authority: 1 });
        expect(db.users).toHaveLength(1);
        expect(db.bindings).toHaveLength(1);
        expect(db.bindings[0]?.aid).toBe(db.users[0]?.id);
    });

    it("事务未回滚（驱动缺陷）→ 补偿删除本次创建且未绑定的 user", async () => {
        const db = new FakeDatabase();
        db.rollbackOnError = false;
        db.beforeCreate = (table) => {
            if (table === "binding") throw new Error("binding boom");
        };
        const database = new NapukettoDatabase(mockCtx({ database: db }));
        await expect(
            database.ensureUser({ platform: "onebot", userId: "u1", authority: 1 }),
        ).resolves.toBeUndefined();
        expect(db.users).toHaveLength(0);
        expect(db.bindings).toHaveLength(0);
    });

    it("binding 被另一实例抢建 → 保留赢家绑定，清理本次 user，不抛错", async () => {
        const db = new FakeDatabase();
        db.rollbackOnError = false;
        db.beforeCreate = (table, data) => {
            if (table !== "binding") return;
            db.bindings.push({ aid: 999, bid: 999, pid: String(data["pid"]), platform: "onebot" });
            throw uniqueError("UNIQUE constraint failed: binding.pid, binding.platform");
        };
        const database = new NapukettoDatabase(mockCtx({ database: db }));
        await expect(
            database.ensureUser({ platform: "onebot", userId: "u1", authority: 1 }),
        ).resolves.toBeUndefined();
        expect(db.bindings).toHaveLength(1);
        expect(db.bindings[0]?.aid).toBe(999);
        expect(db.users).toHaveLength(0);
        expect(db.upsert).not.toHaveBeenCalled();
    });

    it("不同 user 跨 Bot 并发（同根）→ 异 key 并行，各自建行", async () => {
        const db = new FakeDatabase();
        const root = mockCtx({ database: db });
        const first = new NapukettoDatabase(root);
        const second = new NapukettoDatabase(root);
        const release = db.setCreateGate("user");
        const a = first.ensureUser({ platform: "onebot", userId: "u1", authority: 1 });
        const b = second.ensureUser({ platform: "onebot", userId: "u2", authority: 2 });
        await flushMicrotasks();
        expect(db.transactCalls).toBe(2);
        release();
        await Promise.all([a, b]);
        expect(db.users).toHaveLength(2);
        expect(db.bindings).toHaveLength(2);
    });

    it("数据库无事务能力 → create user + create binding 等价创建", async () => {
        const db = new FakeDatabase();
        (db as unknown as { transact?: unknown }).transact = undefined;
        const database = new NapukettoDatabase(mockCtx({ database: db }));
        await database.ensureUser({ platform: "onebot", userId: "u1", authority: 2 });
        expect(db.users).toHaveLength(1);
        expect(db.bindings).toHaveLength(1);
        expect(db.bindings[0]?.aid).toBe(db.users[0]?.id);
    });

    it("数据库无事务能力且 binding 失败 → 补偿删除孤儿 user", async () => {
        const db = new FakeDatabase();
        (db as unknown as { transact?: unknown }).transact = undefined;
        db.beforeCreate = (table) => {
            if (table === "binding") throw new Error("binding boom");
        };
        const database = new NapukettoDatabase(mockCtx({ database: db }));
        await expect(
            database.ensureUser({ platform: "onebot", userId: "u1", authority: 1 }),
        ).resolves.toBeUndefined();
        expect(db.users).toHaveLength(0);
        expect(db.bindings).toHaveLength(0);
    });

    it("同 user 跨 Bot 并发（同根）→ 后到 Bot 命中已建 binding，不重复建 user", async () => {
        const db = new FakeDatabase();
        const root = mockCtx({ database: db });
        const first = new NapukettoDatabase(root);
        const second = new NapukettoDatabase(root);
        const release = db.setCreateGate("user");
        const a = first.ensureUser({ platform: "onebot", userId: "u1", authority: 1 });
        const b = second.ensureUser({ platform: "onebot", userId: "u1", authority: 1 });
        await flushMicrotasks();
        // 同一 key：第二个 Bot 排队，尚未进入事务
        expect(db.transactCalls).toBe(1);
        release();
        await Promise.all([a, b]);
        expect(db.transactCalls).toBe(1);
        expect(db.users).toHaveLength(1);
        expect(db.bindings).toHaveLength(1);
    });

    it("authority=0 → 跳过 user 预热", async () => {
        const db = new FakeDatabase();
        const database = new NapukettoDatabase(mockCtx({ database: db }));
        await database.ensureUser({ platform: "onebot", userId: "u1", authority: 0 });
        expect(db.get).not.toHaveBeenCalled();
        expect(db.transact).not.toHaveBeenCalled();
        expect(db.create).not.toHaveBeenCalled();
    });

    it("user 与 channel 并发预热 → 不同 key 并行不互相阻塞", async () => {
        const db = new FakeDatabase();
        const release = db.setCreateGate("user");
        const database = new NapukettoDatabase(mockCtx({ database: db }));
        const user = database.ensureUser({ platform: "onebot", userId: "u1", authority: 1 });
        const channel = database.ensureChannel({ platform: "onebot", id: "g1" });
        await flushMicrotasks();
        // user 未命中会 get 两次（快路径 + 事务内复查），channel get 一次
        expect(db.get).toHaveBeenCalledTimes(3);
        expect(db.create).toHaveBeenCalledTimes(2);
        release();
        await Promise.all([user, channel]);
    });
});

describe("NapukettoDatabase degradation", () => {
    it("ctx.database 不可用 → channel/user 各自告警一次，重复同因不刷屏", async () => {
        const warn = vi.fn();
        const database = new NapukettoDatabase(mockCtx({ warn }));
        await expect(
            database.ensureChannel({ platform: "onebot", id: "g1" }),
        ).resolves.toBeUndefined();
        await expect(
            database.ensureUser({ platform: "onebot", userId: "u1", authority: 1 }),
        ).resolves.toBeUndefined();
        await database.ensureChannel({ platform: "onebot", id: "g2" });
        expect(warn).toHaveBeenCalledTimes(2);
    });

    it("同根多 Bot 共享失败报告器 → 同因只告警一次", async () => {
        const warn = vi.fn();
        const db = new FakeDatabase();
        db.beforeCreate = () => {
            throw new Error("boom");
        };
        const root = mockCtx({ database: db, warn });
        const first = new NapukettoDatabase(root);
        const second = new NapukettoDatabase(root);
        await first.ensureChannel({ platform: "onebot", id: "g1" });
        await second.ensureChannel({ platform: "onebot", id: "g2" });
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it("不同故障原因各自保留一次完整告警", async () => {
        const warn = vi.fn();
        const db = new FakeDatabase();
        let reason = "boom-1";
        db.beforeCreate = () => {
            throw new Error(reason);
        };
        const database = new NapukettoDatabase(mockCtx({ database: db, warn }));
        await database.ensureChannel({ platform: "onebot", id: "g1" });
        reason = "boom-2";
        await database.ensureChannel({ platform: "onebot", id: "g2" });
        expect(warn).toHaveBeenCalledTimes(2);
    });
});
