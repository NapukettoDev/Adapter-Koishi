import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

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

function compare(a, b) {
    const [major, minor, patch] = a.split(".").map(Number);
    const [otherMajor, otherMinor, otherPatch] = b.split(".").map(Number);
    return major - otherMajor || minor - otherMinor || patch - otherPatch;
}

export function planUpdate(manifest, locked, latest) {
    const changes = {};
    for (const name of packages) {
        const range = manifest.dependencies[name];
        const match = supportedRange.exec(range);
        const current = locked.dependencies[name]?.version;
        const target = latest[name];
        if (!match || !stableVersion.test(current) || !stableVersion.test(target)) {
            throw new Error(`${name}: 需要稳定的单版本范围及锁定版本（manifest=${range}, lock=${current}, latest=${target}）`);
        }
        const [, operator, floor] = match;
        if (compare(target, floor) < 0 || compare(target, current) < 0) {
            throw new Error(`${name}: latest=${target} 低于 manifest=${range} 或 lock=${current}，请核对 dist-tag`);
        }
        if (floor !== target || current !== target) {
            changes[name] = `${operator}${target}`;
        }
    }
    return changes;
}

export function verifyGroup(locked, targets) {
    for (const name of packages) {
        const actual = locked.dependencies[name]?.version;
        if (!stableVersion.test(actual) || (targets && actual !== targets[name])) {
            throw new Error(`${name}: 锁定版本=${actual}，目标=${targets?.[name] ?? "稳定版"}`);
        }
    }
    verifyTransitive(locked, locked.dependencies);
}

function verifyTransitive(node, roots, chain = []) {
    for (const [name, dep] of Object.entries({ ...node.dependencies, ...node.optionalDependencies })) {
        const path = [...chain, `${name}@${dep.version}`];
        if (packages.includes(name) && dep.version !== roots[name].version) {
            throw new Error(`${path.join(" → ")}，根依赖锁定为 ${name}@${roots[name].version}`);
        }
        if (dep.dependencies || dep.optionalDependencies) verifyTransitive(dep, roots, path);
    }
}

function pnpm(args, capture = false) {
    const options = {
        encoding: "utf8",
        stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    };
    if (process.platform === "win32") {
        // The Windows launcher is a .cmd shim. Accept only shell-safe pnpm arguments.
        if (args.some((arg) => !/^[\w@./=+^~*<>| -]+$/.test(arg))) {
            throw new Error("Windows 下不支持这组 pnpm 参数");
        }
        return execFileSync(`pnpm ${args.map((arg) => `"${arg}"`).join(" ")}`, { ...options, shell: true });
    }
    return execFileSync("pnpm", args, options);
}

function readLock() {
    return JSON.parse(pnpm(["list", "--lockfile-only", "--depth=Infinity", "--prod", "--json"], true))[0];
}

async function readLatest(name) {
    const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`;
    try {
        const response = await fetch(url, {
            cache: "no-store",
            signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const { version } = await response.json();
        if (!stableVersion.test(version)) throw new Error(`latest=${version} 不是稳定版本`);
        return [name, version];
    } catch (error) {
        throw new Error(`${name}: 读取 npm latest 失败（${error.message}），请重试并检查 registry`, { cause: error });
    }
}

async function verifyHosts() {
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    const [locked] = JSON.parse(pnpm(["list", "--lockfile-only", "--depth=0", "--json"], true));
    const latest = await Promise.all(hosts.map(readLatest));
    for (const [name, target] of latest) {
        const version = locked.devDependencies[name]?.version;
        const range = manifest.peerDependencies[name];
        if (version !== target) {
            throw new Error(`${name}: 测试宿主=${version}, npm latest=${target}，请等待发布龄或检查宿主兼容性`);
        }
        const matches = JSON.parse(pnpm(["view", `${name}@${range}`, "version", "--json"], true));
        if (![matches].flat().includes(version)) {
            throw new Error(`${name}@${version} 超出对外声明的 peer 范围 ${range}`);
        }
        console.log(`${name}: 测试宿主=${version}, peer=${range}, npm latest=${target}`);
    }
}

async function main(mode) {
    if (mode === "--verify-hosts") return verifyHosts();
    const locked = readLock();
    if (mode === "--verify") {
        verifyGroup(locked);
        console.log(packages.map((name) => `${name}@${locked.dependencies[name].version}`).join("\n"));
        return;
    }
    if (mode !== "--update") {
        throw new Error("用法: node tooling/sync-napuketto-deps.mjs --update|--verify|--verify-hosts");
    }

    const manifestPath = "package.json";
    const original = readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(original);
    const latest = Object.fromEntries(await Promise.all(packages.map(readLatest)));
    for (const [name, target] of Object.entries(latest)) {
        console.log(`${name}: manifest=${manifest.dependencies[name]}, lock=${locked.dependencies[name]?.version}, latest=${target}`);
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
        verifyGroup(readLock(), latest);
        // Registry metadata can become visible before every tarball is downloadable.
        pnpm(["install", "--frozen-lockfile", "--ignore-scripts", "--strict-peer-dependencies"]);
    } catch (error) {
        writeFileSync(manifestPath, original);
        writeFileSync(lockPath, originalLock);
        throw new Error("五包无法按 npm latest 一起安装，请核对 tarball、上游整批发布、组内范围和 pnpm 发布龄日志", { cause: error });
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv[2]).catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
