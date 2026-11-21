/** 与 Napuketto CLI 的账号格式一致，并保证账号目录名只有一个路径段。 */
export const SELF_ID_PATTERN = /^[0-9]{5,11}$/;

export function requireSelfId(value: unknown): string {
    if (typeof value !== "string" || !SELF_ID_PATTERN.test(value)) {
        throw new TypeError("selfId 必须是 5–11 位 ASCII 数字组成的 QQ 号字符串");
    }
    return value;
}
