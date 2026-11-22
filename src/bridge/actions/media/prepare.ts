import { stat } from "node:fs/promises";
import type { CanonicalElement } from "@napuketto/kernel";
import { IpcError, isLocalPath } from "../../../shared.js";
import {
    type AcquireMediaOptions,
    acquireMedia,
    type MediaElement,
    type MediaFileFactory,
} from "./acquire.js";
import { enrichVideo, ensureSilk } from "./transcode.js";
import { MediaWorkspace } from "./workspace.js";

const MEDIA_TYPES = {
    image: { mime: "image/", label: "图片", maxBytes: 30 * 1024 * 1024 },
    voice: { mime: "audio/", label: "语音", maxBytes: 30 * 1024 * 1024 },
    video: { mime: "video/", label: "视频", maxBytes: 100 * 1024 * 1024 },
} as const;
const MAX_MEDIA_ITEMS = 16;
const MAX_MESSAGE_MEDIA_BYTES = 120 * 1024 * 1024;

function isMedia(element: CanonicalElement): element is MediaElement {
    return element.type === "image" || element.type === "voice" || element.type === "video";
}

async function mediaSize(path: string, limit: number): Promise<number> {
    const file = isLocalPath(path) ? await stat(path).catch(() => undefined) : undefined;
    if (!file?.isFile() || file.size > limit) {
        throw new IpcError("媒体不是普通文件或超过出站大小上限", "INVALID_PARAM");
    }
    return file.size;
}

async function enrichElement(
    element: MediaElement,
    workspace: MediaWorkspace,
    createFile: MediaFileFactory,
    options: AcquireMediaOptions,
): Promise<{ element: MediaElement; generated?: string }> {
    if (element.type === "voice") {
        const path = await ensureSilk(
            element.path,
            createFile,
            workspace.owns(element.path),
            options.logger,
        );
        return path === element.path
            ? { element }
            : { element: { ...element, path }, generated: path };
    }
    if (element.type === "video" && element.thumbPath === undefined) {
        const video = await enrichVideo(element, createFile, options.logger);
        return video.thumbPath === undefined
            ? { element: video }
            : { element: video, generated: video.thumbPath };
    }
    return { element };
}

interface PreparedElement {
    element: CanonicalElement;
    bytes: number;
}

async function prepareElement(
    element: MediaElement,
    workspace: MediaWorkspace,
    createFile: MediaFileFactory,
    options: AcquireMediaOptions,
    remaining: number,
): Promise<PreparedElement> {
    const kind = MEDIA_TYPES[element.type];
    const maxBytes = Math.min(options.maxBytes ?? kind.maxBytes, kind.maxBytes, remaining);
    if (maxBytes <= 0) {
        throw new IpcError("单次发送媒体超过累计字节上限", "INVALID_PARAM");
    }
    const acquired = await acquireMedia(element, createFile, { ...kind, maxBytes }, options);
    if (!isMedia(acquired)) {
        return { element: acquired, bytes: 0 };
    }
    const bytes = await mediaSize(acquired.path, maxBytes);
    const enriched = await enrichElement(acquired, workspace, createFile, options);
    const generated =
        enriched.generated === undefined
            ? 0
            : await mediaSize(enriched.generated, remaining - bytes);
    return { element: enriched.element, bytes: bytes + generated };
}

export async function prepareOutboundMedia(
    elements: CanonicalElement[],
    options: AcquireMediaOptions & { outboundRoot?: string } = {},
): Promise<{ elements: CanonicalElement[]; cleanup: (uncertain?: boolean) => Promise<void> }> {
    if (elements.filter(isMedia).length > MAX_MEDIA_ITEMS) {
        throw new IpcError("单次发送媒体超过 16 项", "INVALID_PARAM");
    }
    const workspace = new MediaWorkspace(options.outboundRoot, () => {
        options.logger?.warn("无法清理发送媒体的临时目录");
    });
    const createFile = (extension: string) => workspace.file(extension);
    const prepared: CanonicalElement[] = [];
    const cache = new Map<string, PreparedElement>();
    let remaining = MAX_MESSAGE_MEDIA_BYTES;
    try {
        for (const element of elements) {
            if (!isMedia(element)) {
                prepared.push(element);
                continue;
            }
            const key = `${element.type}:${element.path}`;
            const result =
                cache.get(key) ??
                (await prepareElement(element, workspace, createFile, options, remaining));
            remaining -= result.bytes;
            if (remaining < 0) {
                throw new IpcError("单次发送媒体超过累计字节上限", "INVALID_PARAM");
            }
            cache.set(key, result);
            prepared.push(result.element);
        }
        return { elements: prepared, cleanup: (uncertain) => workspace.cleanup(uncertain) };
    } catch (error) {
        await workspace.cleanup();
        throw error;
    }
}
