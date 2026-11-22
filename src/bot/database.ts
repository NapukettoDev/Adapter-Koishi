/**
 * 数据库操作集中管理（docs/internals/bot.md）。
 *
 * 背景：插件此前无自有数据库操作——channel/user 落库全在 koishi 框架内部
 * （Session.getChannel）。而 koishi 的 getChannel 是 check-then-act：先 SELECT，
 * 未命中才 createChannel（INSERT）。多条消息同 tick dispatch（QQ 批量推送 + 群通知
 * 高频事件）时，各 session 的 SELECT 全部先于首个 INSERT 完成 → 多个 INSERT 撞
 * (id, platform) 唯一键（2026-08-09 实测：同批 4 条消息 → 1 成功 + 3 次
 * `UNIQUE constraint failed: channel.id, channel.platform`）。过滤系统占位消息
 * （senderUin="0"）只能消除系统场景，真实消息批量到达仍会触发。
 *
 * 本模块在 dispatch 前原子预热 channel/user：命中直接返回；未命中走单条原子
 * create（channel）或事务内 create user + create binding（user）。并发/跨进程
 * 撞唯一键时回读已存在记录，不覆盖 assignee / createdAt / binding.aid，也不在
 * 事务失败后遗留孤儿 user。预热后 koishi 的 getChannel/getUser SELECT 必命中，
 * 永远走不到 createChannel/createUser——从根上消除竞态。预热失败只告警不阻断
 * 消息（koishi get-or-create 兜底）。
 *
 * ⚠️ 框架侧根因已上报：koishijs/koishi#1545（getChannel/getUser check-then-act
 * 无原子性）；本模块为插件侧临时规避（根治待框架修复，届时本模块可降级/移除）。
 *
 * ⚠️ 服务访问（2026-08-09 修订）：cordis 的 provide 把服务注册在
 * ctx.root[symbols.internal]，但 resolveInject 只查当前 ctx 自己的 internal——
 * 插件 scope 的 ctx 自身 internal 为空对象会遮蔽 root 链，`ctx.database` 解析为
 * undefined 且每次访问都 emit `internal/warning`（实测每条消息刷 `property
 * database is not registered`）。修复：构造时收 `ctx.root`——root 的 internal 一定
 * 含 database，且 checkInject 对 root 直接放行（root 无 plugin runtime，不产生
 * warning）。配套 `NapukettoBot` 声明 static inject optional 双保险。
 */

import type { Context } from "koishi";
import { PreheatFailureReporter } from "./failure-reporter.js";

/** channel 预热字段（dispatch 前 session 字段子集）。 */
export interface EnsureChannelData {
    platform: string;
    id: string;
    /** 群号（群聊 channel 有；私聊/临时会话可缺省）。 */
    guildId?: string;
    /** 受理人（autoAssign 语义下为 selfId；缺省不写）。 */
    assignee?: string;
}

/** user 预热字段（dispatch 前 session 字段子集）。 */
export interface EnsureUserData {
    platform: string;
    userId: string;
    /** 权限等级（autoAuthorize 语义，koishi 默认 1；0 = 不落库跳过）。 */
    authority: number;
}

/** 串行队列 key 前缀（同 key 串行、异 key 并行）。 */
const CHANNEL_KEY = "channel:";
const USER_KEY = "user:";

/** db 不可用时的稳定错误（同一签名只告警一次，后续由报告器计数）。 */
const MISSING_DATABASE = new Error("ctx.database 不可用，跳过预热（koishi 兜底）");

type Database = NonNullable<Context["database"]>;

/**
 * 同根上下文共享状态：per-key 串行队列 + 失败报告器。
 *
 * 同一进程内多个 Bot 的 NapukettoDatabase 实例共享它，按 (platform, record key)
 * 协调创建路径；不同 Koishi 进程之间无共享内存，只能依赖数据库唯一键 + 原子创建 /
 * 事务回滚（见 docs/internals/bot.md「数据库预热」）。
 */
interface SharedDatabaseState {
    queue: SerialQueue;
    failures: PreheatFailureReporter;
}

const sharedStates = new WeakMap<Context, SharedDatabaseState>();

function getSharedState(root: Context): SharedDatabaseState {
    const existing = sharedStates.get(root);
    if (existing !== undefined) return existing;
    const state: SharedDatabaseState = {
        queue: new SerialQueue(),
        failures: new PreheatFailureReporter({
            warn: (message, ...args) => root.logger("napuketto").warn(message, ...args),
        }),
    };
    sharedStates.set(root, state);
    return state;
}

