import { describe, expect, it, vi } from "vitest";
import { MemoryLinePair } from "../../__test-utils__/ipc.js";
import { NapukettoIpcClient } from "../../ipc/index.js";
import { NapukettoLoginState } from "../../login/index.js";
import { BOT_STATUS } from "../../shared/protocol.js";
import { BotLifecycleController } from "../lifecycle.js";

type LifecycleHost = ConstructorParameters<typeof BotLifecycleController>[0];
const SELF = { uin: "10001", uid: "u1", nick: "当前账号" };

function setup() {
    const login = new NapukettoLoginState();
    const bridge = { handle: vi.fn(), resetMessageBaseline: vi.fn() };
    const bot = {
        status: 0,
        get isActive() {
            return this.status !== 0 && this.status !== BOT_STATUS.DISCONNECT;
        },
        online: vi.fn(() => {
            bot.status = 1;
        }),
        offline: vi.fn(() => {
            bot.status = 0;
        }),
        getLogin: vi
            .fn<LifecycleHost["bot"]["getLogin"]>()
            .mockRejectedValue(new Error("测试夹具未查询宿主")),
    };
    const createDriver = vi.fn<LifecycleHost["createDriver"]>((events) => {
        const client = new NapukettoIpcClient(new MemoryLinePair());
        return {
            start: vi.fn(() => {
                events.onLogin?.({ state: "logged_in", selfInfo: SELF });
            }),
            stop: vi.fn(async () => client.close()),
            restartLogin: vi.fn(() => true),
            currentState: "ready",
            currentClient: client,
        };
    });
    const lifecycle = new BotLifecycleController({
        bot,
        login,
        logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
        getBridge: () => bridge,
        getSelfId: () => SELF.uin,
        stopBot: async () => {
            bot.status = 0;
        },
        syncUser: vi.fn(),
        createDriver,
    });
    return { lifecycle, createDriver, bot, login, bridge };
}

describe("BotLifecycleController", () => {
    it("start 等待旧驱动确认退出后创建新一轮", async () => {
        const { lifecycle, createDriver } = setup();
        await lifecycle.start();
        const first = createDriver.mock.results[0]?.value;
        if (first === undefined) {
            throw new Error("首轮驱动缺失");
        }
        const exited = Promise.withResolvers<void>();
        const stop = vi.spyOn(first, "stop").mockReturnValue(exited.promise);
        const stopping = lifecycle.stop();
        const starting = lifecycle.start();
        expect(createDriver).toHaveBeenCalledOnce();
        exited.resolve();
        await Promise.all([stopping, starting]);
        expect(createDriver).toHaveBeenCalledTimes(2);
        expect(stop).toHaveBeenCalledOnce();
        expect(lifecycle.loginClient).not.toBe(first.currentClient);
        await lifecycle.stop();
    });

    it("新的 stop 使等待中的 start 失效", async () => {
        const { lifecycle, createDriver, bot } = setup();
        await lifecycle.start();
        const first = createDriver.mock.results[0]?.value;
        if (first === undefined) {
            throw new Error("首轮驱动缺失");
        }
        const exited = Promise.withResolvers<void>();
        const stop = vi.spyOn(first, "stop").mockReturnValue(exited.promise);
        const stopping = lifecycle.stop();
        const starting = lifecycle.start();
        const stoppingAgain = lifecycle.stop();
        exited.resolve();
        await Promise.all([stopping, starting, stoppingAgain]);
        expect(stop).toHaveBeenCalledOnce();
        expect(createDriver).toHaveBeenCalledOnce();
        expect(lifecycle.loginClient).toBeNull();
        expect(bot.status).toBe(0);
    });

    it("停止期间处理本轮错误，新一轮开始后丢弃旧驱动回调", async () => {
        const { lifecycle, createDriver, bot, login, bridge } = setup();
        await lifecycle.start();
        const first = createDriver.mock.calls[0]?.[0];
        const stopping = lifecycle.stop();
        const stopError = new Error("退出超时");
        first?.onError?.(stopError);
        expect(bot.offline).toHaveBeenCalledExactlyOnceWith(stopError);
        await stopping;

        await lifecycle.start();
        const second = createDriver.mock.calls[1]?.[0];
        second?.onReady?.();
        const client = lifecycle.client;
        expect(client).not.toBeNull();

        first?.onExit?.({ code: 1, signal: null, reason: "crash" });
        first?.onError?.(new Error("迟到的错误"));
        first?.onReady?.();
        first?.onEventSubscription?.();
        first?.onLogin?.({ state: "logged_in", selfInfo: { ...SELF, uin: "20002" } });

        expect(bot.offline).toHaveBeenCalledOnce();
        expect(bot.online).toHaveBeenCalledOnce();
        expect(bridge.resetMessageBaseline).not.toHaveBeenCalled();
        expect(lifecycle.client).toBe(client);
        expect(login.snapshot.self).toEqual(SELF);
        await lifecycle.stop();
    });
});
