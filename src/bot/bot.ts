/**
 * bot.ts：NapukettoBot——koishi Bot 子类（design.md §5.11，端到端验证点）。
 *
 * 装配方式：不写 Adapter（fork/connect 为 HTTP/WS 网络服务设计）。koishi Bot
 * 构造自动注册 `ctx.on('ready', () => this.start())`——override start() spawn
 * driver（进程编排），stop() 停 driver。
 *
 * 链路：driver（子进程生命周期）→ IPC client → 事件桥（kernel 事件 → koishi
 * session，dispatch）+ 动作桥（NapukettoInternal，koishi 动作 → IPC action）。
 *
 * 运行时 import koishi（Bot/Universal 等）——本文件不进单测（HANDOVER §7 坑 1）。
 *
 * ⚠️ Context 来源（2026-08-08 修复）：Bot 基类（satorijs）的泛型约束是
 * satorijs/cordis 的 Context，而 koishi 的 Context（独立 interface，含
 * [minato.Types] 泛型）在 exactOptionalPropertyTypes 下不满足该约束（逆变
 * 不兼容，部分 TS 版本报 TS2344）。修复：用 `@satorijs/core` 的 Context
 * （约束正主）——运行时传入的仍是 koishi.Context（其子类），类型层面
 * 只按 Bot 基类能力使用，无需 koishi 特有 API。
 */

import type { Context } from "@satorijs/core";
import { Bot, type Context as KoishiContext, type MessageEncoder, type Universal } from "koishi";
import { type LogLevel, type NapukettoBotConfig, napukettoConfigSchema } from "../config.js";
import { BOT_STATUS, PRIVATE_PREFIX } from "../constants.js";
import { NapukettoDatabase } from "../database/index.js";
import { NapukettoDriver } from "../driver/index.js";
import type {
    NapukettoEventBridge,
    NapukettoSessionFields,
    Ob11EventPayload,
} from "../events/index.js";
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
 * 显式用 satorijs Context（Bot 约束正主）即可（运行时仍是 koishi.Context）。
 */
export class NapukettoBot extends Bot<Context, NapukettoBotConfig> {
    // koishi 基类 static 类型用 satorijs Bot<cordis.Context>，与 koishi Bot<koishi.Context>
    // 逆变不兼容（napcat 用 eslint 宽松，我们 cast 豁免——运行时是真实 encoder 类）。
    // bot 参数 unknown + 返回 never 泛型：构造签名与基类 static 兼容且不损失运行时行为。
    static override MessageEncoder = NapukettoMessageEncoder as unknown as new (
        bot: unknown,
        channelId: string,
        referrer?: unknown,
        options?: unknown,
    ) => MessageEncoder<never, never>;

    /** 当前 IPC 客户端引用（driver 重启后换实例，onReady 更新）。 */
    private readonly clientRef: { current: NapukettoIpcClient | null } = { current: null };
    /** 一次性强制扫码标记（2026-09-08）：面板「扫码登录」置 true → 下次 spawn
     * 消费（launch 读后清零，NAPUTO_QR_ONLY=1 → 子进程跳过快速登录直接出码）。 */
    private readonly qrOnlyRef = { current: false };
    /** 控制台登录面板（console 服务就绪后装配；自 bot.ts 拆出，login-panel.ts）。 */
    private readonly panel: NapukettoLoginPanel;
    private driver: NapukettoDriver | null = null;
    private readonly login: NapukettoLoginState;
    private readonly bridge: NapukettoEventBridge;
    /** 数据库操作集中管理（design.md §5.13）：dispatch 前原子预热 channel/user。 */
    private readonly database: NapukettoDatabase;
    /** autoAssign 语义（构造时解析一次；koishi 默认 true）。 */
    private readonly autoAssign: boolean;
    /** autoAuthorize 语义（构造时解析一次；koishi 默认 1，0 = 不落库）。 */
    private readonly autoAuthorize: number;
    /** 账号不一致（配置 selfId ≠ 实际登录 uin）：拒绝上线并拒绝派发，见 checkIdentity。 */
    private identityMismatch = false;

