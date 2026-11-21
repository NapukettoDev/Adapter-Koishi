import { realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
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
    return (
        !path.startsWith("//") &&
        !path.startsWith("\\\\") &&
        !path.replace(process.platform === "win32" ? /^[a-z]:/i : /^$/, "").includes(":") &&
        !path.includes("\0")
    );
}

function contains(root: string, target: string): boolean {
    const prefix = root.endsWith(sep) ? root : root + sep;
    return target.startsWith(prefix) && target.length > prefix.length;
}

export async function resolveAllowedMedia(path: string, roots: string[]): Promise<string> {
    try {
        if (roots.length > 0 && isLocalPath(path)) {
            const target = await realpath(path);
            if (isLocalPath(target) && (await stat(target)).isFile()) {
                for (const entry of roots) {
                    if (entry === "" || !isLocalPath(entry)) {
                        continue;
                    }
                    const root = await realpath(resolve(entry)).catch(() => null);
                    if (root !== null && isLocalPath(root) && contains(root, target)) {
                        return process.platform === "win32" ? target.replaceAll("\\", "/") : target;
                    }
                }
            }
        }
    } catch {
        // 与不在目录内使用同一错误，避免通过发送接口暴露文件是否存在。
    }
    throw new IpcError("本地媒体文件不在允许的目录内，或不是可读取的普通文件", "INVALID_PARAM");
}
