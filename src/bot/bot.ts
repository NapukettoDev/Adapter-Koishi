/**
 * bot.ts：NapukettoBot——koishi Bot 子类（docs/internals/bot.md，端到端验证点）。
 *
 * 装配方式：不写 Adapter（fork/connect 为 HTTP/WS 网络服务设计）。koishi Bot
 * 构造自动注册 `ctx.on('ready', () => this.start())`——override start() spawn
 * driver（进程编排），stop() 停 driver。
 *
 * 链路：driver（子进程生命周期）→ IPC client → 事件桥（kernel 事件 → koishi
 * session，dispatch）+ 动作桥（NapukettoInternal，koishi 动作 → IPC action）。
 *
 * 运行时 import koishi（Bot/Universal 等）——本文件不进单测（docs/guides/development.md 单测边界）。
 *
 * ⚠️ Context 来源（2026-08-08 修复）：Bot 基类（satorijs）的泛型约束是
 * satorijs/cordis 的 Context，而 koishi 的 Context（独立 interface，含
 * [minato.Types] 泛型）在 exactOptionalPropertyTypes 下不满足该约束（逆变
 * 不兼容，部分 TS 版本报 TS2344）。修复：从 koishi 重新导出的 Bot 上取
 * `ctx` 属性类型（Bot["ctx"]，即约束正主 satorijs Context），不直接依赖
 * `@satorijs/core`——运行时传入的仍是 koishi.Context（其子类），类型层面
 * 只按 Bot 基类能力使用，无需 koishi 特有 API。
 */

import { join } from "node:path";
import { resolveDataRoot } from "@napuketto/kernel";
import { Bot, type Context as KoishiContext, type MessageEncoder, type Universal } from "koishi";
import { requireFirstPage } from "../actions/ob11-resources.js";
import { type LogLevel, type NapukettoBotConfig, napukettoConfigSchema } from "../config.js";
import { BOT_STATUS, PRIVATE_PREFIX } from "../constants.js";
import { NapukettoDatabase } from "../database/index.js";
import { NapukettoDriver } from "../driver/index.js";
import type {
    NapukettoEventBridge,
    NapukettoSessionFields,
    Ob11EventPayload,
} from "../events/index.js";
import { IpcError } from "../ipc/errors.js";
import type { IpcLoginPayload, NapukettoIpcClient } from "../ipc/index.js";
import type { NapukettoLoginState } from "../login/index.js";
import { buildLaunch } from "./launch.js";
import type { NapukettoLoginPanel } from "./login-panel.js";
import { NapukettoMessageEncoder } from "./message.js";
import {
    createBridge,
    createInternal,
    createLoginState,
    createPanel,
    resolveAssignPolicy,
} from "./utils/assembly.js";
import { buildDriverEvents } from "./utils/driver-events.js";
import { evaluateIdentity, rejectIdentityMismatch } from "./utils/identity.js";
import { applySessionFields } from "./utils/session.js";
import {
    type RawFriend,
    type RawGroup,
    toDirectChannel,
    toFriendList,
    toGuildList,
    toTextChannel,
    toUserFields,
} from "./utils/transform.js";

/** Bot 基类约束的上下文类型（satorijs Context；见文件头「Context 来源」）。 */
type SatoriContext = Bot["ctx"];

/** logLevel 配置 → reggol 数字（reggol：DEBUG=3 / INFO=2 / ERROR=1 / SILENT=0）。 */
const LOG_LEVEL_MAP: Record<LogLevel, number> = {
    debug: 3,
    info: 2,
    error: 1,
    silent: 0,
};

/** NapukettoQQ 的 koishi Bot（平台 "onebot"）。
 *
 * ⚠️ 不带泛型 C（2026-08-08 修复）：`C extends Context` 泛型在
 * exactOptionalPropertyTypes 下触发 koishi Context 与 satorijs/cordis Context 的
 * 逆变不兼容（Database/C[unique symbol] 泛型），VS Code TS server 报 TS2344。
 * 显式用 satorijs Context（Bot["ctx"]，约束正主）即可（运行时仍是 koishi.Context）。
 */
