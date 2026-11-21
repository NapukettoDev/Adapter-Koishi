import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { ElementType } from "@napuketto/kernel";
import { launchSelfHost } from "@napuketto/loader";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeRawMessage, mockH } from "../../events/test-utils.js";
import {
    decodeIpcMessage,
    encodeIpcMessage,
    IPC_VERSION,
    type IpcMessage,
} from "../../ipc/index.js";
import { NapukettoBot } from "../bot.js";

vi.mock("koishi", () => {
    class Bot {
        ctx: unknown;
        config: unknown;
        logger: unknown;
        user = {};
        online = vi.fn();
        offline = vi.fn();
        async stop(): Promise<void> {}
        toJSON = vi.fn();
        dispatch = vi.fn();
        session = (event: object) => ({ ...event });

        constructor(ctx: { logger: unknown }, config: unknown) {
            this.ctx = ctx;
            this.config = config;
            this.logger = ctx.logger;
        }
    }
    class MessageEncoder {}
    return {
        // biome-ignore lint/style/useNamingConvention: 与 Koishi 导出名一致
        Bot,
        // biome-ignore lint/style/useNamingConvention: 与 Koishi 导出名一致
        MessageEncoder,
        h: mockH(),
    };
});
vi.mock("@koishijs/plugin-console", () => {
    class DataService {
        async refresh(): Promise<void> {}
    }
    return {
        // biome-ignore lint/style/useNamingConvention: 与控制台导出名一致
        DataService,
    };
});
vi.mock("../../config.js", () => ({ napukettoConfigSchema: {} }));
vi.mock("@napuketto/loader", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@napuketto/loader")>()),
    resolveQqInstall: vi.fn((qqPath: string) => ({
        qqPath,
        installDir: "test-qq",
        version: "9.9.33-51802",
        wrapperPath: "test-qq/wrapper.node",
        source: "local",
    })),
    launchSelfHost: vi.fn(),
}));

const SELF_ID = "10001";
const RESTART_DELAY_MS = 100;
const selfInfo = { uin: SELF_ID, uid: "u1", nick: "测试账号" };

class IpcChild extends EventEmitter {
    readonly pid = 1000;
    readonly stdout = new PassThrough();
    readonly stderr = null;
    readonly received: IpcMessage[] = [];
    readonly actionResponses = new Map<string, unknown>();
    history: unknown[] = [];
    readonly stdin = new Writable({
        write: (chunk: Buffer, _encoding, done) => {
            const message = decodeIpcMessage(chunk.toString());
            if (message === null) {
                done(new Error("无效的 IPC 行"));
                return;
            }
            this.received.push(message);
            if (message.type === "action") {
                const action = message.payload.action;
                this.send({
                    v: IPC_VERSION,
                    type: "result",
                    id: message.id,
                    payload: {
                        ok: true,
                        value:
                            this.actionResponses.get(action) ??
                            (action === "msg.fetchMessages" ? this.history : true),
                    },
                });
            }
            done();
        },
    });
    readonly kill = vi.fn(() => true);

    send(message: IpcMessage): void {
        this.stdout.write(encodeIpcMessage(message));
    }

    login(payload: Extract<IpcMessage, { type: "login" }>["payload"]): void {
        this.send({ v: IPC_VERSION, type: "login", payload });
    }

    ready(uin = SELF_ID): void {
        this.login({ state: "logged_in", selfInfo: { ...selfInfo, uin } });
        this.send({ v: IPC_VERSION, type: "status", payload: { phase: "ready" } });
    }

    receiveMessage(msgId = "m1", timestamp = Date.now()): void {
        this.send({
            v: IPC_VERSION,
            type: "event",
            payload: {
                service: "Msg",
                name: "onRecvMsg",
                args: [
                    [
                        {
                            msgId,
                            msgSeq: "1",
                            msgTime: String(timestamp),
                            msgType: 9,
                            chatType: 1,
                            peerUid: "u2",
                            peerUin: "20001",
                            senderUid: "u2",
                            senderUin: "20001",
                            elements: [{ elementType: 1, textElement: { content: "test" } }],
                        },
                    ],
                ],
            },
        });
    }
}