/** 读取 create("user") 返回的自增 id。 */
function readUserId(user: unknown): number | undefined {
    if (typeof user !== "object" || user === null) return undefined;
    const id = (user as Record<string, unknown>)["id"];
    return typeof id === "number" ? id : undefined;
}

/** 数据库操作集中管理（无全局单例，每 bot 实例一份；共享状态按 root 复用）。 */
export class NapukettoDatabase {
    /** 同根上下文共享的 per-key 串行链（同 key 串行、异 key 并行）。 */
    private readonly queue: SerialQueue;
    /** 同根上下文共享的失败报告器（保留不同故障证据并限频）。 */
    private readonly failures: PreheatFailureReporter;
    /** 收 root ctx（见文件头 ⚠️）。 */
    private readonly ctx: Context;

    constructor(ctx: Context) {
        this.ctx = ctx.root;
        const shared = getSharedState(this.ctx);
        this.queue = shared.queue;
        this.failures = shared.failures;
    }

    /**
     * 原子预热 channel（dispatch 前调用）。
     *
     * 同 channel 串行排队（保证消息 dispatch 顺序与预热顺序一致），不同 channel
     * 并行。返回 promise 在预热完成（或降级跳过）后 resolve，绝不 reject。
     */
    ensureChannel(data: EnsureChannelData): Promise<void> {
        return this.queue.enqueue(`${CHANNEL_KEY}${data.platform}:${data.id}`, () =>
            this.runEnsureChannel(data),
        );
    }

    /**
     * 原子预热 user（dispatch 前调用）。
     *
     * 同 user 串行排队，不同 user 并行。`authority=0` 时跳过（koishi
     * autoAuthorize=0 不落库，保持语义）。绝不 reject。
     */
    ensureUser(data: EnsureUserData): Promise<void> {
        if (data.authority === 0) {
            return Promise.resolve();
        }
        return this.queue.enqueue(`${USER_KEY}${data.platform}:${data.userId}`, () =>
            this.runEnsureUser(data),
        );
    }

    /** 实际预热 channel：命中即返回；未命中单条原子 create，冲突后回读。 */
    private async runEnsureChannel(data: EnsureChannelData): Promise<void> {
        const db = this.ctx.database;
        if (db === undefined) {
            this.failures.report("channel", data.platform, data.id, MISSING_DATABASE);
            return;
        }
        const key = { id: data.id, platform: data.platform };
        try {
            const existing = await db.get("channel", key, ["id"]);
            if (existing.length > 0) {
                return; // 已存在：koishi getChannel 必命中，无需写入
            }
            try {
                await db.create("channel", {
                    ...key,
                    // exactOptionalPropertyTypes：可选字段条件展开
                    ...(data.guildId !== undefined ? { guildId: data.guildId } : {}),
                    ...(data.assignee !== undefined ? { assignee: data.assignee } : {}),
                    createdAt: new Date(),
                });
            } catch (error) {
                // 并发/跨进程创建撞主键：回读确认；命中说明另一路径已建。
                // 绝不在这里 upsert——否则会覆盖已有行的 assignee / createdAt。
                const [winner] = await db.get("channel", key, ["id"]).catch(() => []);
                if (winner !== undefined) return;
                throw error;
            }
        } catch (error) {
            // 预热失败不阻断消息（koishi get-or-create 兜底）
            this.failures.report("channel", data.platform, data.id, error);
        }
    }

    /**
     * 实际预热 user：binding 命中直返；未命中在事务内 create user + create binding。
     *
     * 事务保证「user 建好后 binding 失败」会整体回滚，不留孤儿 user。跨进程并发时
     * binding 主键冲突使输家事务回滚；回读命中赢家的 binding 即视为成功。绝不
     * upsert binding——那会把已有绑定改到新的 aid（覆盖 assignee 等历史数据）。
     */
    private async runEnsureUser(data: EnsureUserData): Promise<void> {
        const db = this.ctx.database;
        if (db === undefined) {
            this.failures.report("user", data.platform, data.userId, MISSING_DATABASE);
            return;
        }
        const key = { platform: data.platform, pid: data.userId };
        try {
            const binding = await db.get("binding", key, ["aid"]);
            if (binding.length > 0) {
                return; // 已绑定：koishi getUser 必命中，无需写入
            }
            await this.createUserWithBinding(db, data);
        } catch (error) {
            // 事务已回滚或并发输家：只要另一路径完成绑定，就按成功处理。
            if (await this.bindingExists(db, data)) return;
            this.failures.report("user", data.platform, data.userId, error);
        }
    }

