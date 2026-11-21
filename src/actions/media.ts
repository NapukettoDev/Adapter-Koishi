import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { CanonicalElement } from "@napuketto/kernel";
import * as media from "@napuketto/media";
import { IpcError } from "../ipc/errors.js";
import {
    DEFAULT_LOCAL_FILE_POLICY,
    DEFAULT_REMOTE_MEDIA_POLICY,
    type OutboundMediaPolicy,
    stageAllowedMedia,
} from "./media-policy.js";

const MEDIA_TYPES = {
    image: { mime: "image/", label: "图片", maxBytes: 30 * 1024 * 1024 },
    voice: { mime: "audio/", label: "语音", maxBytes: 30 * 1024 * 1024 },
    video: { mime: "video/", label: "视频", maxBytes: 100 * 1024 * 1024 },
} as const;

const MIME_EXTENSIONS: Record<string, string> = {
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/silk": ".silk",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "image/jpeg": ".jpg",
    "video/quicktime": ".mov",
    "video/x-matroska": ".mkv",
    "video/x-msvideo": ".avi",
};

const REMOTE_TIMEOUT_MS = 15_000;
const MAX_AUDIO_INPUT_BYTES = 32 * 1024 * 1024;
const HTTP_URL = /^https?:\/\//i;
const DATA_URL = /^data:/i;
const INLINE_MEDIA = /^data:([^;,]+)(;base64)?,(.*)$/is;
const SAFE_EXTENSION = /^\.[a-z0-9]{1,12}$/i;
const BASE64_WHITESPACE = /\s/g;
const BASE64_PAYLOAD = /^[a-z\d+/_-]*={0,2}$/i;
const PERCENT_BYTE = /^[\da-f]{2}$/i;

type MediaElement = Extract<CanonicalElement, { type: keyof typeof MEDIA_TYPES }>;
type OutboundLogger = { warn(message: string): void };

interface PrepareMediaOptions extends OutboundMediaPolicy {
    logger?: OutboundLogger;
    timeoutMs?: number;
    maxBytes?: number;
}

class MediaWorkspace {
    private directory?: string;

    async file(extension: string): Promise<string> {
        this.directory ??= await mkdtemp(join(tmpdir(), "napuketto-send-"));
        return join(this.directory, `${randomUUID()}${extension}`);
    }

    async cleanup(): Promise<void> {
        if (this.directory !== undefined) {
            await rm(this.directory, { recursive: true, force: true });
        }
    }
}

function isMedia(element: CanonicalElement): element is MediaElement {
    return element.type === "image" || element.type === "voice" || element.type === "video";
}

function publicDownloader(): typeof media.downloadUrl {
    // 新入口由上游发布提供。检查导出能力，旧版本不会静默退回兼容网络策略。
    const downloader = Reflect.get(media, "downloadPublicUrl");
    if (typeof downloader !== "function") {
        throw new IpcError("当前 @napuketto/media 不支持公网下载策略", "UNSUPPORTED");
    }
    return downloader as typeof media.downloadUrl;
}

async function download(
    url: URL,
    workspace: MediaWorkspace,
    type: MediaElement["type"],
    options: PrepareMediaOptions,
): Promise<string> {
    const downloader =
        (options.remoteMediaPolicy ?? DEFAULT_REMOTE_MEDIA_POLICY) === "public-only"
            ? publicDownloader()
            : media.downloadUrl;
    const suffix = media.inferExtension(null, url.href);
    const path = await workspace.file(suffix);
    await downloader(url.href, path, {
        timeoutMs: options.timeoutMs ?? REMOTE_TIMEOUT_MS,
        maxBytes: options.maxBytes ?? MEDIA_TYPES[type].maxBytes,
    });
    // 发布版下载器只返回字节数。用文件魔数补足无扩展名的 CDN URL。
    const detected = await media.detectFileType(path).catch(() => undefined);
    const extension = detected === undefined ? suffix : `.${detected.ext}`;
    if (extension !== suffix && SAFE_EXTENSION.test(extension)) {
        const renamed = await workspace.file(extension);
        await rename(path, renamed);
        return renamed;
    }
    return path;
}

async function downloadElement(
    element: MediaElement,
    workspace: MediaWorkspace,
    options: PrepareMediaOptions,
): Promise<MediaElement | Extract<CanonicalElement, { type: "text" }>> {
    let displayPath = "";
    try {
        const url = new URL(element.path);
        displayPath = `: ${url.origin}${url.pathname}`;
        return { ...element, path: await download(url, workspace, element.type, options) };
    } catch (error) {
        const reason = error instanceof IpcError ? error.message : "请求或流式落盘失败";
        options.logger?.warn(`远程媒体下载失败（回退占位文本）：${reason}`);
        return { type: "text", text: `[${MEDIA_TYPES[element.type].label}${displayPath}]` };
    }
}

function decodePercentBytes(payload: string): Buffer {
    const bytes = Buffer.from(payload);
    let write = 0;
    for (let read = 0; read < bytes.length; read++) {
        if (bytes[read] === 37) {
            const hex = bytes.toString("ascii", read + 1, read + 3);
            if (!PERCENT_BYTE.test(hex)) {
                throw new IpcError("媒体 data URL 的百分号编码无效", "INVALID_PARAM");
            }
            bytes[write++] = Number.parseInt(hex, 16);
            read += 2;
        } else {
            bytes[write++] = bytes[read] ?? 0;
        }
    }
    return bytes.subarray(0, write);
}