export class NapukettoBot extends Bot<SatoriContext, NapukettoBotConfig> {
    // koishi 基类 static 类型用 satorijs Bot<cordis.Context>，与 koishi Bot<koishi.Context>
    // 逆变不兼容（napcat 用 eslint 宽松，我们 cast 豁免——运行时是真实 encoder 类）。
    // bot 参数 unknown + 返回 never 泛型：构造签名与基类 static 兼容且不损失运行时行为。
    static override MessageEncoder = NapukettoMessageEncoder as unknown as new (
        bot: unknown,
        channelId: string,
        referrer?: unknown,
        options?: unknown,
    ) => MessageEncoder<never, never>;

    /** 业务 IPC 客户端引用，仅在 driver ready 且账号校验通过后绑定。 */
    private readonly clientRef: { current: NapukettoIpcClient | null } = { current: null };
    /** 一次性强制扫码标记：面板请求扫码重启时置 true → 下次 spawn
     * 消费（launch 读后清零，NAPUKETTO_QR_ONLY=1 → 子进程跳过快速登录直接出码）。 */
    private readonly qrOnlyRef = { current: false };
    /** 控制台登录面板（console 服务就绪后装配；自 bot.ts 拆出，login-panel.ts）。 */
    private readonly panel: NapukettoLoginPanel;
    /** 当前轮次的 driver；每次 start 新建，stop 立即解除引用。 */
    private driver: NapukettoDriver | null = null;
    /** 进行中的停止任务：重复 stop 串联等待，start 也等待它结束。 */
    private stopTask: Promise<void> | null = null;
    /** 启动轮次号：每创建一个 driver 递增，用于丢弃上一轮 driver 的迟到回调。 */
    private round = 0;
    /** 停止请求序号：让进行中的 start 在 stop 之后放弃创建新 driver。 */
    private stopEpoch = 0;
    private readonly login: NapukettoLoginState;
    private readonly bridge: NapukettoEventBridge;
    private readonly dataRoot: string;
    /** 数据库操作集中管理（docs/internals/bot.md）：dispatch 前原子预热 channel/user。 */
    private readonly database: NapukettoDatabase;
    /** autoAssign 语义（构造时解析一次；koishi 默认 true）。 */
    private readonly autoAssign: boolean;
    /** autoAuthorize 语义（构造时解析一次；koishi 默认 1，0 = 不落库）。 */
    private readonly autoAuthorize: number;
    /** 账号不一致（配置 selfId ≠ 实际登录 uin）：拒绝上线并拒绝派发，见 checkIdentity。 */
    private identityMismatch = false;

