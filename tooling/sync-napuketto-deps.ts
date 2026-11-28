import type { ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { extname, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

interface Manifest {
    dependencies: Record<string, string>;
    peerDependencies: Record<string, string>;
}

interface DependencyTree {
    dependencies?: Record<string, LockedDependency>;
    optionalDependencies?: Record<string, LockedDependency>;
}

interface LockedDependency extends DependencyTree {
    version: string;
}

interface LockImporter extends DependencyTree {
    devDependencies?: Record<string, LockedDependency>;
}

const packages = [
    "@napuketto/adapter",
    "@napuketto/kernel",
    "@napuketto/loader",
    "@napuketto/media",
    "@napuketto/network",
];
const hosts = ["koishi", "@koishijs/plugin-console"];
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const supportedRange = /^([~^]?)(\d+\.\d+\.\d+)$/;

function isStableVersion(value: unknown): value is string {
    return typeof value === "string" && stableVersion.test(value);
}

function compare(a: string, b: string): number {
    const [major = 0, minor = 0, patch = 0] = a.split(".").map(Number);
    const [otherMajor = 0, otherMinor = 0, otherPatch = 0] = b.split(".").map(Number);
    return major - otherMajor || minor - otherMinor || patch - otherPatch;
}

export function planUpdate(
    manifest: Pick<Manifest, "dependencies">,
    locked: LockImporter,
    latest: Record<string, string | undefined>,
): Record<string, string> {
    const changes: Record<string, string> = {};
    for (const name of packages) {
        const range = manifest.dependencies[name];
        const [, operator, floor] = supportedRange.exec(range ?? "") ?? [];
        const current = locked.dependencies?.[name]?.version;
        const target = latest[name];
        if (
            operator === undefined ||
            floor === undefined ||
            !isStableVersion(current) ||
            !isStableVersion(target)
        ) {
            throw new Error(
                `${name}: 需要稳定的单版本范围及锁定版本（manifest=${range}, lock=${current}, latest=${target}）`,
            );
        }
        if (compare(target, floor) < 0 || compare(target, current) < 0) {
            throw new Error(
                `${name}: latest=${target} 低于 manifest=${range} 或 lock=${current}，请核对 dist-tag`,
            );
        }
        if (floor !== target || current !== target) {
            changes[name] = `${operator}${target}`;
        }
    }
    return changes;
}

export function verifyGroup(locked: LockImporter, targets?: Record<string, string>): void {
    const roots = locked.dependencies ?? {};
    for (const name of packages) {
        const actual = roots[name]?.version;
        if (!isStableVersion(actual) || (targets && actual !== targets[name])) {
            throw new Error(`${name}: 锁定版本=${actual}，目标=${targets?.[name] ?? "稳定版"}`);
        }
    }
    verifyTransitive(locked, roots);
}

function verifyTransitive(locked: DependencyTree, roots: Record<string, LockedDependency>): void {
    const maxDepth = 128;
    const maxEntries = 50_000;
    let remaining = maxEntries;
    function visit(node: DependencyTree, chain: string[]): void {
        for (const group of [node.dependencies, node.optionalDependencies]) {
            for (const [name, dep] of Object.entries(group ?? {})) {
                remaining -= 1;
                if (chain.length >= maxDepth || remaining < 0) {
                    throw new Error(
                        `pnpm 依赖树超过检查预算（深度 ${maxDepth}，条目 ${maxEntries}）`,
                    );
                }
                const path = [...chain, `${name}@${dep.version}`];
                const rootVersion = roots[name]?.version;
                if (packages.includes(name) && dep.version !== rootVersion) {
                    throw new Error(`${path.join(" → ")}，根依赖锁定为 ${name}@${rootVersion}`);
                }
                if (dep.dependencies || dep.optionalDependencies) visit(dep, path);
            }
        }
    }
    visit(locked, []);
}

function pnpm(args: string[], capture = false): string {
    const cli = process.env["npm_execpath"];
    if (!cli || !isAbsolute(cli)) {
        throw new Error("请使用 pnpm run deps:sync 调用同步工具");
    }
    const options: ExecFileSyncOptionsWithStringEncoding = {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    };
    const extension = extname(cli).toLowerCase();
    if ([".js", ".cjs", ".mjs"].includes(extension)) {
        return execFileSync(process.execPath, [cli, ...args], options) ?? "";
    }
    return execFileSync(cli, args, options) ?? "";
}

function readLock(...args: string[]): LockImporter {
    const [locked] = JSON.parse(
        pnpm(["list", "--lockfile-only", ...args, "--json"], true),
    ) as LockImporter[];
    if (!locked) throw new Error("pnpm list 未返回根项目");
    return locked;
}

async function readLatest(name: string): Promise<[string, string]> {
    const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`;
    try {
        const response = await fetch(url, {
            cache: "no-store",
            signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const { version } = (await response.json()) as { version?: unknown };
        if (!isStableVersion(version)) throw new Error(`latest=${version} 不是稳定版本`);
        return [name, version];
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${name}: 读取 npm latest 失败（${message}），请重试并检查 registry`, {
            cause: error,
        });
    }
}

