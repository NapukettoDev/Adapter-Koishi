import { isRecord } from "@napuketto/kernel";
import type { Universal } from "koishi";
import { IpcError } from "../shared/errors.js";
import { normalizeMessageTime } from "../shared/protocol.js";

export function toOb11QqNumber(id: string): number {
    const value = Number(id);
    if (!Number.isSafeInteger(value) || value <= 0 || String(value) !== id) {
        throw new IpcError("QQ 号或群号必须是安全范围内的正整数字符串", "INVALID_PARAM");
    }
    return value;
}

export function requireFirstPage(next?: string): void {
    if (next !== undefined && next !== "") {
        throw new IpcError("此列表没有分页令牌", "INVALID_PARAM");
    }
}

function readUser(data: Record<string, unknown>, expectedId?: number): Universal.User {
    const id = data["user_id"];
    if (
        typeof id !== "number" ||
        !Number.isSafeInteger(id) ||
        id <= 0 ||
        (expectedId !== undefined && id !== expectedId)
    ) {
        throw new IpcError("OB11 用户标识无效", "INVALID_RESPONSE");
    }
    const nickname = data["nickname"];
    return {
        id: String(id),
        name: typeof nickname === "string" && nickname !== "" ? nickname : String(id),
    };
}

export function readOb11User(data: unknown, userId: number): Universal.User {
    if (!isRecord(data)) {
        throw new IpcError("OB11 用户资料格式无效", "INVALID_RESPONSE");
    }
    return readUser(data, userId);
}

function readGroupRecord(data: unknown, guildId: number): Record<string, unknown> {
    if (!isRecord(data) || data["group_id"] !== guildId) {
        throw new IpcError("OB11 群成员资料的群标识无效", "INVALID_RESPONSE");
    }
    return data;
}

function readMember(
    data: Record<string, unknown>,
    expectedId?: number,
): Universal.GuildMember & { user: Universal.User } {
    const card = data["card"];
    const title = data["title"];
    const role = data["role"];
    const joinedAt = normalizeMessageTime(data["join_time"]);
    return {
        user: readUser(data, expectedId),
        ...(typeof card === "string" && card !== "" ? { nick: card } : {}),
        ...(typeof title === "string" && title !== "" ? { title } : {}),
        ...(role === "owner" || role === "admin" || role === "member"
            ? { roles: [{ id: role }] }
            : {}),
        ...(joinedAt !== undefined ? { joinedAt } : {}),
    };
}

export function readOb11Member(data: unknown, guildId: number, userId: number) {
    return readMember(readGroupRecord(data, guildId), userId);
}

export function readOb11MemberList(
    data: unknown,
    guildId: number,
): Universal.List<Universal.GuildMember> {
    if (!Array.isArray(data)) {
        throw new IpcError("OB11 群成员列表格式无效", "INVALID_RESPONSE");
    }
    const members: unknown[] = data;
    return {
        data: members.flatMap((item) => {
            const record = readGroupRecord(item, guildId);
            // 上游 UID 无法转为 QQ 号时，NaN 经 IPC JSON 序列化为 null。
            return record["user_id"] === null || record["user_id"] === 0
                ? []
                : [readMember(record)];
        }),
    };
}