    constructor(ctx: SatoriContext, config: NapukettoBotConfig) {
        super(ctx, config, "onebot");
        this.dataRoot = resolveDataRoot(config.dataDir);
        // 日志等级（用户可配，默认 debug——多点日志便于排查；reggol setter 按名字
        // 写全局 Logger.levels，只影响 napuketto 及其子 namespace）
        this.logger.level = LOG_LEVEL_MAP[config.logLevel ?? "debug"];
        // selfId setter 写 user.id（satorijs defineAccessor），sid 立即可用
        this.selfId = config.selfId;
        this.user ??= {} as Universal.User;
        this.user.avatar = `http://q.qlogo.cn/headimg_dl?dst_uin=${config.selfId}&spec=640`;

        this.login = createLoginState({
            logger: this.logger,
            // 回调运行时才触发，constructor 已保证 this.user 非空
            getUser: () => {
                this.user ??= {} as Universal.User;
                return this.user;
            },
            getPanel: () => this.panel,
        });
        // 控制台登录面板（login-panel.ts 独立类：装配/reload 去重/连接回放/
        // 指令上行全封装；deps 只暴露 selfId + 快照 + IPC 能力，bot 不碰细节）
        this.panel = createPanel({
            selfId: this.config.selfId,
            logger: this.logger,
            getLogin: () => this.login,
            // 登录指令在业务就绪前就要发给正在引导的子进程。
            getClient: () => this.driver?.currentClient ?? null,
            forceQr: this.qrOnlyRef,
        });
        // satorijs Context → koishi Context cast——运行时同一实例，仅类型收窄
        this.panel.setup(this.ctx as unknown as KoishiContext);

        // 数据库操作集中管理（docs/internals/bot.md）：dispatch 前原子预热 channel/user，
        // 消除 koishi get-or-create 并发撞唯一键（channel 与 binding 同源，issue
        // #1545）。autoAssign/autoAuthorize 构造时解析一次（assembly.ts 纯函数）。
        const { autoAssign, autoAuthorize } = resolveAssignPolicy(
            this.ctx as unknown as KoishiContext,
        );
        this.autoAssign = autoAssign;
        this.autoAuthorize = autoAuthorize;
        this.database = new NapukettoDatabase(this.ctx as unknown as KoishiContext);

        // 事件桥（构造时装配一次；dispatch/selfId 无状态转发，driver 重启不影响）
        this.bridge = createBridge({
            logger: this.logger,
            getLogin: () => this.login,
            config: this.config,
            dataRoot: this.dataRoot,
            dispatchSession: (session) => this.dispatchSession(session),
        });

        // 动作桥：request 绑定 clientRef（client null 时抛错，driver 就绪后可用）
        this.internal = createInternal({
            config: this.config,
            getClient: () => this.clientRef.current,
            getSelfIdentity: () => this.login.snapshot.self,
            // 远程媒体下载失败等告警日志
            logger: {
                warn: (message: string) => {
                    this.logger.warn("[napuketto] %s", message);
                },
            },
        });
    }

    /**
     * 启动：为本次启动创建全新的 driver（子进程引导 + 登录 + session READY）。
     *
     * 每次 start 都是一个独立轮次：即使上一轮正常 stop 后 driver 停在 stopped，
     * Bot 也不再复用它，而是创建新实例；旧 driver 的迟到回调必须被丢弃
     * （见 round/isCurrent）。与 stop 重叠时先等上一轮确认退出，沿用同账号
     * 数据目录的宿主退出保护。
     */
    override async start(): Promise<void> {
        if (this.isActive) {
            return;
        }
        const startRound = this.round;
        const startEpoch = this.stopEpoch;
        const superseded = () => startRound !== this.round || startEpoch !== this.stopEpoch;
        this.status = BOT_STATUS.CONNECT;
        // 上一轮的登录、账号闸门与动作客户端都要在 spawn 前复位；否则错账号
        // 留下的 identityMismatch 会让新一轮即使登录正确也永远拒绝上线。
        this.resetSessionState();

        const stopping = this.stopTask;
        if (stopping !== null) {
            await stopping;
            if (superseded()) {
                return; // 等待期间被新的 stop/start 取代
            }
        }
        const previous = this.driver;
        this.driver = null;
        if (previous !== null) {
            // 防御：driver 可能在离线状态下仍在退避重试（Bot.status 已 OFFLINE）。
            // 先停止并确认退出，避免同一账号数据目录被两个宿主同时占用。
            await previous.stop();
            if (superseded()) {
                return;
            }
        }
        // 等待旧宿主期间可能已经被 super.stop() 置为 OFFLINE，这里重新进入 CONNECT。
        this.status = BOT_STATUS.CONNECT;
        try {
            // 真正创建 driver 时才递增轮次：等待期间的 stop 不会让本轮旧 driver
            // 的 onExit/onError 被误判为过期。
            const round = ++this.round;
            const driver = this.createDriver(round);
            this.driver = driver;
            driver.start();
        } catch (error) {
            this.offline(error instanceof Error ? error : new Error(String(error)));
        }
    }

