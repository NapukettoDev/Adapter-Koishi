/**
 * driver-events.test.ts：buildDriverEvents 单测（自 bot.ts setupDriver 拆出的接线工厂）。
 *
 * driver-events.ts 全 type-only import（Logger/DriverEvents 均 import type），
 * 运行时零 koishi 依赖——可直接单测。覆盖：onStatus 日志 / onLogin/onQr 转发 +
 * logged_in 补位校验触发（2026-09-10 补）/ onEvent 桥转发 + 日志 / onReady /
 * onExit（主动断开不 offline，非主动 offline）/ onError（Error 直传、非 Error
 * 包装）/ onLog 日志。
 */

import type { Logger } from "koishi";
import { describe, expect, it, vi } from "vitest";
import { buildDriverEvents, type DriverEventsHost } from "../driver-events.js";

/** 构造 mock host，返回 host + 可断言的 mock 引用。 */
function createHost(overrides: { isDisconnected?: () => boolean; isCurrent?: () => boolean } = {}) {
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const login = { onLogin: vi.fn(), onQr: vi.fn(), onExit: vi.fn() };
    const bridge = { handle: vi.fn(), resetMessageBaseline: vi.fn() };
    const handleReady = vi.fn();
    const clearClient = vi.fn();
    const offline = vi.fn();
    const onLoggedIn = vi.fn();
    const host: DriverEventsHost = {
        logger: logger as unknown as Logger,
        login: login as unknown as DriverEventsHost["login"],
        bridge: bridge as unknown as DriverEventsHost["bridge"],
        isDisconnected: overrides.isDisconnected ?? (() => false),
        handleReady,
        handleLoginRestart: vi.fn(),
        clearClient,
        offline,
        onLoggedIn,
        ...(overrides.isCurrent !== undefined ? { isCurrent: overrides.isCurrent } : {}),
    };
    return { host, logger, login, bridge, handleReady, clearClient, offline, onLoggedIn };
}