async function materializeInline(
    element: MediaElement,
    workspace: MediaWorkspace,
): Promise<string> {
    const { mime, maxBytes } = MEDIA_TYPES[element.type];
    const match = INLINE_MEDIA.exec(element.path);
    const contentType = match?.[1]?.toLowerCase();
    const payload = match?.[3];
    if (!contentType?.startsWith(mime) || payload === undefined || payload.length > maxBytes * 3) {
        throw new IpcError("媒体 data URL 格式无效或超过大小上限", "INVALID_PARAM");
    }
    let bytes: Buffer;
    if (match?.[2] !== undefined) {
        const encoded = payload.replace(BASE64_WHITESPACE, "");
        if (
            encoded.length > Math.ceil(maxBytes / 3) * 4 ||
            encoded.length % 4 === 1 ||
            !BASE64_PAYLOAD.test(encoded)
        ) {
            throw new IpcError("媒体 data URL 的 base64 格式无效或超过大小上限", "INVALID_PARAM");
        }
        bytes = Buffer.from(encoded, "base64");
    } else {
        bytes = decodePercentBytes(payload);
    }
    if (bytes.length === 0 || bytes.length > maxBytes) {
        throw new IpcError("媒体 data URL 内容为空或超过大小上限", "INVALID_PARAM");
    }
    const suffix = MIME_EXTENSIONS[contentType] ?? `.${contentType.slice(mime.length)}`;
    const path = await workspace.file(SAFE_EXTENSION.test(suffix) ? suffix : ".bin");
    await writeFile(path, bytes, { flag: "wx" });
    return path;
}

async function isSilk(path: string): Promise<boolean> {
    const handle = await open(path, "r");
    try {
        const head = Buffer.alloc(7);
        await handle.read(head, 0, head.length, 0);
        return head.toString("ascii", head[0] === 2 ? 1 : 0).startsWith("#!SILK");
    } finally {
        await handle.close();
    }
}

async function ensureSilk(
    path: string,
    workspace: MediaWorkspace,
    logger?: OutboundLogger,
): Promise<string> {
    try {
        const info = await stat(path);
        if (!info.isFile() || info.size > MAX_AUDIO_INPUT_BYTES || (await isSilk(path))) {
            return path;
        }
        // 0.2.2 将 SILK 写入输入同目录。复制到独占位置，避免覆盖任何调用方文件。
        const suffix = extname(path);
        const input = await workspace.file(
            SAFE_EXTENSION.test(suffix) && suffix.toLowerCase() !== ".silk" ? suffix : ".bin",
        );
        await copyFile(path, input);
        return await media.encodePcmToSilk(input);
    } catch {
        logger?.warn("语音转码失败，继续使用原文件");
        return path;
    }
}

async function enrichVideo(
    element: Extract<CanonicalElement, { type: "video" }>,
    workspace: MediaWorkspace,
    logger?: OutboundLogger,
): Promise<MediaElement> {
    try {
        const info = await media.getVideoInfo(element.path);
        const thumbPath = await workspace.file(".png");
        await media.extractVideoFrame(element.path, thumbPath);
        return {
            ...element,
            thumbPath,
            width: info.width,
            height: info.height,
            durationSec: Math.max(1, Math.round(info.durationMs / 1000)),
        };
    } catch {
        logger?.warn("视频缩略图或元数据生成失败，继续尝试发送");
        return element;
    }
}

async function prepareElement(
    element: MediaElement,
    workspace: MediaWorkspace,
    options: PrepareMediaOptions,
): Promise<CanonicalElement> {
    let prepared = element;
    if (HTTP_URL.test(element.path)) {
        const downloaded = await downloadElement(element, workspace, options);
        if (downloaded.type === "text") {
            return downloaded;
        }
        prepared = downloaded;
    } else if (DATA_URL.test(element.path)) {
        prepared = { ...element, path: await materializeInline(element, workspace) };
    } else if ((options.localFilePolicy ?? DEFAULT_LOCAL_FILE_POLICY) === "allowlist") {
        const staged = await stageAllowedMedia(
            element.path,
            options.localMediaRoots ?? [],
            MEDIA_TYPES[element.type].maxBytes,
            (target) => {
                const suffix = extname(target);
                return workspace.file(SAFE_EXTENSION.test(suffix) ? suffix : ".bin");
            },
        );
        prepared = {
            ...element,
            path: process.platform === "win32" ? staged.replaceAll("\\", "/") : staged,
        };
    }
    switch (prepared.type) {
        case "voice":
            return {
                ...prepared,
                path: await ensureSilk(prepared.path, workspace, options.logger),
            };
        case "video":
            return prepared.thumbPath === undefined
                ? enrichVideo(prepared, workspace, options.logger)
                : prepared;
        default:
            return prepared;
    }
}

export async function prepareOutboundMedia(
    elements: CanonicalElement[],
    options: PrepareMediaOptions = {},
): Promise<{ elements: CanonicalElement[]; cleanup: () => Promise<void> }> {
    const workspace = new MediaWorkspace();
    const prepared: CanonicalElement[] = [];
    const cache = new Map<string, CanonicalElement>();
    const cleanup = async () => {
        await workspace.cleanup().catch(() => options.logger?.warn("无法清理发送媒体的临时目录"));
    };
    try {
        for (const element of elements) {
            if (!isMedia(element)) {
                prepared.push(element);
                continue;
            }
            const key = `${element.type}:${element.path}`;
            const result = cache.get(key) ?? (await prepareElement(element, workspace, options));
            cache.set(key, result);
            prepared.push(result);
        }
        return { elements: prepared, cleanup };
    } catch (error) {
        await cleanup();
        throw error;
    }
}