    /**
     * 停止：停 driver（子进程优雅退出）→ 基类 offline。
     *
     * 立即递增停止序号并解除 driver 引用：进行中的 start 会在下一个等待点
     * 放弃创建 driver。这里不递增启动轮次，本轮 driver 的 onExit/onError 仍按
     * 原有停止语义处理（登录归 idle、EXIT_TIMEOUT 照常上报）；只有新的 start
     * 才递增轮次并让旧 driver 的迟到回调失效。driver.stop() 保留既有的 5s
     * 分级终止与确认退出语义，本方法不额外缩短或放宽。
     */
    override async stop(): Promise<void> {
        this.stopEpoch++;
        this.clientRef.current = null;
        const driver = this.driver;
        this.driver = null;
        const previous = this.stopTask;
        const task = (async () => {
            await Promise.all([previous ?? Promise.resolve(), driver?.stop(), super.stop()]);
        })();
        this.stopTask = task;
        try {
            await task;
        } finally {
            if (this.stopTask === task) {
                this.stopTask = null;
            }
        }
    }

    // ── koishi 动作方法（走 internal → IPC action → kernel API） ──

    /** 私聊频道（napcat 同款）。 */
    override async createDirectChannel(userId: string): Promise<Universal.Channel> {
        return toDirectChannel(userId);
    }

    /** 消息历史 → koishi MessageList 形状 { data, next }。 */
    override async getMessageList(
        channelId: string,
        next?: string,
        direction?: Universal.Direction,
        limit?: number,
        order?: Universal.Order,
    ): Promise<Universal.BidiList<Universal.Message>> {
        return this.internal.getMessageList(channelId, next, limit, direction, order);
    }

    /** 撤回消息。 */
    override async deleteMessage(_channelId: string, messageId: string): Promise<void> {
        await this.internal.deleteMessage(_channelId, messageId);
    }

    override async handleFriendRequest(
        messageId: string,
        approve: boolean,
        comment?: string,
    ): Promise<void> {
        await this.internal.handleFriendRequest(messageId, approve, comment);
    }

    override async handleGuildMemberRequest(
        messageId: string,
        approve: boolean,
        comment?: string,
    ): Promise<void> {
        await this.internal.handleGuildMemberRequest(messageId, approve, comment);
    }

    override async getUser(userId: string, guildId?: string): Promise<Universal.User> {
        return this.internal.getUser(userId, guildId);
    }

    override async getGuildMember(guildId: string, userId: string): Promise<Universal.GuildMember> {
        return this.internal.getGuildMember(guildId, userId);
    }

    override async getGuildMemberList(
        guildId: string,
        next?: string,
    ): Promise<Universal.List<Universal.GuildMember>> {
        return this.internal.getGuildMemberList(guildId, next);
    }

    override async kickGuildMember(
        guildId: string,
        userId: string,
        permanent?: boolean,
    ): Promise<void> {
        await this.internal.kickGuildMember(guildId, userId, permanent);
    }

    override async muteGuildMember(
        guildId: string,
        userId: string,
        duration: number,
        _reason?: string,
    ): Promise<void> {
        await this.internal.muteGuildMember(guildId, userId, duration);
    }

    /** 登录信息（优先本地登录快照 self；缺省走 IPC login.getSelf 兜底）。 */
    override async getLogin(): Promise<Universal.Login> {
        // 登录成功时 kernel 已推送 selfInfo（sendLogin logged_in → snapshot.self），
        // 直接本地取，无需 IPC 往返（IPC getSelf 在动作表合并前会报未知动作，
        // 2026-08-14 实测「拉取登录信息失败: 未知动作: login.getSelf」）。
        const self = this.login.snapshot.self;
        if (self !== undefined) {
            this.syncUser({ uin: self.uin, nick: self.nick });
            this.selfId = self.uin;
            return this.toJSON();
        }
        // 兜底：IPC login.getSelf（子进程动作表已合并时可用）
        const data = (await this.internal.getSelf()) as
            | { uin?: string; nickname?: string }
            | undefined;
        if (data !== undefined && data !== null) {
            if (typeof data.uin === "string" && data.uin !== "") {
                this.selfId = data.uin;
            }
            this.syncUser({ uin: data.uin, nick: data.nickname });
        }
        return this.toJSON();
    }

