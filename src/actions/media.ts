/**
 * media.ts：发送侧媒体归一化（docs/internals/actions.md）
 *
 * 1. 语音格式归一化（ensureSilk/ensureVoiceSilk）：koishi 发语音（h.audio →
 *    canonical voice）前统一转 QQ 语音格式（silk v3）：非 silk 输入（ogg/mp3/
 *    wav 等，经 @napuketto/media 的 encodePcmToSilk 归一化）转 silk；已是 silk
 *    （#!SILK 头）原样返回；转码失败原样返回（kernel 发送兜底）。
 *    2026-08-23 修复：此前 koishi 路径不做转码，ogg/mp3 原样上传，QQ 播放器
 *    无法解码（线上实证：语音发送成功但收件人无法播放，Ptt\Ori 落盘的是
 *    OggS 魔数原样内容）。
 * 2. 远程媒体下载（downloadRemoteMedia，2026-09-08 T3）：img/audio/video 的
 *    http(s) src 下载到临时文件再走本地路径发送（大小上限 + 超时；失败回退占位文本）。
 * 3. 视频发送补全（enrichVideoElements，2026-10-17）：@napuketto/media 的
 *    getVideoInfo + extractVideoFrame 生成缩略图与宽高/时长，塞进 canonical video
 *    （QQ 视频消息发送契约需要 thumbPath/thumbWidth/thumbHeight/fileTime）。
 *    ffmpeg/ffprobe 缺失或失败 → 打 warn 并按无缩略图发送（不阻塞文本/其他元素）。
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanonicalElement } from "@napuketto/kernel";
import { encodePcmToSilk, extractVideoFrame, getVideoInfo } from "@napuketto/media";

const IMAGE_EXTENSIONS: Record<string, string> = {
    "image/avif": ".avif",
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
};

/** 视频 data URL / 下载内容的 MIME → 扩展名（未知落 .bin，交给 ffprobe 识别）。 */
const VIDEO_EXTENSIONS: Record<string, string> = {
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "video/x-matroska": ".mkv",
    "video/x-msvideo": ".avi",
    "video/mpeg": ".mpg",
};

/** 远程媒体下载大小上限（字节，默认 30MB；视频单独放宽到 100MB）。 */
const REMOTE_MEDIA_MAX_BYTES = 30 * 1024 * 1024;
const REMOTE_VIDEO_MAX_BYTES = 100 * 1024 * 1024;

/** 远程媒体下载超时（毫秒，默认 15s）。 */
const REMOTE_MEDIA_TIMEOUT_MS = 15_000;

/** http(s) URL 判断（远程媒体需下载到本地后发送）。 */
export function isHttpUrl(value: string): boolean {
    return /^https?:\/\//i.test(value);
}

/** 下载结果（元素替换 + 临时目录清理）。 */
interface DownloadedMedia {
    elements: CanonicalElement[];
    cleanup: () => Promise<void>;
}

/** 下载选项。 */
export interface DownloadRemoteMediaOptions {
    /** 校准/失败日志（warn 最小面；缺省静默）。 */
    logger?: { warn(message: string): void };
    /** 超时毫秒（缺省 15s；测试注入）。 */
    timeoutMs?: number;
    /** 大小上限字节（缺省 30MB；测试注入）。 */
    maxBytes?: number;
}

/**
 * 远程媒体（http/https）下载到本地：image/voice/video 元素的 URL path 替换为
 * 临时文件路径。单个下载失败（网络错误/非 2xx/超限）回退占位文本 `[图片: url]`
 * / `[语音: url]` / `[视频: url]` 并打 warn——不阻塞其余元素发送。
 */
export async function downloadRemoteMedia(
    elements: CanonicalElement[],
    options: DownloadRemoteMediaOptions = {},
): Promise<DownloadedMedia> {
    const targets = elements.filter(
        (el): el is Extract<CanonicalElement, { type: "image" | "voice" | "video" }> =>
            (el.type === "image" || el.type === "voice" || el.type === "video") &&
            typeof el.path === "string" &&
            isHttpUrl(el.path),
    );
    if (targets.length === 0) {
        return { elements, cleanup: async () => undefined };
    }
    const directory = await mkdtemp(join(tmpdir(), "napuketto-download-"));
    const replacements = new Map<string, string>();
    const failures = new Map<string, Error>();
    for (const el of targets) {
        if (replacements.has(el.path) || failures.has(el.path)) {
            continue;
        }
        try {
            replacements.set(
                el.path,
                await downloadToFile(el.path, directory, {
                    ...options,
                    maxBytes:
                        options.maxBytes ??
                        (el.type === "video" ? REMOTE_VIDEO_MAX_BYTES : REMOTE_MEDIA_MAX_BYTES),
                }),
            );
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            failures.set(el.path, error);
            options.logger?.warn(
                `[napuketto] 远程媒体下载失败（回退占位文本）: ${el.path} — ${error.message}`,
            );
        }
    }
    const merged = elements.map((el) => {
        if (el.type === "image" || el.type === "voice" || el.type === "video") {
            const replaced = replacements.get(el.path);
            if (replaced !== undefined) {
                return { ...el, path: replaced };
            }
            const reason = failures.get(el.path);
            if (reason !== undefined) {
                const label = el.type === "image" ? "图片" : el.type === "voice" ? "语音" : "视频";
                return { type: "text" as const, text: `[${label}: ${el.path}]` };
            }
        }
        return el;
    });
    return {
        elements: merged,
        cleanup: async () => {
            await rm(directory, { recursive: true, force: true });
        },
    };
}

