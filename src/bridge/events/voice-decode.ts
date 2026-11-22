/** 将 QQ 原生语音文件解码为 Koishi 可播放的 WAV。 */
import { realpathSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { type CanonicalElement, resolveDataRoot, resolveQqGlobalPath } from "@napuketto/kernel";
import { decodeSilkToWav } from "@napuketto/media";

import { isLocalPath } from "../../shared.js";

const VOICE_TTL_MS = 10 * 60 * 1000;
const MAX_VOICE_ENTRIES = 64;
const CLEANUP_RETRY_MS = 60_000;
const REMOTE_PATH = /^(?:https?:\/\/|data:)/i;
const WINDOWS_DRIVE = /^[a-z]:[\\/]/i;
const PARENT_COMPONENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

/** 只有 Linux 和调试沙箱能从启动参数确定 QQ 目录。 */
function resolveHostQqGlobalPath(
    dataRoot?: string,
    platform: NodeJS.Platform = process.platform,
): string | undefined {
    return platform === "linux" || process.env["NAPUKETTO_SANDBOX_ROOT"]
        ? resolveQqGlobalPath(dataRoot ?? resolveDataRoot())
        : undefined;
}

function isFullyQualified(path: string): boolean {
    return process.platform === "win32" ? WINDOWS_DRIVE.test(path) : isAbsolute(path);
}

/** 仅接受真实路径位于已知 QQ 目录内的普通文件。 */
export function resolveQqVoiceFile(path: string, qqGlobalPath?: string): string | null {
    if (
        !qqGlobalPath ||
        !isFullyQualified(qqGlobalPath) ||
        !isLocalPath(qqGlobalPath) ||
        path === "" ||
        !isLocalPath(path) ||
        PARENT_COMPONENT.test(path)
    ) {
        return null;
    }
    const absolute = isFullyQualified(path);
    const relativePath = path.replaceAll("\\", "/");
    if (!absolute && (relativePath.startsWith("/") || relativePath.includes(":"))) {
        return null; // Windows 根相对和盘符相对路径依赖宿主进程的当前目录。
    }
    try {
        const root = realpathSync.native(qqGlobalPath);
        if (!isLocalPath(root)) {
            return null;
        }
        const candidate = absolute ? path : resolve(qqGlobalPath, relativePath);
        const target = realpathSync.native(candidate);
        // realpath 展开 Windows 短文件名，保留实际大小写以兼容大小写敏感的 NTFS 目录。
        const prefix = root.endsWith(sep) ? root : root + sep;
        return isLocalPath(target) && target.startsWith(prefix) && statSync(target).isFile()
            ? target
            : null;
    } catch {
        return null;
    }
}

/** 解析宿主数据根中的语音。`home` 参数为旧调用方保留。 */
export function resolveNtFile(
    path: string,
    dataRoot?: string,
    platform: NodeJS.Platform = process.platform,
    _home?: string,
): string | null {
    return resolveQqVoiceFile(path, resolveHostQqGlobalPath(dataRoot, platform));
}

export function createVoiceEnricher(ttlMs = VOICE_TTL_MS, maxEntries = MAX_VOICE_ENTRIES) {
    let entries = 0;

    async function cleanup(directory: string, warn?: (message: string) => void): Promise<void> {
        try {
            await rm(directory, { recursive: true, force: true, maxRetries: 3 });
            entries--;
        } catch {
            setTimeout(() => {
                void cleanup(directory, warn);
            }, CLEANUP_RETRY_MS).unref();
            warn?.("入站语音临时目录清理失败，将重试");
        }
    }

    async function toPlayableVoice(
        path: string,
        qqGlobalPath?: string,
        warn?: (message: string) => void,
    ): Promise<string> {
        if (entries >= maxEntries) {
            return path;
        }
        const silk = resolveQqVoiceFile(path, qqGlobalPath);
        if (silk === null) {
            return path;
        }
        // 解码中也占容量，防止并发事件超出上限。
        entries++;
        let directory: string | undefined;
        try {
            directory = await mkdtemp(join(tmpdir(), "napuketto-voice-"));
            const output = directory;
            const { wavPath } = await decodeSilkToWav(silk, { outDir: output });
            setTimeout(() => {
                void cleanup(output, warn);
            }, ttlMs).unref();
            return wavPath;
        } catch {
            if (directory === undefined) {
                entries--;
            } else {
                await cleanup(directory, warn);
            }
            return path;
        }
    }

    return async (
        elements: CanonicalElement[],
        qqGlobalPath?: string,
        warn?: (message: string) => void,
    ): Promise<CanonicalElement[]> => {
        const out: CanonicalElement[] = [];
        for (const el of elements) {
            if (el.type === "voice" && el.path !== "" && !REMOTE_PATH.test(el.path)) {
                out.push({ ...el, path: await toPlayableVoice(el.path, qqGlobalPath, warn) });
            } else {
                out.push(el);
            }
        }
        return out;
    };
}

const enrichVoiceWithDirectory = createVoiceEnricher();

/** 在派发前将 NT SILK 转为限时可消费的 WAV。 */
export function enrichReceiveVoice(
    elements: CanonicalElement[],
    dataRoot?: string,
    warn?: (message: string) => void,
): Promise<CanonicalElement[]> {
    return enrichVoiceWithDirectory(elements, resolveHostQqGlobalPath(dataRoot), warn);
}