    /** 同步 user 字段（selfId 可能为空的场景下保留既有值；transform.ts 纯函数）。 */
    private syncUser(partial: { uin?: string | undefined; nick?: string | undefined }): void {
        this.user ??= {} as Universal.User;
        Object.assign(this.user, toUserFields(partial));
    }

    /**
     * 订阅原始 OB11 事件（docs/internals/actions.md）：子进程 OB11 动作桥透出的
     * OneBot 11 格式事件（post_type = message/notice/request/meta_event），
     * 原始订阅独立于 Koishi Session 派发。ob11Actions=false 或子进程降级时无事件到来。
     */
    onOb11(listener: (event: Ob11EventPayload) => void): () => void {
        return this.bridge.onOb11(listener);
    }

    /** 好友列表（kernel Friend { uin, nickname } → Universal.Friend）。 */
    override async getFriendList(): Promise<Universal.List<Universal.Friend>> {
        return toFriendList((await this.internal.getFriendList()) as RawFriend[] | undefined);
    }

    /** 群列表（kernel Group { groupCode, groupName } → Universal.Guild）。 */
    override async getGuildList(): Promise<Universal.List<Universal.Guild>> {
        return toGuildList((await this.internal.getGroupList()) as RawGroup[] | undefined);
    }

    /** 群详情（群列表里找）。 */
    override async getGuild(guildId: string): Promise<Universal.Guild> {
        const guilds = await this.getGuildList();
        const guild = guilds.data.find((item) => item.id === guildId);
        if (guild === undefined) {
            throw new IpcError(`群不存在: ${guildId}`, "NOT_FOUND");
        }
        return guild;
    }

    /** 频道（私聊 DIRECT / 群 TEXT）。 */
    override async getChannel(channelId: string): Promise<Universal.Channel> {
        if (channelId.startsWith(PRIVATE_PREFIX)) {
            const userId = channelId.slice(PRIVATE_PREFIX.length);
            return toDirectChannel(userId);
        }
        const guild = await this.getGuild(channelId);
        return toTextChannel(channelId, guild.name);
    }

    override async getChannelList(
        guildId: string,
        next?: string,
    ): Promise<Universal.List<Universal.Channel>> {
        requireFirstPage(next);
        const guild = await this.getGuild(guildId);
        return { data: [toTextChannel(guild.id, guild.name)] };
    }

    // ── 内部 ──

    /**
     * 新一轮启动前复位会话状态。
     *
     * 上一轮可能因账号不一致、崩溃或正常 stop 结束：clientRef 可能仍指向旧
     * client，identityMismatch 会阻断 dispatch，登录快照会残留旧账号信息。
     * 三者都必须清掉，新一轮的 ready 才能重新走 online/派发。
     */
    private resetSessionState(): void {
        this.clientRef.current = null;
        this.identityMismatch = false;
        this.login.reset();
    }

