import { resolveDataRoot } from "@napuketto/kernel";
import { Bot, type Context as KoishiContext, type MessageEncoder, type Universal } from "koishi";
import { parseChannelId } from "../bridge/actions/codecs.js";
import { requireFirstPage } from "../bridge/actions/ob11-resources.js";
import type { NapukettoEventBridge } from "../bridge/events/bridge.js";
import type { Ob11EventPayload } from "../bridge/events/types.js";
import { type LogLevel, type NapukettoBotConfig, napukettoConfigSchema } from "../config.js";
import type { NapukettoLoginState } from "../console/login-state.js";
import type { NapukettoLoginPanel } from "../console/panel.js";
import { DEFAULT_LOG_LEVEL, IpcError, PRIVATE_PREFIX, requireSelfId } from "../shared.js";
import {
    createBridge,
    createDispatcher,
    createInternal,
    createLifecycle,
    createLoginState,
    createPanel,
} from "./assembly.js";
import type { BotLifecycleController } from "./lifecycle.js";
import { NapukettoMessageEncoder } from "./message.js";
import {
    resolveBotLogin,
    toDirectChannel,
    toFriendList,
    toGuildList,
    toTextChannel,
} from "./transform.js";

/** logLevel 配置 → reggol 数字（reggol：DEBUG=3 / INFO=2 / ERROR=1 / SILENT=0）。 */
const LOG_LEVEL_MAP: Record<LogLevel, number> = {
    debug: 3,
    info: 2,
    error: 1,
    silent: 0,
};

const BOT_INJECT = { optional: ["database", "console"] };

function avatarUrl(selfId: string): string {
    const avatar = new URL("https://q.qlogo.cn/headimg_dl");
    avatar.searchParams.set("dst_uin", selfId);
    avatar.searchParams.set("spec", "640");
    return avatar.href;
}

// 使用 satorijs Context 满足 Bot 基类的约束。
type SatoriContext = Bot["ctx"];

export class NapukettoBot extends Bot<SatoriContext, NapukettoBotConfig> {
    static override MessageEncoder = NapukettoMessageEncoder as unknown as new (
        bot: unknown,
        channelId: string,
        referrer?: unknown,
        options?: unknown,
    ) => MessageEncoder<never, never>;

    private readonly panel: NapukettoLoginPanel;
    private readonly login: NapukettoLoginState;
    private readonly bridge: NapukettoEventBridge;
    private readonly lifecycle: BotLifecycleController;

    constructor(ctx: SatoriContext, config: NapukettoBotConfig) {
        const selfId = requireSelfId(config.selfId);
        super(ctx, config, "onebot");
        const dataRoot = resolveDataRoot(config.dataDir);
        const koishiCtx = this.ctx as unknown as KoishiContext;
        // reggol 按名称共享等级，账号需要独立的 logger 名称。
        const logger = ctx.logger(`${this.logger.name}-${selfId}`);
        this.logger = logger;
        logger.level = LOG_LEVEL_MAP[config.logLevel ?? DEFAULT_LOG_LEVEL];
        this.selfId = selfId;
        this.user ??= {} as Universal.User;
        this.user.avatar = avatarUrl(selfId);
        this.login = createLoginState({
            logger,
            getUser: () => (this.user ??= {} as Universal.User),
            getPanel: () => this.panel,
        });
        this.lifecycle = createLifecycle(this, dataRoot, {
            login: this.login,
            getBridge: () => this.bridge,
            stopBot: () => super.stop(),
        });
        this.panel = createPanel({
            selfId,
            logger,
            getLogin: () => this.login,
            getClient: () => this.lifecycle.loginClient,
            restart: (forceQr) => this.lifecycle.restartLogin(forceQr),
        });
        this.panel.setup(koishiCtx);
        const dispatcher = createDispatcher(koishiCtx, this, this.lifecycle);
        this.bridge = createBridge({
            logger,
            config: this.config,
            dataRoot,
            getLogin: () => this.login,
            dispatchSession: (session) => dispatcher.dispatch(session),
        });
        this.internal = createInternal({
            config: this.config,
            dataRoot,
            getClient: () => this.lifecycle.client,
            getSelfIdentity: () => this.login.snapshot.self,
            logger: { warn: (message) => logger.warn("[napuketto] %s", message) },
        });
    }

    override start(): Promise<void> {
        return this.lifecycle.start();
    }

    override stop(): Promise<void> {
        return this.lifecycle.stop();
    }

    override async createDirectChannel(userId: string): Promise<Universal.Channel> {
        return toDirectChannel(userId);
    }

    override async getMessageList(
        channelId: string,
        next?: string,
        direction?: Universal.Direction,
        limit?: number,
        order?: Universal.Order,
    ): Promise<Universal.BidiList<Universal.Message>> {
        return this.internal.getMessageList(channelId, next, limit, direction, order);
    }

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

    override handleGuildRequest(
        messageId: string,
        approve: boolean,
        comment?: string,
    ): Promise<void> {
        return this.internal.handleGuildRequest(messageId, approve, comment);
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

    override getLogin(): Promise<Universal.Login> {
        const generation = this.lifecycle.loginGeneration;
        return resolveBotLogin(this, this.login.snapshot.self, () =>
            this.lifecycle.isLoginGeneration(generation),
        );
    }

    /** 订阅子进程转发的原始 OneBot 11 事件。 */
    onOb11(listener: (event: Ob11EventPayload) => void): () => void {
        return this.bridge.onOb11(listener);
    }

    override async getFriendList(): Promise<Universal.List<Universal.Friend>> {
        return toFriendList(await this.internal.getFriendList());
    }

    override async getGuildList(): Promise<Universal.List<Universal.Guild>> {
        return toGuildList(await this.internal.getGroupList());
    }

    override async getGuild(guildId: string): Promise<Universal.Guild> {
        const guilds = await this.getGuildList();
        const guild = guilds.data.find((item) => item.id === guildId);
        if (guild === undefined) {
            throw new IpcError(`群不存在: ${guildId}`, "NOT_FOUND");
        }
        return guild;
    }

    override async getChannel(channelId: string): Promise<Universal.Channel> {
        if (channelId.startsWith(PRIVATE_PREFIX)) {
            const { peerUin } = parseChannelId(channelId);
            return { ...toDirectChannel(peerUin), id: channelId };
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
}

export default NapukettoBot;

/** Koishi 解包默认导出后直接从 Bot 类读取插件元数据。 */
export namespace NapukettoBot {
    export const Config = napukettoConfigSchema;
    export type Config = NapukettoBotConfig;
    export const inject = BOT_INJECT;
}
