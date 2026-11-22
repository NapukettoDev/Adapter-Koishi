import { resolveDataRoot } from "@napuketto/kernel";
import { Bot, type Context as KoishiContext, type MessageEncoder, type Universal } from "koishi";
import { requireFirstPage } from "../actions/index.js";
import { type NapukettoBotConfig, napukettoConfigSchema } from "../config.js";
import type { NapukettoLoginPanel } from "../console/index.js";
import type { NapukettoEventBridge, Ob11EventPayload } from "../events/index.js";
import type { NapukettoLoginState } from "../login/index.js";
import { IpcError } from "../shared/errors.js";
import { PRIVATE_PREFIX, requireSelfId } from "../shared/protocol.js";
import {
    createBridge,
    createDispatcher,
    createInternal,
    createLifecycle,
    createLoginState,
    createPanel,
    resolveBotLogin,
} from "./assembly.js";
import type { BotLifecycleController } from "./lifecycle.js";
import { NapukettoMessageEncoder } from "./message.js";
import { avatarUrl, BOT_INJECT, BOT_USAGE, LOG_LEVEL_MAP } from "./metadata.js";
import {
    type RawFriend,
    type RawGroup,
    toDirectChannel,
    toFriendList,
    toGuildList,
    toTextChannel,
} from "./transform.js";

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
        logger.level = LOG_LEVEL_MAP[config.logLevel ?? "debug"];
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
        return resolveBotLogin(this, this.login.snapshot.self);
    }

    /** 订阅子进程转发的原始 OneBot 11 事件。 */
    onOb11(listener: (event: Ob11EventPayload) => void): () => void {
        return this.bridge.onOb11(listener);
    }

    override async getFriendList(): Promise<Universal.List<Universal.Friend>> {
        return toFriendList((await this.internal.getFriendList()) as RawFriend[] | undefined);
    }

    override async getGuildList(): Promise<Universal.List<Universal.Guild>> {
        return toGuildList((await this.internal.getGroupList()) as RawGroup[] | undefined);
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
}

export default NapukettoBot;

/** Koishi 解包默认导出后直接从 Bot 类读取插件元数据。 */
export namespace NapukettoBot {
    export const Config = napukettoConfigSchema;
    export type Config = NapukettoBotConfig;
    export const inject = BOT_INJECT;
    export const usage = BOT_USAGE;
}