    /** 为指定轮次创建 driver（launch 工厂组装 launchSelfHost，events 接线走 driver-events.ts）。 */
    private createDriver(round: number): NapukettoDriver {
        return new NapukettoDriver({
            accountDir: join(this.dataRoot, this.config.selfId),
            // launch 工厂：logger 接线 onStage（下载/解包/win-node/启动阶段日志，
            // 2026-08-23 起——此前首次下载 313MB 全程静默，用户以为流程没生效）
            launch: buildLaunch(
                { ...this.config, dataDir: this.dataRoot },
                {
                    onStage: (message) => {
                        this.logger.info("[napuketto] %s", message);
                    },
                    // 一次性强制扫码标记（面板「扫码登录」；spawn 时消费清零）
                    forceQr: this.qrOnlyRef,
                },
            ),
            // 事件接线（driver-events.ts 工厂：logger/login/bridge/offline 依赖注入）
            events: buildDriverEvents({
                logger: this.logger,
                login: this.login,
                bridge: this.bridge,
                // 账号不一致也算「主动断开」：子进程退出时不再覆盖 checkIdentity 设的错误
                isDisconnected: () =>
                    this.status === BOT_STATUS.DISCONNECT || this.identityMismatch,
                handleReady: () => this.handleReady(),
                clearClient: () => {
                    this.clientRef.current = null;
                },
                // 软重登换账号检测（2026-09-08）：logged_in 登录消息补位校验
                onLoggedIn: (self) => this.handleLoggedIn(self),
                offline: (error) => {
                    this.offline(error);
                },
                // 旧 driver 在 stop 完成边界上的迟到回调不得改写新一轮状态
                isCurrent: () => round === this.round,
            }),
            // exactOptionalPropertyTypes：可选字段条件展开，不显式赋 undefined
            ...(this.config.restart !== undefined ? { restart: this.config.restart } : {}),
            ...(this.config.heartbeatTimeoutMs !== undefined
                ? { heartbeatTimeoutMs: this.config.heartbeatTimeoutMs }
                : {}),
            // IPC 脏行诊断（2026-09-06）：子进程 stdout 被并发输出撕裂/原生 printf
            // 污染时留痕，不再静默丢弃（撕裂的可能是 ready 等关键 status）
            onJunkLine: (line) => {
                this.logger.debug(
                    "[napuketto] IPC 收到无法解析的行（可能被并发输出撕裂）: %s",
                    line.slice(0, 200),
                );
            },
        });
    }

    /** driver ready：登录状态就绪 + 校验账号 + 绑定客户端 + online。 */
    private handleReady(): void {
        this.login.onReady();
        // ⚠️ 账号一致性校验必须在 online 之前（见 checkIdentity）：不一致时
        // 一条消息都不能派发，否则 koishi 会按错账号落库 assignee/binding。
        if (!this.checkIdentity()) {
            return;
        }
        const driver = this.driver;
        const client = driver?.currentState === "ready" ? driver.currentClient : null;
        if (client === null) {
            return;
        }
        this.clientRef.current = client;
        this.online();
        void this.getLogin().catch((error) => {
            this.logger.warn("[napuketto] 拉取登录信息失败: %o", error);
        });
    }

    /**
     * 账号一致性校验：实际登录 uin 必须等于配置 selfId，否则拒绝上线。
     *
     * ⚠️ 2026-08-20 生产事故根治。子进程登录走「quickUin 快速登录 → QR 回退」，
     * QR 谁扫谁就是登录账号——与配置 selfId 无关。两者不一致时后果隐蔽且严重：
     *  ① 数据目录按配置 selfId 命名（launch.ts cfgDir），另一账号的 QQ 数据会
     *     写进这个目录（两个账号共用一个数据目录）；
     *  ② koishi 侧 session.selfId / channel.assignee / binding 全按**实际** uin
     *     落库。事后换回正确账号后，koishi 的受理人闸门（@koishijs/core
     *     middleware：`channel.assignee !== session.selfId` 直接 return，无日志
     *     无报错）会把这些频道的**所有群消息静默丢弃**——表现为「事件收到、
     *     dispatch 有日志、指令零响应」，且 assignee 不会被自动修复（行已存在，
     *     autoAssign 只在缺行时生效），极难排查。
     * 因此这里不静默采用实际 uin，而是拒绝上线 + 给出可操作提示。
     */
    private checkIdentity(): boolean {
        const decision = evaluateIdentity(this.config.selfId, this.login.snapshot.self?.uin);
        if (decision.kind === "allow") {
            return true;
        }
        // 拒绝动作抽 identity.ts（单测可测，2026-09-10）：真实接线在此注入
        rejectIdentityMismatch(decision, {
            onError: (message, ...args) => {
                this.logger.error(message, ...args);
            },
            setMismatch: () => {
                this.identityMismatch = true;
                this.clientRef.current = null;
            },
            stopDriver: () => {
                void this.driver?.stop();
            },
            offline: (error) => {
                this.offline(error);
            },
        });
        return false;
    }

