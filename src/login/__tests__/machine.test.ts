/**
 * machine.test.ts：登录状态机单测。
 *
 * 覆盖：状态迁移（QR 登录全流程 / 快速登录直通 / failed）、QR 缓冲（先于
 * waiting_scan 到达）、onReady 补发 logged_in、onExit 重置、view 回调、
 * snapshot 快照。
 */
import { describe, expect, it, vi } from "vitest";
import { NapukettoLoginState } from "../machine.js";
import type { LoginView } from "../types.js";

const QR = { pngBase64: "aGk=", qrcodeUrl: "https://x" } as const;

describe("NapukettoLoginState", () => {
    it("QR 登录全流程：waiting_scan → scanned → logged_in", () => {
        const changes: string[] = [];
        const view: LoginView = {
            onStateChange: (state) => changes.push(state),
        };
        const machine = new NapukettoLoginState(view);

        machine.onLogin("waiting_scan");
        expect(machine.currentState).toBe("waiting_scan");

        machine.onLogin("scanned");
        expect(machine.currentState).toBe("scanned");

        machine.onLogin("logged_in", { uin: "10001", uid: "u1", nick: "n" });
        expect(machine.currentState).toBe("logged_in");
        expect(machine.snapshot.self).toEqual({ uin: "10001", uid: "u1", nick: "n" });
        expect(changes).toEqual(["waiting_scan", "scanned", "logged_in"]);
    });

    it("快速登录直通：onLogin(logged_in) 不经过 waiting_scan", () => {
        const machine = new NapukettoLoginState();
        machine.onLogin("logged_in", { uin: "1", uid: "u1", nick: "n" });
        expect(machine.currentState).toBe("logged_in");
    });

    it("QR 缓冲：onQr 先于 waiting_scan 到达 → 迁移时随状态送出", () => {
        const qrChanges: unknown[] = [];
        const view: LoginView = {
            onQrChange: (qr) => qrChanges.push(qr),
        };
        const machine = new NapukettoLoginState(view);

        machine.onQr(QR); // 先收二维码（IPC 乱序）
        expect(machine.currentState).toBe("idle"); // 状态不变
        expect(qrChanges).toHaveLength(1); // 但 onQrChange 已通知
        expect(machine.snapshot.qr).toEqual(QR);

        machine.onLogin("waiting_scan");
        expect(machine.currentState).toBe("waiting_scan");
    });

    it("failed 记录 lastError 并通知", () => {
        const changes: string[] = [];
        const view: LoginView = {
            onStateChange: (state) => changes.push(state),
        };
        const machine = new NapukettoLoginState(view);
        machine.onLogin("failed");
        expect(machine.currentState).toBe("failed");
        expect(machine.snapshot.lastError).toBe("登录失败");
        expect(changes).toEqual(["failed"]);
    });

    it("failed 带 message → lastError 用 message（如登录超时）", () => {
        const machine = new NapukettoLoginState();
        machine.onLogin("failed", undefined, "登录超时，请刷新页面重试");
        expect(machine.currentState).toBe("failed");
        expect(machine.snapshot.lastError).toBe("登录超时，请刷新页面重试");
    });

    it("onReady 在未到 logged_in 时补发（快速登录直通兜底）", () => {
        const changes: string[] = [];
        const machine = new NapukettoLoginState({
            onStateChange: (state) => changes.push(state),
        });
        machine.onReady();
        expect(machine.currentState).toBe("logged_in");
        expect(changes).toEqual(["logged_in"]);
    });

    it("onExit 重置为 idle（重启后重新登录）", () => {
        const machine = new NapukettoLoginState();
        machine.onLogin("waiting_scan");
        machine.onQr(QR);
        machine.onExit();
        expect(machine.currentState).toBe("idle");
        expect(machine.snapshot.qr).toBeUndefined();
        expect(machine.snapshot.self).toBeUndefined();
    });

    it("reset 清空二维码、账号和错误（新一轮启动前复位）", () => {
        const machine = new NapukettoLoginState();
        machine.onQr(QR);
        machine.onLogin("logged_in", { uin: "10001", uid: "u1", nick: "n" });
        machine.onLogin("failed", undefined, "旧错误");
        machine.reset();
        expect(machine.currentState).toBe("idle");
        expect(machine.snapshot).toEqual({ state: "idle" });
    });

    it("相同状态不重复通知", () => {
        const onStateChange = vi.fn();
        const machine = new NapukettoLoginState({ onStateChange });
        machine.onLogin("waiting_scan");
        machine.onLogin("waiting_scan");
        expect(onStateChange).toHaveBeenCalledTimes(1);
    });

    it("登录成功 selfInfo 经 onStateChange 透出", () => {
        const view: LoginView = {
            onStateChange: vi.fn((_state, self) => {
                expect(self).toEqual({ uin: "1", uid: "u1", nick: "n" });
            }),
        };
        const machine = new NapukettoLoginState(view);
        machine.onLogin("logged_in", { uin: "1", uid: "u1", nick: "n" });
    });
});
