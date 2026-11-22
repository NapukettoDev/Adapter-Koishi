/**
 * login-actions.test.ts：重新登录与强制扫码的通道决策和执行。
 */
import type { LoginState } from "@napuketto/kernel";
import type { IpcControlPayload } from "@napuketto/loader";
import { describe, expect, it, vi } from "vitest";
import { executeRelogin, planRelogin, type ReloginExecutor } from "../../../src/console/panel.js";

describe("planRelogin", () => {
    it.each(["idle", "waiting_scan", "scanned"] as LoginState[])(
        "登录期（%s）→ control login（qrOnly 决定 qr）",
        (state) => {
            expect(planRelogin({ state, uin: "10001", qrOnly: false })).toEqual({
                kind: "control-login",
                uin: "10001",
                qr: false,
            });
            expect(planRelogin({ state, uin: "10001", qrOnly: true })).toEqual({
                kind: "control-login",
                uin: "10001",
                qr: true,
            });
        },
    );

    it.each(["logged_in", "failed"] as const)("%s → 重启宿主，保留扫码选择", (state) => {
        expect(planRelogin({ state, uin: "10001", qrOnly: false })).toEqual({
            kind: "restart",
            forceQr: false,
        });
        expect(planRelogin({ state, uin: "10001", qrOnly: true })).toEqual({
            kind: "restart",
            forceQr: true,
        });
    });
});

function makeExecutor(sendControlResult = true, restartResult = true) {
    return {
        sendControl: vi.fn((_payload: IpcControlPayload) => sendControlResult),
        restart: vi.fn((_forceQr: boolean) => restartResult),
        logger: { info: vi.fn(), warn: vi.fn() },
    } satisfies ReloginExecutor;
}

describe("executeRelogin", () => {
    it("control-login 计划：发出 login 指令（含 uin/qr）", () => {
        const exec = makeExecutor();
        executeRelogin({ kind: "control-login", uin: "10001", qr: true }, exec);
        expect(exec.sendControl).toHaveBeenCalledExactlyOnceWith({
            command: "login",
            uin: "10001",
            qr: true,
        });
        expect(exec.restart).not.toHaveBeenCalled();
    });

    it("control-login 失败（client 不可用）→ 回落 restart 指令", () => {
        const exec = makeExecutor(false);
        executeRelogin({ kind: "control-login", uin: "10001", qr: false }, exec);
        expect(exec.sendControl).toHaveBeenCalledBefore(exec.restart);
        expect(exec.restart).toHaveBeenCalledExactlyOnceWith(false);
    });

    it("强制扫码时连接不可用，仍传入扫码标记并告警", () => {
        const exec = makeExecutor(true, false);
        executeRelogin({ kind: "restart", forceQr: true }, exec);
        expect(exec.restart).toHaveBeenCalledExactlyOnceWith(true);
        expect(exec.logger.warn).toHaveBeenCalled();
    });

    it.each([false, true])("重启计划直接请求重启（forceQr=%s）", (forceQr) => {
        const exec = makeExecutor();
        executeRelogin({ kind: "restart", forceQr }, exec);
        expect(exec.restart).toHaveBeenCalledExactlyOnceWith(forceQr);
        expect(exec.sendControl).not.toHaveBeenCalled();
    });
});
