/**
 * login-actions.test.ts：重新登录/强制扫码决策与执行单测（2026-09-08 T2；
 * 2026-09-08 A2 扩展 ready 态软重登）。
 *
 * planRelogin：登录期或 logged_in 走 control login，failed 走 restart。
 * executeRelogin：指令发出（mock IPC executor）、control-login 失败回落
 * restart、forceQr 走 qrOnly+restart。
 */
import type { LoginState } from "@napuketto/kernel";
import type { IpcControlPayload } from "@napuketto/loader";
import { describe, expect, it, vi } from "vitest";
import { executeRelogin, planRelogin, type ReloginExecutor } from "../login-actions.js";

describe("planRelogin", () => {
    it.each(["idle", "waiting_scan", "scanned"] as LoginState[])(
        "登录期（%s）→ control login（qrOnly 决定 qr，soft=false）",
        (state) => {
            expect(planRelogin({ state, uin: "10001", qrOnly: false })).toEqual({
                kind: "control-login",
                uin: "10001",
                qr: false,
                soft: false,
            });
            expect(planRelogin({ state, uin: "10001", qrOnly: true })).toEqual({
                kind: "control-login",
                uin: "10001",
                qr: true,
                soft: false,
            });
        },
    );

    it.each([false, true])(
        "logged_in（ready 态）→ control login 软重登（soft=true，qr=%s）",
        (qrOnly) => {
            expect(planRelogin({ state: "logged_in", uin: "10001", qrOnly })).toEqual({
                kind: "control-login",
                uin: "10001",
                qr: qrOnly,
                soft: true,
            });
        },
    );

    it("failed（引导失败/进程退出路径）→ restart（qrOnly 决定 forceQr）", () => {
        expect(planRelogin({ state: "failed", uin: "10001", qrOnly: false })).toEqual({
            kind: "restart",
            forceQr: false,
        });
        expect(planRelogin({ state: "failed", uin: "10001", qrOnly: true })).toEqual({
            kind: "restart",
            forceQr: true,
        });
    });
});

/** mock 执行器（记录 sendControl / forceQrRestart 调用）。 */
function makeExecutor(
    sendControlResult = true,
    forceQrResult = true,
): {
    exec: ReloginExecutor;
    controls: IpcControlPayload[];
    forceQrCount: () => number;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
} {
    const controls: IpcControlPayload[] = [];
    let forceQrCalls = 0;
    const info = vi.fn();
    const warn = vi.fn();
    return {
        controls,
        forceQrCount: () => forceQrCalls,
        info,
        warn,
        exec: {
            sendControl: (payload) => {
                controls.push(payload);
                return sendControlResult;
            },
            forceQrRestart: () => {
                forceQrCalls += 1;
                return forceQrResult;
            },
            logger: { info, warn },
        },
    };
}

describe("executeRelogin", () => {
    it("control-login 计划：发出 login 指令（含 uin/qr）", () => {
        const { exec, controls, forceQrCount } = makeExecutor();
        executeRelogin({ kind: "control-login", uin: "10001", qr: true, soft: false }, exec);
        expect(controls).toEqual([{ command: "login", uin: "10001", qr: true }]);
        expect(forceQrCount()).toBe(0);
    });

    it("control-login 软重登（soft=true）：日志区分重装配语义", () => {
        const { exec, controls, info } = makeExecutor();
        executeRelogin({ kind: "control-login", uin: "10001", qr: false, soft: true }, exec);
        expect(controls).toEqual([{ command: "login", uin: "10001", qr: false }]);
        expect(info).toHaveBeenCalledWith(
            "[napuketto] 控制台请求软重登（control login 原地重登 + 重装配）",
        );
    });

    it("control-login 失败（client 不可用）→ 回落 restart 指令", () => {
        const { exec, controls } = makeExecutor(false);
        executeRelogin({ kind: "control-login", uin: "10001", qr: false, soft: true }, exec);
        expect(controls).toEqual([
            { command: "login", uin: "10001", qr: false },
            { command: "restart" },
        ]);
    });

    it("restart + forceQr：走 forceQrRestart（qrOnly 标记 + restart），不发普通 restart", () => {
        const { exec, controls, forceQrCount } = makeExecutor();
        executeRelogin({ kind: "restart", forceQr: true }, exec);
        expect(forceQrCount()).toBe(1);
        expect(controls).toHaveLength(0);
    });

    it("restart + forceQr 但 client 不可用：置标记（forceQrRestart false）打 warn", () => {
        const { exec, forceQrCount, warn } = makeExecutor(true, false);
        executeRelogin({ kind: "restart", forceQr: true }, exec);
        expect(forceQrCount()).toBe(1);
        expect(warn).toHaveBeenCalled();
    });

    it("普通 restart：直接发 restart 指令", () => {
        const { exec, controls } = makeExecutor();
        executeRelogin({ kind: "restart", forceQr: false }, exec);
        expect(controls).toEqual([{ command: "restart" }]);
    });
});
