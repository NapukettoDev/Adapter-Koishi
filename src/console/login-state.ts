import type { LoginState, QrCodeData, SelfInfo } from "@napuketto/kernel";

/** 登录 UI 视图（Bot 装配时注入）。 */
export interface LoginView {
    /** 状态变化（含登录成功 selfInfo）。 */
    onStateChange?(state: LoginState, self?: SelfInfo): void;
    /** 二维码更新（刷新/过期重取）。 */
    onQrChange?(qr: QrCodeData): void;
    /** 登录失败错误。 */
    onError?(error: unknown): void;
}

/** 登录观察者（驱动层回调 → 登录状态机）。 */
interface LoginObserver {
    /** driver.onLogin：kernel 登录状态。 */
    onLogin(state: LoginState, selfInfo?: SelfInfo): void;
    /** driver.onQr：二维码数据。 */
    onQr(qr: QrCodeData): void;
    /** driver.onReady：就绪（重置登录状态为 logged_in 快照保留）。 */
    onReady(): void;
    /** driver.onExit：子进程退出（登录状态归 idle）。 */
    onExit(): void;
}

/** 与 QQ 扫码提示一致的本地展示期限，宿主仍负责决定是否自动刷新。 */
const QR_EXPIRY_MS = 2 * 60 * 1000;
type TimedQrCode = QrCodeData & { expiresAt: number };

/** 登录状态快照（apply() 层查询用）。 */
export interface LoginSnapshot {
    state: LoginState;
    /** 最新二维码（waiting_scan 时有）。 */
    qr?: TimedQrCode;
    /** 登录成功 selfInfo。 */
    self?: SelfInfo;
    /** 最近错误（failed 时）。 */
    lastError?: string;
    /** 登录轮次：每次重新登录/复位自增，异步身份查询只认同一轮快照。 */
    generation: number;
}

/**
 * 观察宿主登录状态并通知面板。若二维码先于 waiting_scan 到达，
 * 先暂存二维码，等状态迁移时一并通知。
 */
export class NapukettoLoginState implements LoginObserver {
    private readonly view: LoginView;
    private state: LoginState = "idle";
    private qr: TimedQrCode | null = null;
    private self: SelfInfo | null = null;
    private lastError: string | null = null;
    private generation = 0;

    constructor(view: LoginView = {}) {
        this.view = view;
    }

    /** 当前登录状态。 */
    get currentState(): LoginState {
        return this.state;
    }

    /** 当前登录轮次（生命周期控制器绑定异步响应）。 */
    get currentGeneration(): number {
        return this.generation;
    }

    /** 快照（apply() 层查询）。 */
    get snapshot(): LoginSnapshot {
        return {
            state: this.state,
            ...(this.state === "waiting_scan" && this.qr !== null ? { qr: this.qr } : {}),
            ...(this.self !== null ? { self: this.self } : {}),
            ...(this.lastError !== null ? { lastError: this.lastError } : {}),
            generation: this.generation,
        };
    }

    /** 收到登录状态（driver.onLogin）。message 为失败原因（如登录超时）。 */
    onLogin(state: LoginState, selfInfo?: SelfInfo, message?: string): void {
        const previousSelf = this.self;
        const previousError = this.lastError;
        if (state === "logged_in") {
            if (selfInfo !== undefined) {
                this.self = selfInfo;
            }
        } else {
            this.self = null;
        }
        if (state !== "waiting_scan") {
            this.qr = null;
        }
        this.lastError = state === "failed" ? (message ?? "登录失败") : null;
        if (state !== this.state) {
            this.transition(state);
        } else if (this.self !== previousSelf || this.lastError !== previousError) {
            this.notifyState();
        }
    }

    /** Loader 在 waiting_scan 进度前先发二维码。终态的迟到二维码直接丢弃。 */
    onQr(qr: QrCodeData): void {
        if (this.state === "logged_in" || this.state === "failed") {
            return;
        }
        this.qr = { ...qr, expiresAt: Date.now() + QR_EXPIRY_MS };
        if (this.state === "waiting_scan") {
            this.view.onQrChange?.(qr);
        }
    }

    /** 快速登录可以直接收到 ready。 */
    onReady(): void {
        this.onLogin("logged_in");
    }

    /** 子进程退出（driver.onExit）：登录状态归 idle（重启后重新登录）。 */
    onExit(): void {
        this.reset();
    }

    /**
     * 开始新的登录轮次：自增 generation 并清空上一轮二维码/账号/错误。
     *
     * 软重登在同一宿主、同一 driver 内发生，单靠 driver 轮次号无法区分；
     * 异步身份查询和 getLogin 结果必须在 generation 变化后作废。
     */
    beginLoginRound(): void {
        this.generation++;
        this.qr = null;
        this.self = null;
        this.lastError = null;
        if (this.state === "idle") {
            this.notifyState();
        } else {
            this.transition("idle");
        }
    }

    /**
     * 账号不一致/身份不可用：作废本轮身份并进入可重新登录的 failed 状态。
     *
     * 不复用上一轮 self，避免后续事件或动作继续按旧账号派发。
     */
    rejectIdentity(message: string): void {
        this.generation++;
        this.qr = null;
        this.self = null;
        this.lastError = message;
        if (this.state === "failed") {
            this.notifyState();
        } else {
            this.transition("failed");
        }
    }

    /**
     * 复位登录会话（清理二维码/账号/错误并回到 idle）。
     *
     * 子进程退出与 Bot 的新一轮 start 共用：旧 driver 在 stop 后不会再触发
     * onExit（回调已过期），新一轮启动必须在 spawn 前主动清掉上一轮快照。
     */
    reset(): void {
        this.beginLoginRound();
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