    /**
     * logged_in 登录消息补位校验（2026-09-08 软重登）：driver 的 ready 幂等
     * 守卫下软重登完成后 onReady 不会重触发，账号一致性校验需在登录消息面
     * 补位——软重登换账号在此拒绝上线（期望行为）；同账号通过则同步 user
     * 信息（昵称可能刷新）。初次引导也经此先于 ready 校验一次（幂等）。
     */
    private handleLoggedIn(self: NonNullable<IpcLoginPayload["selfInfo"]>): void {
        if (!this.checkIdentity()) {
            return;
        }
        this.syncUser({ uin: self.uin, nick: self.nick });
    }

    /** kernel 事件 session 字段 → koishi session → dispatch。 */
    private async dispatchSession(fields: NapukettoSessionFields): Promise<void> {
        const client = this.clientRef.current;
        // 账号不一致：拒绝派发（落库会把 assignee/binding 写成错账号，见 checkIdentity）
        if (client === null || this.identityMismatch) {
            return;
        }
        // 原子预热 channel/user（docs/internals/bot.md，2026-08-09 并发竞态修复）：
        // 预热后 koishi SELECT 必命中，永远走不到 get-or-create 的并发 INSERT
        //（根因 koishijs/koishi#1545）。预热失败不阻断派发（框架兜底）。
        if (fields.type === "message") {
            await this.preheat(fields);
        }
        if (this.clientRef.current !== client) {
            return; // 预热期间子进程已退出或被替换
        }
        const session = this.session({
            type: fields.type,
            // exactOptionalPropertyTypes：可选字段条件展开，不显式赋 undefined
            ...(fields.subtype !== undefined ? { subtype: fields.subtype } : {}),
            selfId: fields.selfId,
            platform: fields.platform,
            timestamp: fields.timestamp,
            ...(fields.member === undefined ? {} : { member: fields.member }),
        });
        // 可选字段赋值 + elements 特殊处理（content 由 satorijs getter 派生）——
        // 抽到 session.ts 纯函数（可单测，exactOptionalPropertyTypes 条件展开）
        applySessionFields(session, fields);
        // 消息路径关键日志（info，默认可见）：session 字段 + 渲染后文本
        this.logger.info(
            "[napuketto] dispatch: type=%s self=%s channel=%s user=%s isDirect=%s msg=%s",
            fields.type,
            fields.selfId,
            fields.channelId ?? "?",
            fields.userId ?? "?",
            fields.isDirect,
            fields.type === "message" ? (fields.elements?.join("") ?? "") : "",
        );
        this.dispatch(session);
    }