function createConsole() {
    const entries = new Set<object>();
    const addEntry = (effects: Set<() => void>) => {
        const entry = {
            dispose() {
                entries.delete(entry);
                effects.delete(entry.dispose);
            },
        };
        entries.add(entry);
        effects.add(entry.dispose);
        return entry;
    };
    const addSharedEntry = vi.fn(addEntry);
    const root = {
        inject(_services: string[], setup: (owner: unknown) => void) {
            const effects = new Set<() => void>();
            setup({ console: { addEntry: () => addSharedEntry(effects) } });
            return {
                dispose() {
                    for (const dispose of effects) {
                        dispose();
                    }
                },
            };
        },
        get: vi.fn(),
        set: () => vi.fn(),
    };
    return { root, entries, addEntry, addSharedEntry };
}

function setupPanel(selfId = SELF_ID, consoleHost = createConsole()) {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), level: 0 };
    const listeners = new Map<string, (data: { selfId: string }) => void>();
    const effects = new Set<() => void>();
    const ctx = {
        baseDir,
        config: { autoAssign: false, autoAuthorize: 0 },
        inject(_services: string[], setup: (fork: unknown) => void) {
            setup(this);
        },
        root: consoleHost.root,
        console: {
            entries: consoleHost.entries,
            addEntry: () => consoleHost.addEntry(effects),
            addListener: (name: string, listener: (data: { selfId: string }) => void) =>
                listeners.set(name, listener),
            ctx: { on: () => vi.fn() },
        },
        on: (event: string, dispose: () => void) => {
            if (event === "dispose") {
                effects.add(dispose);
            }
        },
        logger,
    };
    const bot = new NapukettoBot(ctx as unknown as ConstructorParameters<typeof NapukettoBot>[0], {
        selfId,
        qqPath: "test-qq/QQ.exe",
        restart: { backoffMs: RESTART_DELAY_MS },
    });
    return {
        bot,
        logger,
        dispose() {
            for (const dispose of effects) {
                dispose();
            }
            effects.clear();
            return bot.stop();
        },
        click(action: "refresh-qr" | "relogin" | "qr-login") {
            const handler = listeners.get(`napuketto-login-${selfId}/${action}`);
            if (handler === undefined) {
                throw new Error(`面板事件未注册: ${action}`);
            }
            handler({ selfId });
        },
    };
}

const launch = vi.mocked(launchSelfHost);
let children: IpcChild[];
let baseDir: string;

beforeEach(() => {
    vi.useFakeTimers();
    children = [];
    baseDir = mkdtempSync(join(tmpdir(), "napuketto-console-test-"));
    launch.mockReset().mockImplementation(async () => {
        const child = new IpcChild();
        children.push(child);
        return { child: child as unknown as ChildProcess, bootJsPath: "test-qq/self-host.cjs" };
    });
});

afterEach(() => {
    for (const child of children) {
        child.emit("exit", 0, null);
        child.emit("close");
    }
    vi.clearAllTimers();
    vi.useRealTimers();
    rmSync(baseDir, { recursive: true, force: true });
});

async function startBot(bot: NapukettoBot): Promise<IpcChild> {
    await bot.start();
    await vi.advanceTimersByTimeAsync(0);
    return latestChild();
}

function latestChild(): IpcChild {
    const child = children.at(-1);
    if (child === undefined) {
        throw new Error("子进程未启动");
    }
    return child;
}

