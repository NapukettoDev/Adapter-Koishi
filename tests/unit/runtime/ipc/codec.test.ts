/**
 * codec.test.ts：编解码单测（roundtrip / 非法输入兜底）。
 */

import { IPC_VERSION } from "@napuketto/loader";
import { describe, expect, it } from "vitest";
import {
    decodeIpcMessage,
    encodeIpcMessage,
    type IpcMessage,
} from "../../../../src/runtime/ipc/index.js";

describe("codec", () => {
    it("encode/decode roundtrip", () => {
        const message = {
            v: IPC_VERSION,
            type: "event",
            payload: { service: "Msg", name: "onRecvMsg", args: [{ msgId: 1 }] },
        } satisfies IpcMessage;
        const line = encodeIpcMessage(message);
        expect(line.endsWith("\n")).toBe(true);
        expect(decodeIpcMessage(line)).toEqual(message);
    });

    it("decode 非法输入返回 null", () => {
        expect(decodeIpcMessage("")).toBeNull();
        expect(decodeIpcMessage("   ")).toBeNull();
        expect(decodeIpcMessage("not json")).toBeNull();
        expect(decodeIpcMessage('{"v":1,"type":"nope"}')).toBeNull();
        expect(decodeIpcMessage('{"v":999,"type":"ping"}')).toBeNull();
        expect(decodeIpcMessage("[1,2,3]")).toBeNull();
    });

    it("decode control status 查询指令（状态重同步，2026-09-06）", () => {
        const line = encodeIpcMessage({
            v: IPC_VERSION,
            type: "control",
            payload: { command: "status" },
        });
        expect(decodeIpcMessage(line)).toEqual({
            v: IPC_VERSION,
            type: "control",
            payload: { command: "status" },
        });
    });
});