    /**
     * 原子预热 channel/user（dispatch 前）。
     *
     * ⚠️ channel（2026-08-09）：koishi getChannel 是 check-then-act（SELECT →
     * 未命中 INSERT），多条消息同 tick dispatch 时并发撞 (id, platform) 唯一键
     *（实测同批 4 条 → 1 成功 + 3 次 UNIQUE constraint failed；框架侧根因
     * koishijs/koishi#1545）。autoAssign=false 保持 koishi 不落库语义。
     * ⚠️ user：session.getUser 同样 check-then-act，未命中 createUser →
     * create('binding') 撞 (pid, platform) 主键（issue #1545 user 侧）。
     * userId 缺省（如系统事件）跳过；autoAuthorize=0 时 koishi 不落库。
     */
    private async preheat(fields: NapukettoSessionFields): Promise<void> {
        if (this.autoAssign && fields.channelId !== undefined) {
            await this.database.ensureChannel({
                platform: fields.platform,
                id: fields.channelId,
                ...(fields.guildId !== undefined ? { guildId: fields.guildId } : {}),
                // assignee 仅非空 selfId（koishi autoAssign 语义：空串不落库）
                ...(fields.selfId !== "" ? { assignee: fields.selfId } : {}),
            });
        }
        if (fields.userId !== undefined && fields.userId !== "") {
            await this.database.ensureUser({
                platform: fields.platform,
                userId: fields.userId,
                authority: this.autoAuthorize,
            });
        }
    }
}

/** 平台配置 schema（koishi bots 配置校验，napcat 同构 namespace 合并）。 */
export namespace NapukettoBot {
    export const Config = napukettoConfigSchema;
    export type Config = NapukettoBotConfig;

    // ⚠️ 声明服务依赖（2026-08-09 database / 2026-08-14 console）：
    // Bot 子类插件（export default）的模块级导出会被 loader unwrapExports 丢弃，
    // inject 必须挂类上——与 Config/usage 同源（namespace 合并编译成静态属性，
    // 运行时等价 static）。两个都是**可选增强**（放 optional 而非 required：
    // required 会强制用户安装对应插件，破坏「没装也能跑」）——
    // database：预热 channel/user 消除 koishi get-or-create 并发竞态（没装数据库
    // 插件也能跑，只是不预热，koishi 兜底）；console：控制台登录面板（没装
    // 控制台没面板，登录走二维码文件/日志）。cordis 对未声明 inject 的服务访问
    // emit internal/warning（实测每条消息刷 `property database is not
    // registered`），optional 声明让 internal/inject 检查放行，消除刷屏；
    // 配合 NapukettoDatabase 内部收 root ctx 双保险（docs/internals/bot.md）。
    // ⚠️ 不写 export const name：namespace 合并编译成 `NapukettoBot.name = ...`
    // 赋值语句，而 Function.name 是 writable:false——ESM 严格模式下加载即抛
    // TypeError（2026-08-14 实证）。Bot 子类插件名由 package.json 决定，无需静态。
    export const inject = {
        optional: ["database", "console"],
    };

    /**
     * 控制台插件详情页 usage（2026-08-14 根因修复）。
     *
     * ⚠️ 必须挂到类上（namespace 声明合并 → 静态属性），不能放在 index.ts 的
     * 模块级导出：koishi loader 的 `unwrapExports = module?.default || module`
     * 会把 `export default NapukettoBot` 解包成类本身，丢弃模块级 `usage`/`name`
     * 导出 → 控制台 `PackageProvider.parseExports` 读 `exports?.usage` 恒
     * undefined → 插件详情页不显示「本插件提供了…」说明。bilibili-dm 没有
     * default export（apply 函数插件），module 整体返回，usage 才保留。
     */
    export const usage = `
<div style="border-radius: 10px; border: 1px solid #ddd; padding: 16px; margin-bottom: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
  <h2 style="margin-top: 0; color: #4a6ee0;">🖥️ NapukettoQQ 适配器</h2>
  <p>自研 QQ NT <strong>wrapper.node</strong> 协议层，无需外部协议端。</p>
  <p>每个 <code>bots</code> 配置项启动一个自建宿主子进程，经 IPC 与 Koishi 通信。
  Windows 使用 QQNT.dll stub，Linux / WSL 使用 Linux 版 QQ、ELF stub 与 libgnutls.so.30。
  Wine 已退役。配置 <code>selfId</code> 为登录 QQ 号即可。
  登录二维码在插件详情页实时展示（控制台安装后可见）。</p>
</div>
`;
}