describe("控制台事件到子进程 IPC 的接线", () => {
    it("同一控制台的两个在线 Bot 共用入口，最后一个停用后释放，重新启用时恢复", async () => {
        const shared = createConsole();
        const first = setupPanel(SELF_ID, shared);
        const secondId = "10002";
        const second = setupPanel(secondId, shared);
        const firstChild = await startBot(first.bot);
        firstChild.ready();
        const secondChild = await startBot(second.bot);
        secondChild.ready(secondId);
        expect(first.bot.online).toHaveBeenCalledOnce();
        expect(second.bot.online).toHaveBeenCalledOnce();
        expect(shared.entries.size).toBe(1);
        expect(shared.addSharedEntry).toHaveBeenCalledOnce();

        const stopFirst = first.dispose();
        expect(shared.entries.size).toBe(1);
        firstChild.emit("exit", 0, null);
        await stopFirst;
        second.click("refresh-qr");
        expect(secondChild.received.at(-1)).toMatchObject({
            type: "action",
            payload: { action: "login.refreshQr" },
        });

        const stopSecond = second.dispose();
        expect(shared.entries.size).toBe(0);
        const enabledAgain = setupPanel(secondId, shared);
        const starting = enabledAgain.bot.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(launch).toHaveBeenCalledTimes(2);
        expect(shared.entries.size).toBe(1);
        expect(shared.addSharedEntry).toHaveBeenCalledTimes(2);
        secondChild.emit("exit", 0, null);
        await Promise.all([stopSecond, starting]);
        await vi.advanceTimersByTimeAsync(0);
        expect(launch).toHaveBeenCalledTimes(3);
        latestChild().ready(secondId);
        expect(enabledAgain.bot.online).toHaveBeenCalledOnce();
        expect(shared.entries.size).toBe(1);
    });

    it("业务客户端尚未绑定时，可刷新二维码、重新登录和原地强制扫码", async () => {
        const { bot, click, logger } = setupPanel();
        const child = await startBot(bot);
        child.login({ state: "waiting_scan" });
        expect(bot["driver"]?.currentState).toBe("booting");
        expect(bot["driver"]?.currentClient).not.toBeNull();
        expect(bot["clientRef"].current).toBeNull();
        await expect(bot.deleteMessage("private:20001", "1")).rejects.toThrow("子进程未就绪");

        click("refresh-qr");
        click("relogin");
        click("qr-login");
        expect(
            child.received.map((message) => [
                message.type,
                "payload" in message ? message.payload : undefined,
            ]),
        ).toEqual([
            ["action", { action: "login.refreshQr" }],
            ["control", { command: "login", uin: SELF_ID, qr: false }],
            ["control", { command: "login", uin: SELF_ID, qr: true }],
        ]);
        await vi.advanceTimersByTimeAsync(0);
        expect(logger.info).toHaveBeenCalledWith("[napuketto] 刷新二维码: %s", "已触发新二维码");
        expect(bot["qrOnlyRef"].current).toBe(false);
    });

    it("failed 时通过仍在引导的连接重启，后续启动只消费一次扫码标记", async () => {
        const { bot, click } = setupPanel();
        const first = await startBot(bot);
        first.login({ state: "failed" });

        click("qr-login");
        expect(first.received).toEqual([
            { v: IPC_VERSION, type: "control", payload: { command: "restart" } },
        ]);
        first.emit("exit", 0, null);
        await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS);
        const second = latestChild();
        expect(second).not.toBe(first);
        expect(launch).toHaveBeenLastCalledWith(expect.objectContaining({ qrOnly: true }));

        second.emit("exit", 1, null);
        await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS * 2);
        expect(launch).toHaveBeenCalledTimes(3);
        expect(launch.mock.lastCall?.[0]).not.toHaveProperty("qrOnly");
    });

    it("ready 后普通重登与扫码都走软重登，重启后切换到新连接", async () => {
        const { bot, click } = setupPanel();
        const first = await startBot(bot);
        first.ready();
        expect(bot.online).toHaveBeenCalledOnce();

        click("relogin");
        click("qr-login");
        expect(
            first.received.map((message) => ("payload" in message ? message.payload : undefined)),
        ).toEqual([
            { command: "login", uin: SELF_ID, qr: false },
            { command: "login", uin: SELF_ID, qr: true },
        ]);

        first.emit("exit", 1, null);
        click("relogin");
        await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS);
        const second = latestChild();
        second.login({ state: "scanned" });
        click("refresh-qr");
        click("relogin");
        expect(
            second.received.map((message) => ("payload" in message ? message.payload : undefined)),
        ).toEqual([{ action: "login.refreshQr" }, { command: "login", uin: SELF_ID, qr: false }]);
        expect(first.received).toHaveLength(2);
        expect(launch.mock.lastCall?.[0]).not.toHaveProperty("qrOnly");
    });

    it("连接关闭后各入口反馈失败，扫码保留给下次启动", async () => {
        const { bot, click, logger } = setupPanel();
        const child = await startBot(bot);
        child.login({ state: "waiting_scan" });
        child.emit("close");

        click("refresh-qr");
        click("relogin");
        click("qr-login");
        await vi.advanceTimersByTimeAsync(0);
        expect(child.received).toEqual([]);
        expect(logger.warn).toHaveBeenCalledWith(
            "[napuketto] 刷新二维码失败: %o",
            expect.objectContaining({
                code: "CLOSED",
                message: expect.stringContaining("子进程未就绪"),
            }),
        );
        expect(logger.warn).toHaveBeenCalledWith("[napuketto] 子进程未就绪，无法重新登录");
        expect(logger.warn).toHaveBeenCalledWith("[napuketto] 子进程未就绪，已标记下次启动时扫码");

        child.emit("exit", 1, null);
        await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS);
        expect(launch).toHaveBeenLastCalledWith(expect.objectContaining({ qrOnly: true }));
    });

    it("消息和业务动作等待 ready，软重登换账号后中止业务和面板连接", async () => {
        const { bot, click } = setupPanel();
        const child = await startBot(bot);
        child.receiveMessage("old", Date.now() - 60_000);
        child.receiveMessage();
        await vi.advanceTimersByTimeAsync(0);
        expect(bot.dispatch).not.toHaveBeenCalled();

        child.ready();
        await vi.advanceTimersByTimeAsync(0);
        expect(bot.dispatch).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ messageId: "m1" }),
        );
        await bot.deleteMessage("private:20001", "1");
        expect(child.received.at(-1)).toMatchObject({
            type: "action",
            payload: { action: "msg.recallMessage" },
        });

        click("qr-login");
        child.login({ state: "logged_in", selfInfo: { ...selfInfo, uin: "20002" } });
        const sent = child.received.length;
        expect(child.received.at(-1)).toMatchObject({
            type: "control",
            payload: { command: "stop" },
        });

        await expect(bot.deleteMessage("private:20001", "1")).rejects.toThrow("子进程未就绪");
        click("relogin");
        child.receiveMessage();
        await vi.advanceTimersByTimeAsync(0);
        expect(bot.dispatch).toHaveBeenCalledTimes(1);
        expect(child.received).toHaveLength(sent);
    });

    it.each([new Map([[0, "thumb.jpg"]]), { "0": "thumb.jpg" }])(
        "IPC JSON 往返后，含视频的整条消息仍会在 ready 后派发",
        async (thumbPath) => {
            const { bot } = setupPanel();
            const child = await startBot(bot);
            const raw = makeRawMessage({
                msgId: "with-video",
                msgTime: String(Date.now()),
                elements: [
                    { elementType: ElementType.TEXT, textElement: { content: "前缀" } },
                    {
                        elementType: ElementType.VIDEO,
                        videoElement: { filePath: "video.mp4", thumbPath },
                    },
                    { elementType: ElementType.TEXT, textElement: { content: "后缀" } },
                ],
            });
            child.send({
                v: IPC_VERSION,
                type: "event",
                payload: { service: "Msg", name: "onRecvMsg", args: [[raw]] },
            });
            await vi.advanceTimersByTimeAsync(0);
            expect(bot.dispatch).not.toHaveBeenCalled();

            child.ready();
            await vi.advanceTimersByTimeAsync(0);

            expect(bot.dispatch).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({
                    messageId: "with-video",
                    elements: ["前缀", "[video]", "后缀"].map((content) =>
                        expect.objectContaining({ type: "text", attrs: { content } }),
                    ),
                }),
            );
        },
    );

    it("Bot 的历史查询透传分页参数并返回旧消息", async () => {
        const { bot } = setupPanel();
        const child = await startBot(bot);
        child.history = [
            makeRawMessage({ msgId: "newer", msgTime: "1700000002" }),
            makeRawMessage({ msgId: "older", msgTime: "1700000001" }),
            makeRawMessage({ msgId: "oldest", msgTime: "1700000000" }),
        ];
        child.ready();

        const page = await bot.getMessageList("10001", "anchor", "before", 2, "desc");
        expect(child.received.at(-1)).toMatchObject({
            type: "action",
            payload: {
                action: "msg.fetchMessages",
                params: { chatType: 2, peerUin: "10001", count: 4, msgId: "anchor" },
            },
        });
        expect(page.data).toMatchObject([
            { id: "newer", content: "你好", createdAt: 1_700_000_002_000 },
            { id: "older", content: "你好", createdAt: 1_700_000_001_000 },
        ]);
        expect(page.next).toBe("older");
        expect(bot.dispatch).not.toHaveBeenCalled();
    });
});

