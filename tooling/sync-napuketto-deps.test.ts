import assert from "node:assert/strict";
import { test } from "vitest";
import { planUpdate, verifyGroup } from "./sync-napuketto-deps.js";

function fixture() {
    const latest = {
        "@napuketto/adapter": "0.18.20",
        "@napuketto/kernel": "0.16.3",
        "@napuketto/loader": "0.10.8",
        "@napuketto/media": "0.2.2",
        "@napuketto/network": "0.4.5",
    };
    const manifest = {
        dependencies: Object.fromEntries(
            Object.entries(latest).map(([name, version]) => [name, `^${version}`]),
        ),
    };
    const locked = {
        dependencies: Object.fromEntries(
            Object.entries(latest).map(([name, version]) => [name, { version }]),
        ),
    };
    return { manifest, locked, latest };
}

test("preserves ranges and produces one plan for the whole group", () => {
    const { manifest, locked, latest } = fixture();
    assert.deepEqual(planUpdate(manifest, locked, latest), {});
    manifest.dependencies["@napuketto/kernel"] = "~0.16.3";
    manifest.dependencies["@napuketto/loader"] = "0.10.8";
    latest["@napuketto/kernel"] = "0.17.0";
    latest["@napuketto/loader"] = "0.10.9";
    assert.deepEqual(planUpdate(manifest, locked, latest), {
        "@napuketto/kernel": "~0.17.0",
        "@napuketto/loader": "0.10.9",
    });
});

test("rejects missing, prerelease and rolled-back latest tags", () => {
    const { manifest, locked, latest } = fixture();
    const name = "@napuketto/loader";
    for (const version of [undefined, "0.11.0-rc.1", "0.10.7"]) {
        assert.throws(
            () => planUpdate(manifest, locked, { ...latest, [name]: version }),
            /@napuketto\/loader/,
        );
    }
    locked.dependencies[name] = { version: "0.10.9" };
    assert.throws(() => planUpdate(manifest, locked, latest), /lock=0.10.9/);
});

test("rejects lockfile fallback and a split transitive Napuketto release", () => {
    const { locked, latest } = fixture();
    verifyGroup(locked, latest);
    assert.throws(
        () => verifyGroup(locked, { ...latest, "@napuketto/kernel": "0.16.4" }),
        /目标=0.16.4/,
    );
    const split = {
        dependencies: {
            ...locked.dependencies,
            "@napuketto/adapter": {
                version: latest["@napuketto/adapter"],
                dependencies: { "@napuketto/kernel": { version: "0.16.2" } },
            },
        },
    };
    assert.throws(() => verifyGroup(split, latest), /adapter@0.18.20 → @napuketto\/kernel@0.16.2/);
});

test("checks both regular and optional entries with the same name", () => {
    const { locked, latest } = fixture();
    const mixed = {
        dependencies: {
            ...locked.dependencies,
            "@napuketto/adapter": {
                version: latest["@napuketto/adapter"],
                dependencies: { "@napuketto/kernel": { version: "0.16.2" } },
            },
        },
        optionalDependencies: {
            "@napuketto/adapter": { version: latest["@napuketto/adapter"] },
        },
    };
    assert.throws(() => verifyGroup(mixed, latest), /@napuketto\/kernel@0.16.2/);
});

test("reports oversized dependency depth before recursing further", () => {
    type Entry = { version: string; dependencies?: Record<string, Entry> };
    let entry: Entry = { version: "1.0.0" };
    for (let depth = 0; depth < 130; depth += 1) {
        entry = { version: "1.0.0", dependencies: { child: entry } };
    }
    const { locked, latest } = fixture();
    assert.throws(
        () => verifyGroup({ ...locked, optionalDependencies: { entry } }, latest),
        /依赖树超过检查预算/,
    );
});