async function verifyHosts(): Promise<void> {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as Manifest;
    const locked = readLock("--depth=0");
    const latest = await Promise.all(hosts.map(readLatest));
    for (const [name, target] of latest) {
        const version = locked.devDependencies?.[name]?.version;
        const range = manifest.peerDependencies[name];
        if (range === undefined) throw new Error(`${name}: 缺少 peer 依赖范围`);
        if (version !== target) {
            throw new Error(
                `${name}: 测试宿主=${version}, npm latest=${target}，请等待发布龄或检查宿主兼容性`,
            );
        }
        const matches = JSON.parse(pnpm(["view", `${name}@${range}`, "version", "--json"], true)) as
            | string
            | string[];
        if (![matches].flat().includes(version)) {
            throw new Error(`${name}@${version} 超出对外声明的 peer 范围 ${range}`);
        }
        console.log(`${name}: 测试宿主=${version}, peer=${range}, npm latest=${target}`);
    }
}

async function main(mode: string | undefined): Promise<void> {
    if (mode === "--verify-hosts") return verifyHosts();
    const lockArgs = ["--depth=Infinity", "--prod"];
    const locked = readLock(...lockArgs);
    if (mode === "--verify") {
        verifyGroup(locked);
        console.log(
            packages.map((name) => `${name}@${locked.dependencies?.[name]?.version}`).join("\n"),
        );
        return;
    }
    if (mode !== "--update") {
        throw new Error(
            "用法: node tooling/sync-napuketto-deps.ts --update|--verify|--verify-hosts",
        );
    }

    const manifestPath = "package.json";
    const original = readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(original) as Manifest;
    const latest = Object.fromEntries(await Promise.all(packages.map(readLatest)));
    for (const [name, target] of Object.entries(latest)) {
        console.log(
            `${name}: manifest=${manifest.dependencies[name]}, lock=${locked.dependencies?.[name]?.version}, latest=${target}`,
        );
    }
    const changes = planUpdate(manifest, locked, latest);
    if (!Object.keys(changes).length) {
        verifyGroup(locked, latest);
        console.log("五包已与 npm latest 同步");
        return;
    }

    const lockPath = "pnpm-lock.yaml";
    const originalLock = readFileSync(lockPath);
    try {
        Object.assign(manifest.dependencies, changes);
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 4)}\n`);
        pnpm(["install", "--lockfile-only", "--ignore-scripts", "--strict-peer-dependencies"]);
        verifyGroup(readLock(...lockArgs), latest);
        // Registry metadata can become visible before every tarball is downloadable.
        pnpm(["install", "--frozen-lockfile", "--ignore-scripts", "--strict-peer-dependencies"]);
    } catch (error) {
        writeFileSync(manifestPath, original);
        writeFileSync(lockPath, originalLock);
        throw new Error(
            "五包无法按 npm latest 一起安装，请核对 tarball、上游整批发布、组内范围和 pnpm 发布龄日志",
            { cause: error },
        );
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv[2]).catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
