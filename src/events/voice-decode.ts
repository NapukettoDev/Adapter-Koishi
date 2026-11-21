/** 将 QQ 原生语音文件解码为 Koishi 可播放的 WAV。 */
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { type CanonicalElement, resolveDataRoot, resolveQqGlobalPath } from "@napuketto/kernel";
import { decodeSilkToWav } from "@napuketto/media";

const VOICE_OUT_DIR = join(tmpdir(), "napuketto-voice");

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

/** 单个 voice 元素 → 可播放 WAV 路径（fail-soft：任何失败原样返回）。 */
async function toPlayableVoice(path: string, dataRoot?: string): Promise<string> {
    const silk = resolveNtFile(path, dataRoot);
    if (silk === null) {
        return path;
    }
    try {
        const { wavPath } = await decodeSilkToWav(silk, { outDir: VOICE_OUT_DIR });
        return wavPath;
    } catch {
        // 非 silk / 解码失败：原样透传
        return path;
    }
}

/**
 * 收方向元素富化：voice 元素的 NT silk 路径 → 本地 WAV（异步，bridge 派发前调用）。
 * 非 voice 元素与远程/空路径原样返回。
 */
export async function enrichReceiveVoice(
    elements: CanonicalElement[],
    dataRoot?: string,
): Promise<CanonicalElement[]> {
    const out: CanonicalElement[] = [];
    for (const el of elements) {
        if (
            el.type === "voice" &&
            el.path !== "" &&
            !/^https?:\/\//i.test(el.path) &&
            !/^data:/i.test(el.path)
        ) {
            out.push({ ...el, path: await toPlayableVoice(el.path, dataRoot) });
            continue;
        }
        out.push(el);
    }
    return out;
}
