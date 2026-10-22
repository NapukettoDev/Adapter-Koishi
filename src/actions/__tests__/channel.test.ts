/**
 * channel.test.ts：channelId 解析单测（docs/internals/actions.md）。
 */

import { describe, expect, it } from "vitest";
import { parseChannelId } from "../channel.js";

describe("parseChannelId", () => {
    it("群号 → chatType=2 GROUP", () => {
        expect(parseChannelId("123456789")).toEqual({ chatType: 2, peerUin: "123456789" });
    });

    it("private: + uin → chatType=1 C2C", () => {
        expect(parseChannelId("private:10001")).toEqual({ chatType: 1, peerUin: "10001" });
    });

    it("private: + uin + guildId → chatType=100 TEMP", () => {
        expect(parseChannelId("private:10001", "99999")).toEqual({
            chatType: 100,
            peerUin: "10001",
        });
    });

    it("空 guildId 不触发 TEMP", () => {
        expect(parseChannelId("private:10001", "")).toEqual({ chatType: 1, peerUin: "10001" });
    });
});