describe("buildDriverEvents", () => {
    it("onStatus → logger.debug 带引导阶段", () => {
        const { host, logger } = createHost();
        const events = buildDriverEvents(host);
        events.onStatus?.({ phase: "booting" });
        expect(logger.debug).toHaveBeenCalledWith("[napuketto] 引导阶段: %s", "booting");
    });

    it("onLogin → login.onLogin 转发（state/selfInfo/message）", () => {
        const { host, login } = createHost();
        const events = buildDriverEvents(host);
        const payload = {
            state: "logged_in",
            selfInfo: { uin: "1", uid: "u1", nick: "n" },
        } as const;
        events.onLogin?.(payload);
        expect(login.onLogin).toHaveBeenCalledWith("logged_in", payload.selfInfo, undefined);
    });

    it("onLogin logged_in 携带 selfInfo → onLoggedIn 补位校验转发（软重登换账号检测）", () => {
        const { host, onLoggedIn } = createHost();
        const events = buildDriverEvents(host);
        const selfInfo = { uin: "1", uid: "u1", nick: "n" };
        events.onLogin?.({ state: "logged_in", selfInfo });
        expect(onLoggedIn).toHaveBeenCalledTimes(1);
        expect(onLoggedIn).toHaveBeenCalledWith(selfInfo);
    });

    it("onLogin 非 logged_in（waiting_scan）即使带 selfInfo 也不触发补位校验", () => {
        const { host, onLoggedIn } = createHost();
        const events = buildDriverEvents(host);
        events.onLogin?.({
            state: "waiting_scan",
            selfInfo: { uin: "1", uid: "u1", nick: "n" },
        });
        expect(onLoggedIn).not.toHaveBeenCalled();
    });

    it("onLogin logged_in 但无 selfInfo（快登直通等）不触发补位校验", () => {
        const { host, onLoggedIn } = createHost();
        const events = buildDriverEvents(host);
        events.onLogin?.({ state: "logged_in" });
        expect(onLoggedIn).not.toHaveBeenCalled();
    });

    it("onQr → login.onQr 转发", () => {
        const { host, login } = createHost();
        const events = buildDriverEvents(host);
        const qr = { pngBase64: "aGk=", qrcodeUrl: "https://x" };
        events.onQr?.(qr);
        expect(login.onQr).toHaveBeenCalledWith(qr);
    });

    it("订阅新事件源时刷新事件桥的历史过滤基准", () => {
        const { host, bridge } = createHost();
        buildDriverEvents(host).onEventSubscription?.();
        expect(bridge.resetMessageBaseline).toHaveBeenCalledOnce();
    });

    it("onEvent → bridge.handle 转发 + logger.debug", () => {
        const { host, bridge, logger } = createHost();
        const events = buildDriverEvents(host);
        const payload = { service: "Msg", name: "onRecvMsg", args: [] };
        events.onEvent?.(payload);
        expect(bridge.handle).toHaveBeenCalledWith(payload);
        expect(logger.debug).toHaveBeenCalledWith(
            "[napuketto] 收到事件: %s/%s args=%d",
            "Msg",
            "onRecvMsg",
            0,
        );
    });

    it("onReady → handleReady", () => {
        const { host, handleReady } = createHost();
        const events = buildDriverEvents(host);
        events.onReady?.();
        expect(handleReady).toHaveBeenCalledTimes(1);
    });

    it("onExit 主动断开（isDisconnected=true）→ login.onExit，不 offline", () => {
        const { host, login, clearClient, offline } = createHost({ isDisconnected: () => true });
        const events = buildDriverEvents(host);
        events.onExit?.({ code: 0, signal: null, reason: "stop" });
        expect(login.onExit).toHaveBeenCalledTimes(1);
        expect(clearClient).toHaveBeenCalledBefore(login.onExit);
        expect(offline).not.toHaveBeenCalled();
    });

    it("onExit 非主动退出 → login.onExit + offline（驱动崩溃/失联）", () => {
        const { host, login, clearClient, offline } = createHost();
        const events = buildDriverEvents(host);
        events.onExit?.({ code: 1, signal: null, reason: "crash" });
        expect(login.onExit).toHaveBeenCalledTimes(1);
        expect(offline).toHaveBeenCalledTimes(1);
        expect(clearClient).toHaveBeenCalledBefore(offline);
    });

    it("onError Error 实例 → 原样传给 offline + warn 日志", () => {
        const { host, offline, logger } = createHost();
        const events = buildDriverEvents(host);
        const error = new Error("spawn 失败");
        events.onError?.(error);
        expect(offline).toHaveBeenCalledWith(error);
        expect(logger.warn).toHaveBeenCalledWith("[napuketto] 驱动错误: %o", error);
    });

    it("onError 非 Error → 包装为 Error 传给 offline", () => {
        const { host, offline } = createHost();
        const events = buildDriverEvents(host);
        events.onError?.("boom");
        const [arg] = offline.mock.calls[0] ?? [];
        expect(arg).toBeInstanceOf(Error);
        expect((arg as Error).message).toBe("boom");
    });

    it("onIpcWriteError 将底层错误原样写入日志，交由宿主退出事件处理下线", () => {
        const { host, logger, offline } = createHost();
        const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
        buildDriverEvents(host).onIpcWriteError?.(error);
        expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
            "[napuketto] IPC stdin 写入失败: %o",
            error,
        );
        expect(offline).not.toHaveBeenCalled();
    });

    it("onLog → logger.debug 带子进程消息", () => {
        const { host, logger } = createHost();
        const events = buildDriverEvents(host);
        events.onLog?.({ level: "debug", message: "kernel ready" });
        expect(logger.debug).toHaveBeenCalledWith("[napuketto 子进程] %s", "kernel ready");
    });

    it("isCurrent=false 时丢弃旧 driver 的全部迟到回调", () => {
        const { host, logger, login, bridge, handleReady, clearClient, offline, onLoggedIn } =
            createHost({ isCurrent: () => false });
        const events = buildDriverEvents(host);
        events.onStatus?.({ phase: "ready" });
        events.onLogin?.({ state: "logged_in", selfInfo: { uin: "2", uid: "u", nick: "n" } });
        events.onQr?.({ pngBase64: "aGk=", qrcodeUrl: "https://x" });
        events.onEventSubscription?.();
        events.onEvent?.({ service: "Msg", name: "onRecvMsg", args: [] });
        events.onReady?.();
        events.onExit?.({ code: 1, signal: null, reason: "crash" });
        events.onError?.(new Error("late"));
        events.onIpcWriteError?.(new Error("late write"));
        events.onLog?.({ level: "debug", message: "late" });

        expect(logger.debug).not.toHaveBeenCalled();
        expect(logger.warn).not.toHaveBeenCalled();
        expect(login.onLogin).not.toHaveBeenCalled();
        expect(login.onQr).not.toHaveBeenCalled();
        expect(login.onExit).not.toHaveBeenCalled();
        expect(bridge.resetMessageBaseline).not.toHaveBeenCalled();
        expect(bridge.handle).not.toHaveBeenCalled();
        expect(handleReady).not.toHaveBeenCalled();
        expect(clearClient).not.toHaveBeenCalled();
        expect(offline).not.toHaveBeenCalled();
        expect(onLoggedIn).not.toHaveBeenCalled();
    });
});