    /** 创建 user + binding；优先事务，数据库无事务能力时退化为原子 create + 补偿清理。 */
    private async createUserWithBinding(db: Database, data: EnsureUserData): Promise<void> {
        if (typeof db.transact !== "function") {
            await this.createUserWithBindingFallback(db, data);
            return;
        }
        let createdUid: number | undefined;
        try {
            await db.transact(async (tx) => {
                // 事务内二次检查：同 key 队列只在进程内生效，跨进程要靠这里 + 主键冲突。
                const binding = await tx.get(
                    "binding",
                    { platform: data.platform, pid: data.userId },
                    ["aid"],
                );
                if (binding.length > 0) return;
                const user = await tx.create("user", {
                    authority: data.authority,
                    locales: [],
                    createdAt: new Date(),
                });
                const uid = readUserId(user);
                if (uid === undefined) throw new Error("create user 未返回 id");
                createdUid = uid;
                // create 而非 upsert：撞主键时回滚整个事务，绝不改写已有 binding.aid。
                await tx.create("binding", {
                    aid: uid,
                    bid: uid,
                    pid: data.userId,
                    platform: data.platform,
                });
            });
        } catch (error) {
            // 事务驱动应已回滚；若驱动未回滚（或 rollback 本身失败），补偿删除本次
            // 创建且仍未绑定的 user，避免重试累积孤儿行。
            if (createdUid !== undefined) {
                await this.discardUnboundUser(db, createdUid);
            }
            throw error;
        }
    }

    /** 无事务能力的等价路径：create user → create binding，失败时补偿删除孤儿 user。 */
    private async createUserWithBindingFallback(db: Database, data: EnsureUserData): Promise<void> {
        const user = await db.create("user", {
            authority: data.authority,
            locales: [],
            createdAt: new Date(),
        });
        const uid = readUserId(user);
        if (uid === undefined) throw new Error("create user 未返回 id");
        try {
            await db.create("binding", {
                aid: uid,
                bid: uid,
                pid: data.userId,
                platform: data.platform,
            });
        } catch (error) {
            await this.discardUnboundUser(db, uid);
            throw error;
        }
    }

    /** 仅当 user 未被任何 binding 引用时删除（事务/绑定失败后的补偿）。 */
    private async discardUnboundUser(db: Database, uid: number): Promise<void> {
        try {
            const binding = await db.get("binding", { aid: uid }, ["aid"]);
            if (binding.length > 0) return;
            await db.remove("user", { id: uid });
        } catch {
            // 补偿清理失败不覆盖主失败；下一次预热会重新尝试。
        }
    }

    /** binding 是否已存在；查询失败按不存在处理（保留原始错误上报）。 */
    private async bindingExists(db: Database, data: EnsureUserData): Promise<boolean> {
        try {
            const binding = await db.get("binding", { platform: data.platform, pid: data.userId }, [
                "aid",
            ]);
            return binding.length > 0;
        } catch {
            return false;
        }
    }
}

/**
 * 职责：同 key 任务串行排队（前序失败不阻塞后续），异 key 并行；
 * 链尾完成后自动清理引用（防 Map 无限增长）。通用实现，与数据库无关。
 */
/** per-key 串行队列（同 key 串行、异 key 并行）。 */
export class SerialQueue {
    /** key → 当前链尾 promise。 */
    private readonly chains = new Map<string, Promise<void>>();

    /**
     * 排队执行任务：同 key 串行（等待前序完成，前序失败不阻塞），
     * 异 key 并行。返回当前任务的 promise，失败不影响后续任务入队。
     */
    enqueue(key: string, task: () => Promise<void>): Promise<void> {
        const prev = this.chains.get(key) ?? Promise.resolve();
        const next = prev.catch(() => undefined).then(task);
        this.chains.set(key, next);
        // 链尾完成后清理（无新任务排队时删除引用，防 Map 无限增长）
        // ⚠️ 清理链前接 .catch 吞掉任务失败：next.finally() 的派生 promise
        // 会随 next 一起 reject，被 void 丢弃 → unhandled rejection
        void next
            .catch(() => undefined)
            .finally(() => {
                if (this.chains.get(key) === next) {
                    this.chains.delete(key);
                }
            });
        return next;
    }
}
