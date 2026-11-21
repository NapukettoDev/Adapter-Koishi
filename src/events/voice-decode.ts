/** 将 QQ 原生语音文件解码为 Koishi 可播放的 WAV。 */
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { type CanonicalElement, resolveDataRoot, resolveQqGlobalPath } from "@napuketto/kernel";
import { decodeSilkToWav } from "@napuketto/media";

const VOICE_TTL_MS = 10 * 60 * 1000;
const MAX_VOICE_ENTRIES = 64;
const CLEANUP_RETRY_MS = 60_000;
const REMOTE_PATH = /^(?:https?:\/\/|data:)/i;

/** 解析 QQ 语音路径。Windows 默认沿用桌面 QQ 数据目录。 */
export function resolveNtFile(
    path: string,
    dataRoot?: string,
    platform: NodeJS.Platform = process.platform,
    home: string = homedir(),
): string | null {
    if (path === "") {
        return null;
    }
    if (isAbsolute(path)) {
        return existsSync(path) ? path : null;
    }
    const root =
        platform === "linux" || process.env["NAPUKETTO_SANDBOX_ROOT"]
            ? (dataRoot ?? resolveDataRoot())
            : join(home, "Documents", "Tencent Files");
    const file = join(resolveQqGlobalPath(root), path.replaceAll("\\", "/"));
    return existsSync(file) ? file : null;
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
        dataRoot?: string,
        warn?: (message: string) => void,
    ): Promise<string> {
        const silk = resolveNtFile(path, dataRoot);
        if (silk === null || entries >= maxEntries) {
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
        dataRoot?: string,
        warn?: (message: string) => void,
    ): Promise<CanonicalElement[]> => {
        const out: CanonicalElement[] = [];
        for (const el of elements) {
            if (el.type === "voice" && el.path !== "" && !REMOTE_PATH.test(el.path)) {
                out.push({ ...el, path: await toPlayableVoice(el.path, dataRoot, warn) });
            } else {
                out.push(el);
            }
        }
        return out;
    };
}

/** 在派发前将 NT SILK 转为限时可消费的 WAV。 */
export const enrichReceiveVoice: ReturnType<typeof createVoiceEnricher> = createVoiceEnricher();
