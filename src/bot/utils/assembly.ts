/**
 * assembly.ts：bot 构造装配工厂（自 bot.ts setupXxx 方法拆出）。
 *
 * 职责：把 NapukettoBot 构造时的各组件装配（登录状态机/控制台面板/事件桥/
 * 动作桥/数据库策略）抽成独立工厂函数——依赖经 host 接口注入（与
 * driver-events.ts 同模式），bot.ts 的 constructor 只做顺序编排。
 *
 * 实例间引用用 getter 闭包（运行时求值），解除初始化顺序耦合：
 * login 回调需要 panel、panel 需要 login.snapshot——各自 getter 在回调
 * 触发时才取值，constructor 顺序任意。
 *
 * 运行时 import koishi（类型）/NapukettoInternal 等——本文件不进单测
 * （docs/guides/development.md 单测边界）。
 */
import { type Context as KoishiContext, h as koishiH, type Logger, type Universal } from "koishi";
import { NapukettoInternal } from "../../actions/index.js";
import type { NapukettoBotConfig } from "../../config.js";
import { bindKoishiH } from "../../events/elements.js";
import {
    enrichReceiveVoice,
    NapukettoEventBridge,
    type NapukettoSessionFields,
} from "../../events/index.js";
import type { NapukettoIpcClient } from "../../ipc/index.js";
import { NapukettoLoginState } from "../../login/index.js";
import { NapukettoLoginPanel } from "../login-panel.js";
import { toUserFields } from "./transform.js";

// ── 登录状态机 ──

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

// ── 控制台登录面板 ──

/** 面板装配依赖。 */
export interface PanelHost {
    /** 登录账号（QQ 号，serviceId 隔离）。 */
    selfId: string;
    /** 日志对象。 */
    logger: Logger;
    /** 登录状态机引用（快照 getter 运行时求值——panel 晚于 login 创建）。 */
    getLogin: () => NapukettoLoginState;
    /** 当前 IPC 客户端（null = 子进程未就绪）。 */
    getClient: () => NapukettoIpcClient | null;
    /** 强制扫码重启（登录期外「扫码登录」：置 qrOnly 标记 + control restart）。 */
    forceQrRestart: () => boolean;
}

/** 装配控制台登录面板（login-panel.ts：装配/reload 去重/连接回放/指令上行）。 */
export function createPanel(host: PanelHost): NapukettoLoginPanel {
    return new NapukettoLoginPanel({
        selfId: host.selfId,
        getSnapshot: () => host.getLogin().snapshot,
        sendControl: (payload) => {
            const client = host.getClient();
            if (client === null) {
                return false;
            }
            client.sendControl(payload);
            return true;
        },
        request: async (action, params) => {
            const client = host.getClient();
            if (client === null) {
                throw new Error("Napuketto 子进程未就绪（等待驱动连接）");
            }
            return client.request(action, params);
        },
        forceQrRestart: host.forceQrRestart,
        logger: host.logger,
    });
}

// ── 数据库策略 ──

/**
 * 解析 autoAssign/autoAuthorize 语义。
 *
 * koishi 的这两项配置支持 Computed 函数形式（per-session 计算）——构造阶段
 * 无 session 无法求值，取 Schema 默认值（autoAssign=true / autoAuthorize=1）。
 */
export function resolveAssignPolicy(ctx: KoishiContext): {
    autoAssign: boolean;
    autoAuthorize: number;
} {
    const rawAutoAssign = ctx.config.autoAssign;
    const autoAssign = typeof rawAutoAssign === "function" ? true : (rawAutoAssign ?? true);
    const rawAutoAuthorize = ctx.config.autoAuthorize;
    const autoAuthorize = typeof rawAutoAuthorize === "function" ? 1 : (rawAutoAuthorize ?? 1);
    return { autoAssign, autoAuthorize };
}

// ── 事件桥 ──

/** 事件桥装配依赖。 */
export interface BridgeHost {
    /** 日志对象。 */
    logger: Logger;
    /** 登录状态机引用（selfId 缺省兜底）。 */
    getLogin: () => NapukettoLoginState;
    /** 配置（selfId 兜底）。 */
    config: NapukettoBotConfig;
    /** 派发（预热 + session 组装 + dispatch）。 */
    dispatchSession: (session: NapukettoSessionFields) => Promise<void>;
}

/** 装配事件桥：kernel 事件 → koishi session（dispatch 异步化 + 预热不阻断）。 */
export function createBridge(host: BridgeHost): NapukettoEventBridge {
    return new NapukettoEventBridge({
        // dispatch 异步化（2026-08-09）：先原子预热 channel 再派发；桥回调
        // 同步面，显式 void 丢弃 promise（预热失败不阻断派发）
        dispatch: (session) => {
            void host.dispatchSession(session);
        },
        selfId: () => host.getLogin().snapshot.self?.uin ?? host.config.selfId,
        // koishi h 可调用（Element 工厂）；绑定生产 h（elements.ts bindKoishiH）
        h: bindKoishiH(koishiH),
        platform: "onebot",
        // 收向语音解码（voice NT silk → WAV 可播放；fail-soft，2026-09-08 T6）
        enrichElements: (elements) => enrichReceiveVoice(elements),
    });
}

// ── 动作桥 ──

/** 动作桥装配依赖。 */
export interface InternalHost {
    /** 当前 IPC 客户端（null = 子进程未就绪，request 抛错）。 */
    getClient: () => NapukettoIpcClient | null;
    /** 告警日志（远程媒体下载失败等；缺省静默）。 */
    logger?: { warn(message: string): void };
}

/** 装配动作桥：koishi 动作 → IPC action（request 绑定 client 引用）。 */
export function createInternal(host: InternalHost): NapukettoInternal {
    return new NapukettoInternal({
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
