/**
 * types.ts：登录交互层类型（docs/architecture/lifecycle.md）。
 *
 * 登录状态在子进程内驱动（self-host bootstrap 登录），插件侧只做状态观察 +
 * QR 展示。driver 的 onLogin/onQr 已透出——LoginObserver 装配这两个回调。
 */
import type { LoginState, QrCodeData, SelfInfo } from "@napuketto/kernel";

/** 登录 UI 视图（koishi 控制台展示，本轮定义接口，apply() 层接 console）。 */
export interface LoginView {
    /** 状态变化（含登录成功 selfInfo）。 */
    onStateChange?(state: LoginState, self?: SelfInfo): void;
    /** 二维码更新（刷新/过期重取）。 */
    onQrChange?(qr: QrCodeData): void;
    /** 登录失败错误。 */
    onError?(error: unknown): void;
}

/** 登录观察者（驱动层回调 → 登录状态机）。 */
export interface LoginObserver {
    /** driver.onLogin：kernel 登录状态。 */
    onLogin(state: LoginState, selfInfo?: SelfInfo): void;
    /** driver.onQr：二维码数据。 */
    onQr(qr: QrCodeData): void;
    /** driver.onReady：就绪（重置登录状态为 logged_in 快照保留）。 */
    onReady(): void;
    /** driver.onExit：子进程退出（登录状态归 idle）。 */
    onExit(): void;
}

/** 登录状态快照（apply() 层查询用）。 */
export interface LoginSnapshot {
    state: LoginState;
    /** 最新二维码（waiting_scan 时有）。 */
    qr?: QrCodeData;
    /** 登录成功 selfInfo。 */
    self?: SelfInfo;
    /** 最近错误（failed 时）。 */
    lastError?: string;
}
