import { rename, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import type { CanonicalElement } from "@napuketto/kernel";
import * as media from "@napuketto/media";
import {
    DEFAULT_LOCAL_FILE_POLICY,
    DEFAULT_REMOTE_MEDIA_POLICY,
    IpcError,
    type OutboundMediaPolicy,
} from "../../../shared.js";
import { stageAllowedMedia } from "./policy.js";

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
const HTTP_URL = /^https?:\/\//i;
const DATA_URL = /^data:/i;
const INLINE_MEDIA = /^data:([^;,]+)(;base64)?,(.*)$/is;
const SAFE_EXTENSION = /^\.[a-z0-9]{1,12}$/i;
const BASE64_WHITESPACE = /\s/g;
const BASE64_PAYLOAD = /^[a-z\d+/_-]*={0,2}$/i;
const PERCENT_BYTE = /^[\da-f]{2}$/i;

export type MediaElement = Extract<CanonicalElement, { type: "image" | "voice" | "video" }>;
export type MediaFileFactory = (extension: string) => Promise<string>;
export type OutboundLogger = { warn(message: string): void };

interface MediaKind {
    mime: string;
    label: string;
    maxBytes: number;
}

export interface AcquireMediaOptions extends OutboundMediaPolicy {
    logger?: OutboundLogger;
    timeoutMs?: number;
    maxBytes?: number;
}

async function download(
    url: URL,
    createFile: MediaFileFactory,
    maxBytes: number,
    options: AcquireMediaOptions,
): Promise<string> {
    const downloader =
        (options.remoteMediaPolicy ?? DEFAULT_REMOTE_MEDIA_POLICY) === "public-only"
            ? media.downloadPublicUrl
            : media.downloadUrl;
    const suffix = media.inferExtension(null, url.href);
    const path = await createFile(suffix);
    await downloader(url.href, path, {
        timeoutMs: options.timeoutMs ?? REMOTE_TIMEOUT_MS,
        maxBytes,
    });
    // 发布版下载器只返回字节数。用文件魔数补足无扩展名的 CDN URL。
    const detected = await media.detectFileType(path).catch(() => undefined);
    const extension = detected === undefined ? suffix : `.${detected.ext}`;
    if (extension !== suffix && SAFE_EXTENSION.test(extension)) {
        const renamed = await createFile(extension);
        await rename(path, renamed);
        return renamed;
    }
    return path;
}

async function downloadElement(
    element: MediaElement,
    createFile: MediaFileFactory,
    kind: MediaKind,
    options: AcquireMediaOptions,
): Promise<MediaElement | Extract<CanonicalElement, { type: "text" }>> {
    let displayPath = "";
    try {
        const url = new URL(element.path);
        displayPath = `: ${url.origin}${url.pathname}`;
        return { ...element, path: await download(url, createFile, kind.maxBytes, options) };
    } catch (error) {
        const reason = error instanceof IpcError ? error.message : "请求或流式落盘失败";
        options.logger?.warn(`远程媒体下载失败（回退占位文本）：${reason}`);
        return { type: "text", text: `[${kind.label}${displayPath}]` };
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
    createFile: MediaFileFactory,
    { mime, maxBytes }: MediaKind,
): Promise<string> {
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
    const path = await createFile(SAFE_EXTENSION.test(suffix) ? suffix : ".bin");
    await writeFile(path, bytes, { flag: "wx" });
    return path;
}

export async function acquireMedia(
    element: MediaElement,
    createFile: MediaFileFactory,
    kind: MediaKind,
    options: AcquireMediaOptions,
): Promise<MediaElement | Extract<CanonicalElement, { type: "text" }>> {
    if (HTTP_URL.test(element.path)) {
        return downloadElement(element, createFile, kind, options);
    }
    if (DATA_URL.test(element.path)) {
        return { ...element, path: await materializeInline(element, createFile, kind) };
    }
    if ((options.localFilePolicy ?? DEFAULT_LOCAL_FILE_POLICY) === "allowlist") {
        const staged = await stageAllowedMedia(
            element.path,
            options.localMediaRoots ?? [],
            kind.maxBytes,
            (target) => {
                const suffix = extname(target);
                return createFile(SAFE_EXTENSION.test(suffix) ? suffix : ".bin");
            },
        );
        return {
            ...element,
            path: process.platform === "win32" ? staged.replaceAll("\\", "/") : staged,
        };
    }
    return element;
}
