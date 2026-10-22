/**
 * index.ts：数据库操作集中管理（docs/internals/bot.md）。
 *
 * 背景：插件此前无自有数据库操作——channel/user 落库全在 koishi 框架内部
 * （Session.getChannel）。而 koishi 的 getChannel 是 check-then-act：先 SELECT，
 * 未命中才 createChannel（INSERT）。多条消息同 tick dispatch（QQ 批量推送 + 群通知
 * 高频事件）时，各 session 的 SELECT 全部先于首个 INSERT 完成 → 多个 INSERT 撞
 * (id, platform) 唯一键（2026-08-09 实测：同批 4 条消息 → 1 成功 + 3 次
 * `UNIQUE constraint failed: channel.id, channel.platform`）。过滤系统占位消息
 * （senderUin="0"）只能消除系统场景，真实消息批量到达仍会触发。
 *
 * 本模块在 dispatch 前原子预热 channel/user：命中直接返回；未命中走 minato
 * upsert（INSERT ... ON CONFLICT DO UPDATE，并发安全幂等不抛错）。预热后 koishi
 * 的 getChannel/getUser SELECT 必命中，永远走不到 createChannel/createUser——
 * 从根上消除竞态。预热失败只单次告警不阻断消息（koishi get-or-create 兜底）。
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
import { SerialQueue } from "./serial-queue.js";

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

/** 数据库操作集中管理（无全局单例，每 bot 实例一份）。 */
export class NapukettoDatabase {
    /** per-key 串行链（serial-queue.ts 独立类：同 key 串行、异 key 并行）。 */
    private readonly queue = new SerialQueue();
    /** 降级/失败告警已打标记（每实例只打一次，防刷屏）。 */
    private warned = false;

    /** 收 root ctx（见文件头 ⚠️：scope 访问 database 有 warning 且可能解析不到）。 */
    private readonly ctx: Context;

    constructor(ctx: Context) {
        // root.internal 一定含 database（provide 写 root）；checkInject 对 root 放行
        this.ctx = ctx.root;
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

    /** 实际预热 channel：命中即返回；未命中 upsert（幂等，并发安全）。 */
    private async runEnsureChannel(data: EnsureChannelData): Promise<void> {
        const db = this.ctx.database;
        if (db === undefined) {
            this.warnOnce("ctx.database 不可用，跳过 channel 预热（koishi 兜底）");
            return;
        }
        try {
            const existing = await db.get("channel", { id: data.id, platform: data.platform }, [
                "id",
            ]);
            if (existing.length > 0) {
                return; // 已存在：koishi getChannel 必命中，无需写入
            }
            await db.upsert(
                "channel",
                [
                    {
                        id: data.id,
                        platform: data.platform,
                        // exactOptionalPropertyTypes：可选字段条件展开
                        ...(data.guildId !== undefined ? { guildId: data.guildId } : {}),
                        ...(data.assignee !== undefined ? { assignee: data.assignee } : {}),
                        // createdAt 只随新行携带；已存在行 upsert 只 merge 业务字段
                        createdAt: new Date(),
                    },
                ],
                ["id", "platform"],
            );
        } catch (error) {
            // 预热失败不阻断消息（koishi get-or-create 兜底）；单次告警防刷屏
            this.warnOnce(
                `channel 预热失败（${data.platform}:${data.id}）: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /**
     * 实际预热 user：binding 命中直返；未命中 create user + upsert binding。
     *
     * 与 koishi createUser 对齐（session.ts）：user 表插入（id autoInc，无唯一键，
     * 并发重复创建无害）→ binding 表插入（(pid, platform) 主键，upsert 幂等合并
     * 保证并发安全）。不写 user 表 platform 列（依赖 login-added 迁移列，binding
     * 映射已足够——getUser 经 binding.aid 查 user）。
     */
    private async runEnsureUser(data: EnsureUserData): Promise<void> {
        const db = this.ctx.database;
        if (db === undefined) {
            this.warnOnce("ctx.database 不可用，跳过 user 预热（koishi 兜底）");
            return;
        }
        try {
            const binding = await db.get("binding", { platform: data.platform, pid: data.userId }, [
                "aid",
            ]);
            if (binding.length > 0) {
                return; // 已绑定：koishi getUser 必命中，无需写入
            }
            // user 表插入（Model.create 填默认 flag/locales/permissions；authority 必给）
            const user = await db.create("user", {
                authority: data.authority,
                locales: [],
                createdAt: new Date(),
            });
            const uid = (user as { id?: number }).id;
            if (uid === undefined) {
                throw new Error("create user 未返回 id");
            }
            // binding upsert：并发安全（多个并发预热只落一行）
            await db.upsert(
                "binding",
                [{ aid: uid, bid: uid, pid: data.userId, platform: data.platform }],
                ["pid", "platform"],
            );
        } catch (error) {
            // 预热失败不阻断消息（koishi get-or-create 兜底）；单次告警防刷屏
            this.warnOnce(
                `user 预热失败（${data.platform}:${data.userId}）: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /** 单次告警（防同因刷屏；失败原因变化时不再重复提示，可接受）。 */
    private warnOnce(message: string): void {
        if (this.warned) {
            return;
        }
        this.warned = true;
        // 无 logger 实例：走 ctx.logger（koishi 统一日志）
        this.ctx.logger("napuketto").warn(message);
    }
}
