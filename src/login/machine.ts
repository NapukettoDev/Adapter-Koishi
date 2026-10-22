/**
 * machine.ts：登录状态机（docs/architecture/lifecycle.md）。
 *
 * 观察 driver.onLogin/onQr → 迁移 + 通知 LoginView。QR 缓冲：onQr 先于
 * onLogin(waiting_scan) 到达（IPC 乱序）→ 内部暂存，迁移时随状态送出。
 */
import type { LoginState, QrCodeData, SelfInfo } from "@napuketto/kernel";
import type { LoginObserver, LoginSnapshot, LoginView } from "./types.js";

/** 登录状态机。 */
export class NapukettoLoginState implements LoginObserver {
    private readonly view: LoginView;
    private state: LoginState = "idle";
    private qr: QrCodeData | null = null;
    private self: SelfInfo | null = null;
    private lastError: string | null = null;

    constructor(view: LoginView = {}) {
        this.view = view;
    }

    /** 当前登录状态。 */
    get currentState(): LoginState {
        return this.state;
    }

    /** 快照（apply() 层查询）。 */
    get snapshot(): LoginSnapshot {
        return {
            state: this.state,
            ...(this.qr !== null ? { qr: this.qr } : {}),
            ...(this.self !== null ? { self: this.self } : {}),
            ...(this.lastError !== null ? { lastError: this.lastError } : {}),
        };
    }

    /** 收到登录状态（driver.onLogin）。message 为失败原因（如登录超时）。 */
    onLogin(state: LoginState, selfInfo?: SelfInfo, message?: string): void {
        if (selfInfo !== undefined) {
            this.self = selfInfo;
        }
        if (state === "failed") {
            this.lastError = message ?? "登录失败";
        }
        this.transition(state);
    }

    /** 收到二维码（driver.onQr；可能先于 waiting_scan 到达，缓冲）。 */
    onQr(qr: QrCodeData): void {
        this.qr = qr;
        this.view.onQrChange?.(qr);
        // 若已处于 waiting_scan，无需迁移；否则等待 onLogin(waiting_scan) 时随状态送出
        if (this.state === "waiting_scan") {
            this.notifyState();
        }
    }

    /** 就绪（driver.onReady）：状态机保持 logged_in（快照保留）。 */
    onReady(): void {
        // 子进程就绪 = 登录已完成；若状态机还没到 logged_in（快速登录直通），补发
        if (this.state !== "logged_in") {
            this.transition("logged_in");
        }
    }

    /** 子进程退出（driver.onExit）：登录状态归 idle（重启后重新登录）。 */
    onExit(): void {
        this.qr = null;
        this.self = null;
        this.lastError = null;
        this.transition("idle");
    }

    private transition(next: LoginState): void {
        if (next === this.state) {
            return;
        }
        this.state = next;
        this.notifyState();
    }

    private notifyState(): void {
        const self = this.self;
        this.view.onStateChange?.(this.state, self === null ? undefined : self);
    }
}
