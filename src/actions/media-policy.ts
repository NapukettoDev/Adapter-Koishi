import { type BigIntStats, constants, createWriteStream } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { IpcError } from "../ipc/errors.js";

export const DEFAULT_REMOTE_MEDIA_POLICY = "compatible";
export const DEFAULT_LOCAL_FILE_POLICY = "legacy";

export interface OutboundMediaPolicy {
    remoteMediaPolicy?: "compatible" | "public-only";
    localFilePolicy?: "legacy" | "allowlist";
    localMediaRoots?: string[];
}

// UNC、设备路径及 ADS 即使能 stat，也不属于本地普通文件白名单。
function isLocalPath(path: string): boolean {
    const withoutDrivePrefix = process.platform === "win32" ? path.replace(/^[a-z]:/i, "") : path;
    return (
        !path.startsWith("//") &&
        !path.startsWith("\\\\") &&
        !withoutDrivePrefix.includes(":") &&
        !path.includes("\0")
    );
}

function contains(root: string, target: string): boolean {
    const prefix = root.endsWith(sep) ? root : root + sep;
    return target.startsWith(prefix) && target.length > prefix.length;
}

async function isUnderAllowedRoot(target: string, roots: string[]): Promise<boolean> {
    for (const entry of roots) {
        if (entry === "" || !isLocalPath(entry)) {
            continue;
        }
        const root = await realpath(resolve(entry)).catch(() => null);
        if (root !== null && isLocalPath(root) && contains(root, target)) {
            return true;
        }
    }
    return false;
}

function invalidLocalMedia(): IpcError {
    return new IpcError(
        "本地媒体文件不在允许的目录内，或无法在大小限制内安全复制",
        "INVALID_PARAM",
    );
}

function sameFile(expected: BigIntStats, actual: BigIntStats): boolean {
    return (
        actual.isFile() &&
        actual.nlink === 1n &&
        actual.dev === expected.dev &&
        actual.ino === expected.ino &&
        actual.size === expected.size &&
        actual.mtimeNs === expected.mtimeNs &&
        actual.ctimeNs === expected.ctimeNs
    );
}

export async function stageAllowedMedia(
    path: string,
    roots: string[],
    maxBytes: number,
    createDestination: (target: string) => Promise<string>,
): Promise<string> {
    try {
        if (roots.length === 0 || !isLocalPath(path)) {
            throw invalidLocalMedia();
        }
        const target = await realpath(path);
        if (!isLocalPath(target) || !(await isUnderAllowedRoot(target, roots))) {
            throw invalidLocalMedia();
        }
        const expected = await lstat(target, { bigint: true });
        if (
            !expected.isFile() ||
            expected.nlink !== 1n ||
            expected.ino === 0n ||
            expected.size > maxBytes
        ) {
            throw invalidLocalMedia();
        }
        // 避免最终路径分量被替换成链接，或在打开期间被替换成 FIFO 导致阻塞。
        const flags =
            constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
        const handle = await open(target, flags);
        try {
            // Linux 直接核对打开的对象所处路径。Windows 的路径复核依赖部署保护目录树。
            const openedPath =
                process.platform === "linux"
                    ? await readlink(`/proc/self/fd/${handle.fd}`)
                    : await realpath(target);
            if (openedPath !== target || !sameFile(expected, await handle.stat({ bigint: true }))) {
                throw invalidLocalMedia();
            }

            const destination = await createDestination(target);
            // 从同一个句柄复制，使调用方路径后续被替换时，原生层仍读取本次副本。
            const source = handle.createReadStream({
                autoClose: false,
                start: 0,
                end: maxBytes - 1,
            });
            await pipeline(source, createWriteStream(destination, { flags: "wx", mode: 0o600 }));
            if (
                BigInt(source.bytesRead) !== expected.size ||
                !sameFile(expected, await handle.stat({ bigint: true }))
            ) {
                throw invalidLocalMedia();
            }
            return destination;
        } finally {
            await handle.close();
        }
    } catch {
        // 路径越界、文件变更和 I/O 失败使用同一错误，避免暴露调用方无权读取的文件信息。
        throw invalidLocalMedia();
    }
}
