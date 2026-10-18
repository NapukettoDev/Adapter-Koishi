/**
 * provider.ts：控制台登录面板数据服务（design.md §5.12）。
 *
 * NapukettoLoginProvider extends DataService（@koishijs/plugin-console）：
 *  - 数据下行：update() 存快照 + refresh() 推送到前端 store（`napuketto-login-<uin>`）
 *  - 指令上行：注册 `napuketto-login-<uin>/relogin` console 事件 →
 *    onRelogin 回调（bot 层发 IPC control restart 重启登录流程）
 *
 * 运行时 import @koishijs/plugin-console / koishi——本文件不进单测
 * （HANDOVER §7 坑 1）；纯逻辑在 payload.ts（可单测）。
 */
import { type Console, DataService, type Events } from "@koishijs/plugin-console";
import type { Context, Logger } from "koishi";
import type { LoginPanelPayload } from "./types.js";

// 类型声明扩展（B站模板同款模式）：把本 provider 的 serviceId / relogin 事件
// 挂进 @koishijs/plugin-console 的类型空间（store 键 + addListener 事件名校验）。
// ⚠️ TS7 native（tsgo）对 declare module + export *（@koishijs/console）的
// namespace 合并不生效（调用点 cast 兜底，见 super/addListener）；旧 TS 下
// 声明有效，未来 TS 修复后可直接去掉 cast。
declare module "@koishijs/plugin-console" {
    namespace Console {
        interface Services {
            [key: `napuketto-login-${string}`]: NapukettoLoginProvider;
        }
    }
    interface Events {
        [key: `napuketto-login-${string}/relogin`]: (data: { selfId: string }) => void;
        [key: `napuketto-login-${string}/qr-login`]: (data: { selfId: string }) => void;
        [key: `napuketto-login-${string}/refresh-qr`]: (data: { selfId: string }) => void;
    }
}

/** serviceId 前缀（多账号隔离：napuketto-login-<uin>）。 */
const LOGIN_SERVICE_PREFIX = "napuketto-login";

/** 重新登录 console 事件名后缀。 */
const RELOGIN_EVENT_SUFFIX = "relogin";

/** 强制扫码登录 console 事件名后缀（2026-09-08）。 */
const QR_LOGIN_EVENT_SUFFIX = "qr-login";

/** 刷新二维码 console 事件名后缀。 */
const REFRESH_QR_EVENT_SUFFIX = "refresh-qr";

/** store 键 / serviceId。 */
export function loginServiceId(selfId: string): string {
    return `${LOGIN_SERVICE_PREFIX}-${selfId}`;
}

/** 重新登录事件名（前端 send / 后端 addListener 用）。 */
function reloginEventName(selfId: string): string {
    return `${loginServiceId(selfId)}/${RELOGIN_EVENT_SUFFIX}`;
}

/** 刷新二维码事件名（前端 send / 后端 addListener 用）。 */
function refreshQrEventName(selfId: string): string {
    return `${loginServiceId(selfId)}/${REFRESH_QR_EVENT_SUFFIX}`;
}

/** 强制扫码登录事件名（前端 send / 后端 addListener 用）。 */
function qrLoginEventName(selfId: string): string {
    return `${loginServiceId(selfId)}/${QR_LOGIN_EVENT_SUFFIX}`;
}

/** provider 选项。 */
interface LoginPanelOptions {
    /** 登录账号（QQ 号）。 */
    selfId: string;
    /**
     * 日志对象（bot 的 logger）。
     *
     * ⚠️ 必须注入，不能用 `this.ctx.logger`（2026-10-17 修复）：DataService 的构造
     * 参数会把 fork ctx 的 runtime.name 改成 `console.services.<serviceId>`，
     * 该名字与插件的 logger（`onebot`/`NapukettoBot`）不同源，reggol 只按名字
     * 查 Logger.levels——插件「日志等级」配置对它无效，provider 的 INFO 诊断
     * 因此无论日志等级调到多低都持续刷屏。注入 bot logger 后等级与插件其余
     * 日志一致（`logLevel` 生效）。
     */
    logger: Logger;
    /** 前端点「重新登录」回调（bot 层按状态发 control login / restart）。 */
    onRelogin?: () => void;
    /** 前端点「扫码登录」回调（bot 层发 control login qr / qrOnly+restart，2026-09-08）。 */
    onQrLogin?: () => void;
    /** 前端点「刷新二维码」回调（bot 层发 IPC login.refreshQr 动作，不重启子进程）。 */
    onRefreshQr?: () => void;
}

