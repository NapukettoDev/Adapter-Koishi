/** QQ NT uses Unix seconds or milliseconds depending on the wrapper version. */
export function normalizeMessageTime(raw: unknown): number | undefined {
    const value = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        return undefined;
    }
    const timestamp = value < 1e12 ? value * 1000 : value;
    return timestamp <= 8.64e15 ? timestamp : undefined;
}