describe("Koishi 标准动作到子进程 IPC 的接线", () => {
    const groupId = "50001";
    const userId = "20001";
    const group = Number(groupId);
    const user = Number(userId);
    const member = {
        group_id: group,
        user_id: user,
        nickname: "昵称",
        card: "群名片",
        title: "头衔",
        role: "admin",
        join_time: 1_700_000_000,
    };
    const memberResult = {
        user: { id: userId, name: "昵称" },
        nick: "群名片",
        title: "头衔",
        roles: [{ id: "admin" }],
        joinedAt: 1_700_000_000_000,
    };

    async function startReadyBot() {
        const { bot } = setupPanel();
        const child = await startBot(bot);
        child.ready();
        const respond = (action: string, data: unknown) => {
            child.actionResponses.set(action, { status: "ok", retcode: 0, data });
        };
        const expectAction = (action: string, params?: Record<string, unknown>) => {
            const last = child.received.at(-1);
            expect(last?.type === "action" ? last.payload : undefined).toEqual(
                params === undefined ? { action } : { action, params },
            );
        };
        return { bot, child, respond, expectAction };
    }

    it("读取用户资料或指定群内的用户，保留 QQ 号和昵称", async () => {
        const { bot, respond, expectAction } = await startReadyBot();
        respond("get_stranger_info", { user_id: user, nickname: "QQ 昵称" });
        respond("get_group_member_info", member);

        await expect(bot.getUser(userId)).resolves.toEqual({ id: userId, name: "QQ 昵称" });
        expectAction("get_stranger_info", { user_id: user });
        await expect(bot.getUser(userId, groupId)).resolves.toEqual(memberResult.user);
        expectAction("get_group_member_info", { group_id: group, user_id: user });
        respond("get_stranger_info", { user_id: user, nickname: "" });
        await expect(bot.getUser(userId)).resolves.toEqual({ id: userId, name: userId });
    });

    it("读取成员及单页成员列表，过滤无法解析 QQ 号的成员", async () => {
        const { bot, respond, expectAction } = await startReadyBot();
        respond("get_group_member_info", member);
        respond("get_group_member_list", [member, { ...member, user_id: Number.NaN }]);

        await expect(bot.getGuildMember(groupId, userId)).resolves.toEqual(memberResult);
        expectAction("get_group_member_info", { group_id: group, user_id: user });
        await expect(bot.getGuildMemberList(groupId)).resolves.toEqual({ data: [memberResult] });
        expectAction("get_group_member_list", { group_id: group });
        respond("get_group_member_list", []);
        await expect(bot.getGuildMemberList(groupId)).resolves.toEqual({ data: [] });
    });

    it("群频道查询只返回指定群的文本频道，缺失时报告 NOT_FOUND", async () => {
        const { bot, child, expectAction } = await startReadyBot();
        child.actionResponses.set("group.getGroupList", [
            { groupCode: "50002", groupName: "其他群" },
            { groupCode: groupId, groupName: "目标群" },
        ]);

        await expect(bot.getChannelList(groupId)).resolves.toEqual({
            data: [{ id: groupId, name: "目标群", type: 0 }],
        });
        expectAction("group.getGroupList");
        await expect(bot.getChannelList("50003")).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("只在永久踢人时设置拒绝再次入群", async () => {
        const { bot, respond, expectAction } = await startReadyBot();
        respond("set_group_kick", null);

        await expect(bot.kickGuildMember(groupId, userId)).resolves.toBeUndefined();
        expectAction("set_group_kick", {
            group_id: group,
            user_id: user,
            reject_add_request: false,
        });
        await expect(bot.kickGuildMember(groupId, userId, true)).resolves.toBeUndefined();
        expectAction("set_group_kick", {
            group_id: group,
            user_id: user,
            reject_add_request: true,
        });
    });

    it.each([
        [30_000, 30],
        [1_001, 2],
        [1, 1],
        [0, 0],
    ])("禁言 %i 毫秒对应 %i 秒，零值解除禁言", async (duration, seconds) => {
        const { bot, respond, expectAction } = await startReadyBot();
        respond("set_group_ban", null);

        await expect(
            bot.muteGuildMember(groupId, userId, duration, "群管理说明"),
        ).resolves.toBeUndefined();
        expectAction("set_group_ban", { group_id: group, user_id: user, duration: seconds });
    });

    it("在发送 IPC 之前拒绝非法 QQ 号、分页令牌和时长", async () => {
        const { bot, child } = await startReadyBot();
        const sent = child.received.length;

        await expect(bot.getUser("9007199254740993")).rejects.toMatchObject({
            code: "INVALID_PARAM",
        });
        await expect(bot.kickGuildMember("1e5", userId)).rejects.toMatchObject({
            code: "INVALID_PARAM",
        });
        await expect(bot.getGuildMemberList(groupId, "extra")).rejects.toMatchObject({
            code: "INVALID_PARAM",
        });
        await expect(bot.getChannelList(groupId, "extra")).rejects.toMatchObject({
            code: "INVALID_PARAM",
        });
        for (const duration of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
            await expect(bot.muteGuildMember(groupId, userId, duration)).rejects.toMatchObject({
                code: "INVALID_PARAM",
            });
        }
        expect(child.received).toHaveLength(sent);
    });

    it("拒绝 OB11 权限及资源失败、错误标识和异常响应", async () => {
        const { bot, child, respond } = await startReadyBot();
        child.actionResponses.set("set_group_kick", { status: "failed", retcode: 101, data: null });
        child.actionResponses.set("get_stranger_info", {
            status: "failed",
            retcode: 102,
            data: null,
        });

        await expect(bot.kickGuildMember(groupId, userId)).rejects.toMatchObject({ code: "101" });
        await expect(bot.getUser(userId)).rejects.toMatchObject({ code: "102" });
        respond("get_group_member_info", { ...member, user_id: user + 1 });
        await expect(bot.getGuildMember(groupId, userId)).rejects.toMatchObject({
            code: "INVALID_RESPONSE",
        });
        respond("get_group_member_list", [{ ...member, group_id: group + 1 }]);
        await expect(bot.getGuildMemberList(groupId)).rejects.toMatchObject({
            code: "INVALID_RESPONSE",
        });
        await expect(bot.muteGuildMember(groupId, userId, 5000)).rejects.toMatchObject({
            code: "INVALID_RESPONSE",
        });
    });

    it.each([
        {
            event: { request_type: "friend", flag: "0000700" },
            type: "friend-request",
            method: "handleFriendRequest",
            action: "set_friend_add_request",
            params: { flag: "0000700", approve: true, remark: "审批说明" },
        },
        {
            event: {
                request_type: "group",
                sub_type: "add",
                group_id: group,
                flag: "90071992547409930",
            },
            type: "guild-member-request",
            method: "handleGuildMemberRequest",
            action: "set_group_add_request",
            params: { flag: "90071992547409930", approve: false, reason: "审批说明" },
        },
    ] as const)(
        "用 $type Session 的 messageId 调用标准审批方法",
        async ({ event, type, method, action, params }) => {
            const { bot, child, respond, expectAction } = await startReadyBot();
            respond(action, null);
            child.send({
                v: IPC_VERSION,
                type: "event",
                payload: {
                    service: "ob11",
                    name: "request",
                    args: [
                        { post_type: "request", self_id: Number(SELF_ID), user_id: user, ...event },
                    ],
                },
            });
            await vi.advanceTimersByTimeAsync(0);
            const [session] = vi.mocked(bot.dispatch).mock.lastCall ?? [];
            expect(session).toMatchObject({ type, messageId: event.flag });
            if (session?.messageId === undefined) {
                throw new Error("Koishi 请求 Session 缺少 messageId");
            }
            await expect(
                bot[method](session.messageId, params.approve, "审批说明"),
            ).resolves.toBeUndefined();
            expectAction(action, params);
        },
    );
});
