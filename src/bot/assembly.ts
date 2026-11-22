/** 创建 Bot 使用的登录、控制台、驱动和消息桥组件。 */
import { join } from "node:path";
import {
    type Bot,
    type Context as KoishiContext,
    h as koishiH,
    type Logger,
    type Universal,
} from "koishi";
import { NapukettoInternal } from "../actions/index.js";
import type { NapukettoInternalOptions } from "../actions/types.js";
import type { NapukettoBotConfig } from "../config.js";
import { type LoginPanelDeps, NapukettoLoginPanel } from "../console/index.js";
import { NapukettoDatabase } from "../database/index.js";
import { NapukettoDriver } from "../driver/index.js";
import type { DriverEvents } from "../driver/types.js";
import {
    enrichReceiveVoice,
    NapukettoEventBridge,
    type NapukettoSessionFields,
} from "../events/index.js";
import type { NapukettoIpcClient } from "../ipc/index.js";
import { type LoginSnapshot, NapukettoLoginState } from "../login/index.js";
import { IpcError } from "../shared/errors.js";
import { bindKoishiH, requireSelfId } from "../shared/protocol.js";
import { SessionDispatcher } from "./dispatcher.js";
import { buildLaunch } from "./launch.js";
import { BotLifecycleController } from "./lifecycle.js";
import { toUserFields } from "./transform.js";

/** 登录状态机装配依赖。 */
export interface LoginStateHost {
    /** 日志对象。 */
    logger: Logger;
    /** 可写 user 引用（状态变化时同步 id/name）。 */
    getUser: () => Universal.User;
    /** 控制台面板引用（运行时求值——login 先于 panel 创建）。 */
    getPanel: () => NapukettoLoginPanel;
}

/** 装配登录状态机：状态变化 → user 同步 + 控制台面板推送。 */
export function createLoginState(host: LoginStateHost): NapukettoLoginState {
    return new NapukettoLoginState({
        onStateChange: (state, self) => {
            if (self !== undefined) {
                Object.assign(host.getUser(), toUserFields({ uin: self.uin, nick: self.nick }));
            }
            host.logger.debug("[napuketto] 登录状态: %s", state);
            host.getPanel().push();
        },
        onQrChange: (_qr) => {
            host.logger.debug("[napuketto] 二维码更新");
            host.getPanel().push();
        },
        onError: (error) => {
            host.logger.warn("[napuketto] 登录错误: %o", error);
            host.getPanel().push();
        },
    });
}

/** 面板装配依赖。 */
export interface PanelHost {
    /** 登录账号（QQ 号，serviceId 隔离）。 */
    selfId: string;
    /** 日志对象。 */
    logger: Logger;
    /** 登录状态机引用（快照 getter 运行时求值——panel 晚于 login 创建）。 */
    getLogin: () => NapukettoLoginState;
    /** 取 driver 当前可用的 IPC 连接，含引导期。 */
    getClient: () => NapukettoIpcClient | null;
    /** 请求重启宿主，需要时为下次启动标记强制扫码。 */
    restart: LoginPanelDeps["restart"];
}

/** 装配控制台登录面板（login-panel.ts：装配/reload 去重/连接回放/指令上行）。 */
export function createPanel(host: PanelHost): NapukettoLoginPanel {
    const sendControl: LoginPanelDeps["sendControl"] = (payload) => {
        const client = host.getClient();
        if (client === null) {
            return false;
        }
        client.sendControl(payload);
        return true;
    };
    return new NapukettoLoginPanel({
        selfId: host.selfId,
        getSnapshot: () => host.getLogin().snapshot,
        sendControl,
        request: async (action, params) => {
            const client = host.getClient();
            if (client === null) {
                throw new IpcError("Napuketto 子进程未就绪（等待驱动连接）", "CLOSED");
            }
            return client.request(action, params);
        },
        restart: host.restart,
        logger: host.logger,
    });
}

/**
 * 解析 autoAssign/autoAuthorize 语义。
 *
 * koishi 的这两项配置支持 Computed 函数形式（per-session 计算）——构造阶段
 * 无 session 无法求值，取 Schema 默认值（autoAssign=true / autoAuthorize=1）。
 */
function resolveAssignPolicy(ctx: KoishiContext): {
    autoAssign: boolean;
    autoAuthorize: number;
} {
    const rawAutoAssign = ctx.config.autoAssign;
    const autoAssign = typeof rawAutoAssign === "function" ? true : (rawAutoAssign ?? true);
    const rawAutoAuthorize = ctx.config.autoAuthorize;
    const autoAuthorize = typeof rawAutoAuthorize === "function" ? 1 : (rawAutoAuthorize ?? 1);
    return { autoAssign, autoAuthorize };
}

/** 事件桥装配依赖。 */
export interface BridgeHost {
    /** 日志对象。 */
    logger: Logger;
    /** 登录状态机引用（selfId 缺省兜底）。 */
    getLogin: () => NapukettoLoginState;
    /** 配置（selfId 兜底）。 */
    config: NapukettoBotConfig;
    dataRoot: string;
    /** 派发（预热 + session 组装 + dispatch）。 */
    dispatchSession: (session: NapukettoSessionFields) => Promise<void>;
}