/** 单个 URL → 临时文件（fetch + 大小上限 + 超时）。 */
async function downloadToFile(
    url: string,
    directory: string,
    options: DownloadRemoteMediaOptions,
): Promise<string> {
    const timeoutMs = options.timeoutMs ?? REMOTE_MEDIA_TIMEOUT_MS;
    const maxBytes = options.maxBytes ?? REMOTE_MEDIA_MAX_BYTES;
    const response = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > maxBytes) {
        throw new Error(`文件超过大小上限（${declared} > ${maxBytes} 字节）`);
    }
    const extension = extensionFor(response.headers.get("content-type"), url);
    const path = join(directory, `${randomUUID()}${extension}`);
    const body = response.body;
    if (body === null) {
        throw new Error("响应无 body");
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        if (value !== undefined) {
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel().catch(() => undefined);
                throw new Error(`文件超过大小上限（>${maxBytes} 字节）`);
            }
            chunks.push(value);
        }
    }
    if (total === 0) {
        throw new Error("下载内容为空");
    }
    await writeFile(path, Buffer.concat(chunks));
    return path;
}

/** Content-Type / URL 路径推断扩展名（缺省 .bin）。 */
function extensionFor(contentType: string | null, url: string): string {
    if (contentType !== null) {
        const base = contentType.split(";")[0]?.trim().toLowerCase();
        const mapped = IMAGE_EXTENSIONS[base ?? ""];
        if (mapped !== undefined) {
            return mapped;
        }
        if (base?.startsWith("audio/") === true || base?.startsWith("video/") === true) {
            return `.${base.split("/")[1]?.split("+")[0] ?? "bin"}`;
        }
        if (base?.startsWith("image/") === true) {
            return `.${base.split("/")[1]?.split("+")[0] ?? "bin"}`;
        }
    }
    try {
        const pathname = new URL(url).pathname;
        const ext = pathname.substring(pathname.lastIndexOf("."));
        if (ext.length > 1 && ext.length <= 6 && /^\.[a-z0-9]+$/i.test(ext)) {
            return ext.toLowerCase();
        }
    } catch {
        // URL 解析失败（理论不可达，fetch 已成功）：落 .bin
    }
    return ".bin";
}

interface MaterializedImages {
    elements: CanonicalElement[];
    cleanup: () => Promise<void>;
}

/** data URL 落盘规则（图片/视频共用）。 */
interface DataUrlMaterializeSpec {
    prefix: string;
    extensions: Record<string, string>;
    label: string;
    matches: (element: CanonicalElement) => boolean;
}

/** data URL 内容落盘（临时目录 + cleanup），供 IPC 子进程中的 wrapper.node 读文件。 */
async function materializeDataUrlMedia(
    elements: CanonicalElement[],
    spec: DataUrlMaterializeSpec,
): Promise<MaterializedImages> {
    const selected = elements.filter(
        (element): element is Extract<CanonicalElement, { type: "image" | "video" }> =>
            spec.matches(element),
    );
    if (selected.length === 0) {
        return { elements, cleanup: async () => undefined };
    }

    const directory = await mkdtemp(join(tmpdir(), `napuketto-${spec.label}-`));
    try {
        const replacements = new Map<string, string>();
        for (const element of selected) {
            if (replacements.has(element.path)) {
                continue;
            }
            const match = /^data:([^;,]+)(;base64)?,(.*)$/is.exec(element.path);
            const mimeType = match?.[1];
            const payload = match?.[3];
            if (
                mimeType === undefined ||
                !mimeType.startsWith(spec.prefix) ||
                payload === undefined
            ) {
                throw new Error(`${spec.label} data URL 格式无效`);
            }
            const isBase64 = match?.[2] === ";base64";
            const bytes = isBase64
                ? Buffer.from(payload.replace(/\s/g, ""), "base64")
                : Buffer.from(decodeURIComponent(payload), "utf8");
            if (bytes.length === 0) {
                throw new Error(`${spec.label} data URL 内容为空`);
            }
            const extension = spec.extensions[mimeType.toLowerCase()] ?? ".bin";
            const path = join(directory, `${randomUUID()}${extension}`);
            await writeFile(path, bytes);
            replacements.set(element.path, path);
        }
        return {
            elements: elements.map((element) =>
                (element.type === "image" || element.type === "video") &&
                replacements.has(element.path)
                    ? { ...element, path: replacements.get(element.path) as string }
                    : element,
            ),
            cleanup: async () => {
                await rm(directory, { recursive: true, force: true });
            },
        };
    } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
    }
}

