/** 将 QQ 原生语音文件解码为 Koishi 可播放的 WAV。 */
import { realpathSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { type CanonicalElement, resolveDataRoot, resolveQqGlobalPath } from "@napuketto/kernel";
import { decodeSilkToWav } from "@napuketto/media";

import { isLocalPath } from "../../shared.js";

/** 已解码 WAV 的消费窗口（与清理重试相互独立）。 */
const VOICE_TTL_MS = 10 * 60 * 1000;
/** 保留给 Koishi 消费的 WAV 目录上限。 */
const MAX_CACHED_VOICES = 64;
/** 同时执行的 SILK 解码数；每个解码在 @napuketto/media 的 Worker 中运行。 */
const MAX_CONCURRENT_DECODES = 2;
/** 等待解码名额的有界队列长度；满时语音原样透传。 */
const MAX_WAITING_DECODES = 32;
/** 单条语音从排队到解码完成的总截止时间。 */
const DECODE_DEADLINE_MS = 10_000;
/** 临时目录清理失败后的重试次数（不含首次）。 */
const CLEANUP_RETRIES = 2;
/** 清理重试间隔。 */
const CLEANUP_RETRY_MS = 60_000;
/** 受控残留目录上限；超过后交由系统临时目录策略处理。 */
const MAX_RESIDUAL_DIRECTORIES = 32;
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

/** 单次 SILK → WAV 解码参数（可注入，便于单测控制耗时与失败）。 */
export interface VoiceDecodeRequest {
    /** 已通过 QQ 目录边界校验的 SILK 绝对路径。 */
    silk: string;
    /** 本次解码独占的输出目录。 */
    outDir: string;
    /** 取消信号；解码器应实际中止工作（@napuketto/media 会终止 Worker）。 */
    signal: AbortSignal;
}

export type VoiceDecoder = (request: VoiceDecodeRequest) => Promise<{ wavPath: string }>;

export interface VoiceEnricherOptions {
    /** WAV 消费窗口，缺省 10 分钟。 */
    ttlMs?: number;
    /** 保留的 WAV 目录上限，缺省 64。 */
    maxCached?: number;
    /** 同时解码数，缺省 2；与缓存占用相互独立。 */
    maxConcurrent?: number;
    /** 等待解码名额的队列上限，缺省 32。 */
    maxWaiting?: number;
    /** 排队 + 解码的总截止时间，缺省 10 秒。 */
    deadlineMs?: number;
    /** 清理失败后的重试次数，缺省 2。 */
    cleanupRetries?: number;
    /** 清理重试间隔，缺省 60 秒。 */
    cleanupRetryMs?: number;
    /** 受控残留目录上限，缺省 32。 */
    maxResidual?: number;
    /** 解码实现（缺省 @napuketto/media）。 */
    decode?: VoiceDecoder;
    /** 删除目录实现（缺省 rm -r）。 */
    removeDirectory?: (directory: string) => Promise<void>;
    /** 创建独占临时目录实现（缺省 mkdtemp）。 */
    createTempDirectory?: () => Promise<string>;
}

export interface VoiceEnricherStats {
    /** 正在解码的数量。 */
    decoding: number;
    /** 等待解码名额的数量。 */
    waiting: number;
    /** 已解码、等待消费的目录数量（不含残留）。 */
    cached: number;
    /** 清理失败后保留的残留目录数量。 */
    residual: number;
}

export interface VoiceEnricher {
    (
        elements: CanonicalElement[],
        qqGlobalPath?: string,
        warn?: (message: string) => void,
        signal?: AbortSignal,
    ): Promise<CanonicalElement[]>;
    /** 诊断/测试用计数。 */
    stats(): VoiceEnricherStats;
}

interface DecodeWaiter {
    readonly signal: AbortSignal;
    resolve(): void;
    reject(error: unknown): void;
    onAbort(): void;
}

interface RetainedVoice {
    timer: NodeJS.Timeout;
    attempts: number;
}

class VoiceCancelledError extends Error {
    constructor() {
        super("语音解码已取消");
        this.name = "AbortError";
    }
}

class VoiceQueueFullError extends Error {
    constructor() {
        super("语音解码等待队列已满");
        this.name = "VoiceQueueFullError";
    }
}

const defaultDecode: VoiceDecoder = async ({ silk, outDir, signal }) => {
    const { wavPath } = await decodeSilkToWav(silk, { outDir, signal });
    return { wavPath };
};

const defaultCreateTempDirectory = () => mkdtemp(join(tmpdir(), "napuketto-voice-"));
const defaultRemoveDirectory = (directory: string) =>
    rm(directory, { recursive: true, force: true, maxRetries: 3 });

/**
 * 创建收向语音解码器。
 *
 * 并发解码名额（maxConcurrent）限制同时运行的 Worker；缓存占用（maxCached）
 * 限制可供 Koishi 消费的 WAV 目录。等待队列有界，排队或解码超过截止时间、
 * 队列已满、缓存已满、路径不可信或解码失败时都回退原始语音路径。
 * 调用方可用 signal 取消（软重登/停止/退出），解码器会把取消继续传给
 * @napuketto/media，由其终止实际执行 SILK WASM 的 Worker。
 */
export function createVoiceEnricher(options: VoiceEnricherOptions = {}): VoiceEnricher {
    const ttlMs = options.ttlMs ?? VOICE_TTL_MS;
    const maxCached = options.maxCached ?? MAX_CACHED_VOICES;
    const maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT_DECODES;
    const maxWaiting = options.maxWaiting ?? MAX_WAITING_DECODES;
    const deadlineMs = options.deadlineMs ?? DECODE_DEADLINE_MS;
    const cleanupRetries = options.cleanupRetries ?? CLEANUP_RETRIES;
    const cleanupRetryMs = options.cleanupRetryMs ?? CLEANUP_RETRY_MS;
    const maxResidual = options.maxResidual ?? MAX_RESIDUAL_DIRECTORIES;
    const decode = options.decode ?? defaultDecode;
    const createTempDirectory = options.createTempDirectory ?? defaultCreateTempDirectory;
    const removeDirectory = options.removeDirectory ?? defaultRemoveDirectory;

    let decoding = 0;
    const waiting: DecodeWaiter[] = [];
    const retained = new Map<string, RetainedVoice>();
    const residual = new Set<string>();

    function releaseSlot(): void {
        decoding -= 1;
        const next = waiting.shift();
        if (next !== undefined) {
            decoding += 1;
            next.resolve();
        }
    }

    function acquireSlot(signal: AbortSignal): Promise<void> {
        if (signal.aborted) {
            return Promise.reject(new VoiceCancelledError());
        }
        if (decoding < maxConcurrent) {
            decoding += 1;
            return Promise.resolve();
        }
        if (waiting.length >= maxWaiting) {
            return Promise.reject(new VoiceQueueFullError());
        }
        return new Promise<void>((resolveSlot, rejectSlot) => {
            const waiter: DecodeWaiter = {
                signal,
                resolve: () => {
                    signal.removeEventListener("abort", waiter.onAbort);
                    resolveSlot();
                },
                reject: (error) => {
                    signal.removeEventListener("abort", waiter.onAbort);
                    rejectSlot(error);
                },
                onAbort: () => {
                    const index = waiting.indexOf(waiter);
                    if (index >= 0) {
                        waiting.splice(index, 1);
                    }
                    waiter.reject(new VoiceCancelledError());
                },
            };
            signal.addEventListener("abort", waiter.onAbort, { once: true });
            waiting.push(waiter);
        });
    }

    function recordResidual(directory: string, warn?: (message: string) => void): void {
        if (residual.size >= maxResidual) {
            // 不误删仍在使用的文件，也不无界累积；交给系统临时目录策略。
            warn?.("语音临时目录残留已达上限，交由系统临时目录策略清理");
            return;
        }
        residual.add(directory);
        warn?.("语音临时目录清理失败，已保留以待系统临时目录策略清理");
    }

    /** 清理解码失败/取消产生的目录；首次立即尝试，失败后有限重试。 */
    async function discardDetached(
        directory: string,
        warn?: (message: string) => void,
        attempt = 0,
    ): Promise<void> {
        try {
            await removeDirectory(directory);
            residual.delete(directory);
        } catch {
            if (attempt < cleanupRetries) {
                warn?.("入站语音临时目录清理失败，将重试");
                const timer = setTimeout(() => {
                    void discardDetached(directory, warn, attempt + 1);
                }, cleanupRetryMs);
                timer.unref?.();
                return;
            }
            recordResidual(directory, warn);
        }
    }

    /** 消费窗口到期：成功删除后释放缓存名额；反复失败也释放名额并保留受限残留。 */
    async function expire(directory: string, warn?: (message: string) => void): Promise<void> {
        const entry = retained.get(directory);
        if (entry === undefined) {
            return;
        }
        try {
            await removeDirectory(directory);
            retained.delete(directory);
            residual.delete(directory);
        } catch {
            entry.attempts += 1;
            if (entry.attempts <= cleanupRetries) {
                entry.timer = setTimeout(() => {
                    void expire(directory, warn);
                }, cleanupRetryMs);
                entry.timer.unref?.();
                warn?.("入站语音临时目录清理失败，将重试");
                return;
            }
            // 名额必须释放：否则反复清理失败会让后续语音永久无法解码。
            retained.delete(directory);
            recordResidual(directory, warn);
        }
    }

    function retain(directory: string, warn?: (message: string) => void): void {
        const timer = setTimeout(() => {
            void expire(directory, warn);
        }, ttlMs);
        timer.unref?.();
        retained.set(directory, { timer, attempts: 0 });
    }

    async function toPlayableVoice(
        path: string,
        qqGlobalPath: string | undefined,
        warn: ((message: string) => void) | undefined,
        signal: AbortSignal | undefined,
    ): Promise<string> {
        if (retained.size >= maxCached) {
            return path;
        }
        const silk = resolveQqVoiceFile(path, qqGlobalPath);
        if (silk === null) {
            return path;
        }

        const controller = new AbortController();
        let timedOut = false;
        const abortFromCaller = () => controller.abort(new VoiceCancelledError());
        if (signal !== undefined) {
            if (signal.aborted) {
                return path;
            }
            signal.addEventListener("abort", abortFromCaller, { once: true });
        }
        const deadline = setTimeout(() => {
            timedOut = true;
            controller.abort(new VoiceCancelledError());
        }, deadlineMs);
        deadline.unref?.();

        let directory: string | undefined;
        let holdsSlot = false;
        try {
            await acquireSlot(controller.signal);
            holdsSlot = true;
            directory = await createTempDirectory();
            const { wavPath } = await decode({
                silk,
                outDir: directory,
                signal: controller.signal,
            });
            if (controller.signal.aborted) {
                await discardDetached(directory, warn);
                return path;
            }
            // 缓存名额在解码期间可能已被其他协程占满；此时清理本次输出并透传。
            if (retained.size >= maxCached) {
                await discardDetached(directory, warn);
                return path;
            }
            retain(directory, warn);
            return wavPath;
        } catch (error) {
            if (directory !== undefined) {
                await discardDetached(directory, warn);
            }
            if (timedOut) {
                warn?.("语音解码超时，已回退原始路径");
            } else if (error instanceof VoiceQueueFullError) {
                warn?.("语音解码队列已满，已回退原始路径");
            } else if (!(error instanceof VoiceCancelledError) && !controller.signal.aborted) {
                warn?.("语音解码失败，已回退原始路径");
            }
            return path;
        } finally {
            clearTimeout(deadline);
            signal?.removeEventListener("abort", abortFromCaller);
            if (holdsSlot) {
                releaseSlot();
            }
        }
    }

    const enrich = (async (
        elements: CanonicalElement[],
        qqGlobalPath?: string,
        warn?: (message: string) => void,
        signal?: AbortSignal,
    ): Promise<CanonicalElement[]> => {
        const out: CanonicalElement[] = [];
        for (const el of elements) {
            if (el.type === "voice" && el.path !== "" && !REMOTE_PATH.test(el.path)) {
                out.push({
                    ...el,
                    path: await toPlayableVoice(el.path, qqGlobalPath, warn, signal),
                });
            } else {
                out.push(el);
            }
        }
        return out;
    }) as VoiceEnricher;

    enrich.stats = () => ({
        decoding,
        waiting: waiting.length,
        cached: retained.size,
        residual: residual.size,
    });

    return enrich;
}

const enrichVoiceWithDirectory = createVoiceEnricher();

/** 在派发前将 NT SILK 转为限时可消费的 WAV。 */
export function enrichReceiveVoice(
    elements: CanonicalElement[],
    dataRoot?: string,
    warn?: (message: string) => void,
    signal?: AbortSignal,
): Promise<CanonicalElement[]> {
    return enrichVoiceWithDirectory(elements, resolveHostQqGlobalPath(dataRoot), warn, signal);
}