/** 装配事件桥：kernel 事件 → koishi session（dispatch 异步化 + 预热不阻断）。 */
export function createBridge(host: BridgeHost): NapukettoEventBridge {
    return new NapukettoEventBridge({
        // 事件桥同步接收事件，预热与派发由下游异步处理。
        dispatch: (session) => {
            void host.dispatchSession(session);
        },
        selfId: () => host.getLogin().snapshot.self?.uin ?? host.config.selfId,
        // koishi h 可调用（Element 工厂）；绑定生产 h
        h: bindKoishiH(koishiH),
        platform: "onebot",
        enrichElements: (elements) =>
            enrichReceiveVoice(elements, host.dataRoot, (message) => host.logger.warn(message)),
    });
}

/** 动作桥装配依赖。 */
export interface InternalHost {
    config: NapukettoBotConfig;
    /** 当前 IPC 客户端（null = 子进程未就绪，request 抛错）。 */
    getClient: () => NapukettoIpcClient | null;
    getSelfIdentity: NonNullable<NapukettoInternalOptions["getSelfIdentity"]>;
    /** 告警日志（远程媒体下载失败等；缺省静默）。 */
    logger?: { warn(message: string): void };
}

/** 装配动作桥：koishi 动作 → IPC action（request 绑定 client 引用）。 */
export function createInternal(host: InternalHost): NapukettoInternal {
    return new NapukettoInternal({
        h: koishiH,
        ...(host.config.remoteMediaPolicy === undefined
            ? {}
            : { remoteMediaPolicy: host.config.remoteMediaPolicy }),
        ...(host.config.localFilePolicy === undefined
            ? {}
            : { localFilePolicy: host.config.localFilePolicy }),
        ...(host.config.localMediaRoots === undefined
            ? {}
            : { localMediaRoots: host.config.localMediaRoots }),
        getSelfIdentity: host.getSelfIdentity,
        request: async (action, params) => {
            const client = host.getClient();
            if (client === null) {
                throw new Error("Napuketto 子进程未就绪（等待驱动连接）");
            }
            return client.request(action, params);
        },
        ...(host.logger !== undefined ? { logger: host.logger } : {}),
    });
}

/** 每轮创建独立驱动，扫码标记由启动工厂消费。 */
function createDriver(
    config: NapukettoBotConfig,
    dataRoot: string,
    logger: Logger,
    events: DriverEvents,
    forceQr: { current: boolean },
): NapukettoDriver {
    const selfId = requireSelfId(config.selfId);
    return new NapukettoDriver({
        accountDir: join(dataRoot, selfId),
        launch: buildLaunch(
            { ...config, dataDir: dataRoot },
            {
                onStage: (message) => logger.info("[napuketto] %s", message),
                forceQr,
            },
        ),
        events,
        ...(config.restart !== undefined ? { restart: config.restart } : {}),
        ...(config.heartbeatTimeoutMs !== undefined
            ? { heartbeatTimeoutMs: config.heartbeatTimeoutMs }
            : {}),
        onJunkLine: (line) => {
            logger.debug(
                "[napuketto] IPC 收到无法解析的行（可能被并发输出撕裂）: %s",
                line.slice(0, 200),
            );
        },
    });
}

type LoginBot = Pick<Bot, "selfId" | "user" | "toJSON"> & {
    internal: Pick<NapukettoInternal, "getSelf">;
};

/** 登录推送已有自身信息时直接使用，缺省时才向宿主拉取。 */
export async function resolveBotLogin(
    bot: LoginBot,
    self: LoginSnapshot["self"],
): Promise<Universal.Login> {
    if (self !== undefined) {
        syncUser(bot, { uin: self.uin, nick: self.nick });
        bot.selfId = self.uin;
    } else {
        const data = (await bot.internal.getSelf()) as
            | { uin?: string; nickname?: string }
            | undefined;
        if (data != null) {
            if (typeof data.uin === "string" && data.uin !== "") {
                bot.selfId = data.uin;
            }
            syncUser(bot, { uin: data.uin, nick: data.nickname });
        }
    }
    return bot.toJSON();
}

function syncUser(bot: Pick<Bot, "user">, partial: Parameters<typeof toUserFields>[0]): void {
    bot.user ??= {} as Universal.User;
    Object.assign(bot.user, toUserFields(partial));
}

export function createDispatcher(
    ctx: KoishiContext,
    bot: Pick<Bot, "session" | "dispatch" | "logger">,
    lifecycle: BotLifecycleController,
): SessionDispatcher {
    return new SessionDispatcher({
        bot,
        logger: bot.logger,
        ...resolveAssignPolicy(ctx),
        database: new NapukettoDatabase(ctx),
        getClient: () => lifecycle.dispatchClient,
    });
}

type LifecycleBot = Pick<
    Bot,
    "status" | "isActive" | "online" | "offline" | "getLogin" | "user" | "logger"
> & {
    config: NapukettoBotConfig;
};

interface LifecycleWiring {
    login: NapukettoLoginState;
    getBridge(): NapukettoEventBridge;
    stopBot(): Promise<void>;
}

export function createLifecycle(
    bot: LifecycleBot,
    dataRoot: string,
    wiring: LifecycleWiring,
): BotLifecycleController {
    const { logger } = bot;
    return new BotLifecycleController({
        ...wiring,
        bot,
        logger,
        getSelfId: () => bot.config.selfId,
        syncUser: (user) => syncUser(bot, user),
        createDriver: (events, forceQr) =>
            createDriver(bot.config, dataRoot, logger, events, forceQr),
    });
}