/** 控制台登录面板数据服务（DataService 下行 + relogin 指令上行）。 */
export class NapukettoLoginProvider extends DataService<LoginPanelPayload> {
    private payload: LoginPanelPayload;
    // 字段名不用 logger：DataService 基类 Service 自带 deprecated 的 `logger`
    // 实例（名字同为 console.services.*，等级同样不受 logLevel 控制）。
    private readonly botLogger: Logger;
    private readonly onRelogin: (() => void) | undefined;
    private readonly onQrLogin: (() => void) | undefined;
    private readonly onRefreshQr: (() => void) | undefined;

    constructor(ctx: Context, options: LoginPanelOptions) {
        // ⚠️ 服务值注册交给调用方（bot.ts）——2026-08-14 根因修复 v3：登录是
        // 自动启动的，二维码/状态在控制台客户端连接前就推完，被
        // DataService.refresh() → Console.broadcast() 的 `if (!handles.length)
        // return` 丢弃；用户打开控制台后只能靠 Client.refresh() 的 PULL 拉取。
        // PULL 用 `root.get('console.services.<id>')` 读 root store——所以服务
        // 值必须注册到 root store，且要在 bot dispose 时清理（否则 reload 报
        // `service has been registered`）。这两件事由 bot.ts 统一处理（拿 set
        // 返回的 dispose 函数在 dispose 时调用）；provider 自身用 immediate:
        // true（直接 new 走 expose 路径，不自动 set，避免与调用方重复注册）。
        super(ctx, loginServiceId(options.selfId) as keyof Console.Services, {
            immediate: true,
        });
        this.onRelogin = options.onRelogin;
        this.onQrLogin = options.onQrLogin;
        this.onRefreshQr = options.onRefreshQr;
        this.botLogger = options.logger;
        this.payload = { state: "idle", selfId: options.selfId };
        this.botLogger.debug(
            "[napuketto] 控制台登录面板 provider 已创建: serviceId=%s",
            loginServiceId(options.selfId),
        );
        // 指令上行：前端「重新登录」→ bot 层按状态发 control login / restart
        ctx.console.addListener(reloginEventName(options.selfId) as keyof Events, () => {
            this.onRelogin?.();
        });
        // 指令上行：前端「扫码登录」→ bot 层强制扫码（control login qr / qrOnly+restart）
        ctx.console.addListener(qrLoginEventName(options.selfId) as keyof Events, () => {
            this.onQrLogin?.();
        });
        // 指令上行：前端「刷新二维码」→ bot 层 IPC 直达 refreshQr（不重启子进程）
        ctx.console.addListener(refreshQrEventName(options.selfId) as keyof Events, () => {
            this.onRefreshQr?.();
        });
    }

    /** 更新登录状态并推送（每次全量推送——状态变化不频繁，无需 diff）。 */
    update(next: LoginPanelPayload): void {
        this.botLogger.debug(
            "[napuketto] 控制台登录面板 update: state=%s selfId=%s",
            next.state,
            next.selfId,
        );
        this.payload = next;
        // 推送不阻塞调用方（update 是同步状态回调）；DataService 内部处理推送失败。
        void this.refresh();
    }

    /** DataService 抽象方法：前端 store 请求时返回当前快照。 */
    override async get(): Promise<LoginPanelPayload> {
        // 诊断：控制台客户端连接时 Client.refresh() 会调 get()（PULL 路径）。
        // 若这行不出现 = 服务值未注册到 root store / 客户端没拉取到本服务。
        // debug 级（每次客户端刷新都刷一行，INFO 下应静音）。
        this.botLogger.debug(
            "[napuketto] get() 被调用（前端 PULL 拉取）: state=%s qr=%s",
            this.payload.state,
            this.payload.qr !== undefined,
        );
        return this.payload;
    }
}