/** data URL 图片落盘，供 IPC 子进程中的 wrapper.node 按文件路径读取。 */
export async function materializeDataUrlImages(
    elements: CanonicalElement[],
): Promise<MaterializedImages> {
    return materializeDataUrlMedia(elements, {
        prefix: "image/",
        extensions: IMAGE_EXTENSIONS,
        label: "图片",
        matches: (element) => element.type === "image" && /^data:image\//i.test(element.path),
    });
}

/** data URL 视频落盘（data:video/*;base64,…），供 kernel 计算 md5/放置后发送。 */
export async function materializeDataUrlVideos(
    elements: CanonicalElement[],
): Promise<MaterializedImages> {
    return materializeDataUrlMedia(elements, {
        prefix: "video/",
        extensions: VIDEO_EXTENSIONS,
        label: "视频",
        matches: (element) => element.type === "video" && /^data:video\//i.test(element.path),
    });
}

/**
 * 视频发送补全：为本地 canonical video 生成缩略图（ffmpeg 抽首帧）与宽高/时长
 * （ffprobe），供 kernel 构造完整 videoElement。失败降级为「无缩略图」并打 warn，
 * 不阻塞其余元素（kernel 对缺缩略图的视频仍会尝试发送/失败，由上层日志暴露）。
 */
export async function enrichVideoElements(
    elements: CanonicalElement[],
    options: DownloadRemoteMediaOptions = {},
): Promise<MaterializedImages> {
    const targets = elements.filter(
        (el): el is Extract<CanonicalElement, { type: "video" }> =>
            el.type === "video" &&
            el.thumbPath === undefined &&
            typeof el.path === "string" &&
            el.path !== "" &&
            !isHttpUrl(el.path) &&
            !/^data:/i.test(el.path),
    );
    if (targets.length === 0) {
        return { elements, cleanup: async () => undefined };
    }
    const directory = await mkdtemp(join(tmpdir(), "napuketto-video-"));
    const enriched = new Map<
        string,
        { thumbPath?: string; width?: number; height?: number; durationSec?: number }
    >();
    for (const el of targets) {
        if (enriched.has(el.path)) {
            continue;
        }
        try {
            const info = await getVideoInfo(el.path);
            const thumbPath = join(directory, `${randomUUID()}.png`);
            await extractVideoFrame(el.path, thumbPath);
            enriched.set(el.path, {
                thumbPath,
                width: info.width,
                height: info.height,
                // canonical durationSec 为整数秒；向上取整避免 0.4s 变 0（QQ 显示 0 秒）
                durationSec: Math.max(1, Math.round(info.durationMs / 1000)),
            });
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            enriched.set(el.path, {});
            options.logger?.warn(
                `[napuketto] 视频缩略图/元数据生成失败（降级无缩略图发送）: ${el.path} — ${error.message}`,
            );
        }
    }
    return {
        elements: elements.map((element) => {
            if (element.type !== "video") {
                return element;
            }
            const extra = enriched.get(element.path);
            return extra === undefined ? element : { ...element, ...extra };
        }),
        cleanup: async () => {
            await rm(directory, { recursive: true, force: true });
        },
    };
}

/** 读文件头 8 字节（判断 silk 魔数）。 */
async function readFileHead(path: string): Promise<string> {
    const handle = await open(path, "r");
    try {
        const buf = Buffer.alloc(8);
        await handle.read(buf, 0, 8, 0);
        return buf.toString("utf8");
    } finally {
        await handle.close();
    }
}

/** 语音转码：非 silk → silk（@napuketto/media 归一化）；已是 silk 原样；失败回落原路径。 */
export async function ensureSilk(path: string): Promise<string> {
    try {
        const header = await readFileHead(path);
        if (header.startsWith("#!SILK")) {
            return path;
        }
        return await encodePcmToSilk(path);
    } catch {
        return path;
    }
}

/** canonical 元素数组中的语音统一转 silk（非 voice 元素原样）。 */
export async function ensureVoiceSilk(elements: CanonicalElement[]): Promise<CanonicalElement[]> {
    const out: CanonicalElement[] = [];
    for (const el of elements) {
        out.push(el.type === "voice" ? { ...el, path: await ensureSilk(el.path) } : el);
    }
    return out;
}