    constructor(ctx: Context, config: NapukettoBotConfig) {
        super(ctx, config, "onebot");
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
            getClient: () => this.clientRef.current,
            // 扫码登录（登录期外）：置一次性 qrOnly 标记 + control restart
            forceQrRestart: () => {
                this.qrOnlyRef.current = true;
                const client = this.clientRef.current;
                if (client === null) {
                    return false;
                }
                client.sendControl({ command: "restart" });
                return true;
            },
        });
        // satorijs Context → koishi Context cast——运行时同一实例，仅类型收窄
        this.panel.setup(this.ctx as unknown as KoishiContext);

        // 数据库操作集中管理（design.md §5.13）：dispatch 前原子预热 channel/user，
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
            dispatchSession: (session) => this.dispatchSession(session),
        });

        // 动作桥：request 绑定 clientRef（client null 时抛错，driver 就绪后可用）
        this.internal = createInternal({
            getClient: () => this.clientRef.current,
            // 远程媒体下载失败等告警日志
            logger: {
                warn: (message: string) => {
                    this.logger.warn("[napuketto] %s", message);
                },
            },
        });
    }

    /** 启动：spawn driver（子进程引导 + 登录 + session READY）。 */
    override async start(): Promise<void> {
        if (this.isActive) {
            return;
        }
        this.status = BOT_STATUS.CONNECT;
        try {
            this.setupDriver();
            this.driver?.start();
        } catch (error) {
            this.offline(error instanceof Error ? error : new Error(String(error)));
        }
    }

    /** 停止：停 driver（子进程优雅退出）→ 基类 offline。 */
    override async stop(): Promise<void> {
        this.driver?.stop();
        await super.stop();
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
        _direction?: Universal.Direction,
        limit?: number,
    ): Promise<Universal.BidiList<Universal.Message>> {
        const list = await this.internal.getMessageList(channelId, next, limit);
        return {
            data: list.data as Universal.Message[],
            ...(list.next !== undefined ? { next: list.next } : {}),
        };
    }

    /** 撤回消息。 */
    override async deleteMessage(_channelId: string, messageId: string): Promise<void> {
        await this.internal.deleteMessage(_channelId, messageId);
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
     * 订阅原始 OB11 事件（design.md §5.14）：子进程 OB11 动作桥透出的
     * OneBot 11 格式事件（post_type = message/notice/request/meta_event），
     * 不经 koishi session 翻译。ob11Actions=false 或子进程降级时无事件到来。
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
            throw new Error(`群不存在: ${guildId}`);
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

    // ── 内部 ──

    /** 创建 driver（launch 工厂组装 launchSelfHost，events 接线走 driver-events.ts）。 */
    private setupDriver(): void {
        if (this.driver !== null) {
            return;
        }
        const driver = new NapukettoDriver({
            // launch 工厂：logger 接线 onStage（下载/解包/win-node/启动阶段日志，
            // 2026-08-23 起——此前首次下载 313MB 全程静默，用户以为流程没生效）
            launch: buildLaunch(this.config, {
                onStage: (message) => {
                    this.logger.info("[napuketto] %s", message);
                },
                // 一次性强制扫码标记（面板「扫码登录」；spawn 时消费清零）
                forceQr: this.qrOnlyRef,
            }),
            // 事件接线（driver-events.ts 工厂：logger/login/bridge/offline 依赖注入）
            events: buildDriverEvents({
                logger: this.logger,
                login: this.login,
                bridge: this.bridge,
                // 账号不一致也算「主动断开」：子进程退出时不再覆盖 checkIdentity 设的错误
                isDisconnected: () =>
                    this.status === BOT_STATUS.DISCONNECT || this.identityMismatch,
                handleReady: () => this.handleReady(),
                // 软重登换账号检测（2026-09-08）：logged_in 登录消息补位校验
                onLoggedIn: (self) => this.handleLoggedIn(self),
                offline: (error) => {
                    this.offline(error);
                },
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
        this.driver = driver;
    }

    /** driver ready：clientRef 更新 + 登录状态就绪 + online + 拉登录信息。 */
    private handleReady(): void {
        const client = this.driver?.currentClient;
        if (client !== null && client !== undefined) {
            this.clientRef.current = client;
        }
        this.login.onReady();
        // ⚠️ 账号一致性校验必须在 online 之前（见 checkIdentity）：不一致时
        // 一条消息都不能派发，否则 koishi 会按错账号落库 assignee/binding。
        if (!this.checkIdentity()) {
            return;
        }
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
            },
            stopDriver: () => {
                this.driver?.stop();
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
        // 账号不一致：拒绝派发（落库会把 assignee/binding 写成错账号，见 checkIdentity）
        if (this.identityMismatch) {
            return;
        }
        // 原子预热 channel/user（design.md §5.13，2026-08-09 并发竞态修复）：
        // 预热后 koishi SELECT 必命中，永远走不到 get-or-create 的并发 INSERT
        //（根因 koishijs/koishi#1545）。预热失败不阻断派发（框架兜底）。
        await this.preheat(fields);
        const session = this.session({
            type: fields.type,
            // exactOptionalPropertyTypes：可选字段条件展开，不显式赋 undefined
            ...(fields.subtype !== undefined ? { subtype: fields.subtype } : {}),
            selfId: fields.selfId,
            platform: fields.platform,
            timestamp: fields.timestamp,
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
            fields.elements?.join("") ?? "",
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
    // 配合 NapukettoDatabase 内部收 root ctx 双保险（design.md §5.13）。
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
  <p>每个 <code>bots</code> 配置项启动一个自建宿主子进程（dlopen wrapper.node + stub
  QQNT.dll），经 IPC 与 koishi 通信。配置 <code>selfId</code> 为登录 QQ 号即可；
  登录二维码在插件详情页实时展示（控制台安装后可见）。</p>
</div>
`;
}
