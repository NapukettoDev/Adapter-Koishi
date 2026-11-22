/** 创建 Bot 使用的登录、控制台、驱动和消息桥组件。 */
import { join } from "node:path";
import {
    type Bot,
    type Computed,
    type Context as KoishiContext,
    h as koishiH,
    type Logger,
    type Universal,
} from "koishi";
import { NapukettoInternal } from "../bridge/actions/internal.js";
import type { NapukettoInternalOptions } from "../bridge/actions/types.js";
import { NapukettoEventBridge } from "../bridge/events/bridge.js";
import type { NapukettoSessionFields } from "../bridge/events/types.js";
import { enrichReceiveVoice } from "../bridge/events/voice-decode.js";
import type { NapukettoBotConfig } from "../config.js";
import { NapukettoLoginState } from "../console/login-state.js";
import { type LoginPanelDeps, NapukettoLoginPanel } from "../console/panel.js";
import { bindLoginProvider } from "../console/provider.js";
import { NapukettoDriver } from "../runtime/driver/driver.js";
import type { DriverEvents } from "../runtime/driver/types.js";
import type { NapukettoIpcClient } from "../runtime/ipc/index.js";
import { bindKoishiH, IpcError, requireSelfId } from "../shared.js";
import { NapukettoDatabase } from "./database.js";
import { SessionDispatcher } from "./dispatcher.js";
import { buildLaunch } from "./launch.js";
import { BotLifecycleController } from "./lifecycle.js";
import { syncUser, toUserFields } from "./transform.js";

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
        onError: () => {
            host.logger.warn("[napuketto] 宿主报告登录失败");
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

/** 装配控制台登录面板（panel.ts：装配/reload 去重/连接回放/指令上行）。 */
export function createPanel(host: PanelHost): NapukettoLoginPanel {
    const sendControl: LoginPanelDeps["sendControl"] = (payload) => {
        const client = host.getClient();
        if (client === null) {
            return false;
        }
        return client.sendControl(payload);
    };
    return new NapukettoLoginPanel(
        {
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
        },
        bindLoginProvider,
    );
}

/**
 * 读取 autoAssign/autoAuthorize 原始配置。
 *
 * koishi 的这两项配置支持 Computed 函数 / Eval 表达式（per-session 计算）。这里
 * 只补配置缺省值，不在构造期求值：dispatcher 对可安全求值的函数按真实 session
 * 预热，其余交给 koishi 在 dispatch 时计算，避免写入默认权限或错误 assignee。
 */
function resolveAssignPolicy(ctx: KoishiContext): {
    autoAssign: Computed<boolean>;
    autoAuthorize: Computed<number>;
} {
    return {
        autoAssign: ctx.config.autoAssign ?? true,
        autoAuthorize: ctx.config.autoAuthorize ?? 1,
    };
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
        // 事件桥同步接收事件，预热与派发由下游异步处理；Promise 拒绝由桥统一诊断。
        dispatch: (session) => host.dispatchSession(session),
        selfId: () => host.getLogin().snapshot.self?.uin ?? host.config.selfId,
        // koishi h 可调用（Element 工厂）；绑定生产 h
        h: bindKoishiH(koishiH),
        platform: "onebot",
        enrichElements: (elements) =>
            enrichReceiveVoice(elements, host.dataRoot, (message) => host.logger.warn(message)),
        onError: (error, context) => host.logger.warn("[napuketto] %s: %o", context, error),
    });
}

/** 动作桥装配依赖。 */
export interface InternalHost {
    config: NapukettoBotConfig;
    dataRoot: string;
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
        diagnostics: host.config.diagnostics === true,
        outboundRoot: join(host.dataRoot, requireSelfId(host.config.selfId), "outbound-media"),
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
        onJunkLine: () => {
            logger.debug("[napuketto] IPC 丢弃一条无法解析的行");
        },
    });
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
