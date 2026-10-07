import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const install = await readFile(new URL("../scripts/install.sh", import.meta.url), "utf8");
const bodies = [...install.matchAll(/cat > "\$temporary" <<'EOF'\n([\s\S]*?)\nEOF/g)].map((m) => m[1]);
const siblingVariables = [
  "FORGEJEV", "FORGEJEV_TRACE", "FORGEJEV_JEV_ROUTING",
  "FORGEAPIS", "FORGEAPIS_TRACE", "FORGEAPIS_JEV_ROUTING",
];
const forgeVariables = ["FORGE_FOR_PI", "FORGE_FOR_PI_TRACE", "FORGE_FOR_PI_SNAPSHOT_SCOPE"];

function assertSameDirectory(actual, expected) {
  assert.equal(realpathSync(actual), realpathSync(expected));
}

async function fixture(name) {
  const root = await mkdtemp(join(tmpdir(), "forge launcher "));
  const body = bodies.find((s) => s.includes("FORGE_FOR_PI_TRACE=1") === (name === "Forgetrace"));
  assert.ok(body, `${name} launcher heredoc exists`);
  const launcher = join(root, name);
  const cwd = join(root, "user project");
  await mkdir(cwd);
  await writeFile(launcher, `${body}\n`, { mode: 0o755 });
  await writeFile(join(root, "pi"), `#!${process.execPath}
const names = ${JSON.stringify([...forgeVariables, ...siblingVariables])};
console.log(JSON.stringify({
  cwd: process.cwd(),
  args: process.argv.slice(2),
  env: Object.fromEntries(names.map((name) => [name, process.env[name] ?? null]))
}));
`, { mode: 0o755 });
  return { root, launcher, cwd };
}

for (const name of ["Forge", "Forgetrace"]) {
  for (const contaminated of [false, true]) {
    test(`${name}: ${contaminated ? "contaminated" : "clean"} environment isolates siblings, cwd and arguments`, async () => {
      const f = await fixture(name);
      try {
        const env = { PATH: `${f.root}:${process.env.PATH}`, HOME: f.root, FORGE_FOR_PI_SNAPSHOT_SCOPE: "project" };
        if (contaminated) for (const key of siblingVariables) env[key] = "1";
        const args = ["--thinking", "low", "prompt with spaces", "--literal=$value"];
        const result = spawnSync(f.launcher, args, { cwd: f.cwd, env, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        const observed = JSON.parse(result.stdout);
        assert.equal(observed.env.FORGE_FOR_PI, "1");
        assert.equal(observed.env.FORGE_FOR_PI_TRACE, name === "Forgetrace" ? "1" : null);
        assert.equal(observed.env.FORGE_FOR_PI_SNAPSHOT_SCOPE, "project");
        for (const key of siblingVariables) assert.equal(observed.env[key], null, key);
        assertSameDirectory(observed.cwd, f.cwd);
        assert.deepEqual(observed.args, [
          "--no-extensions", "--extension", join(f.root, ".pi/agent/extensions/forge-for-pi/index.ts"),
          "--no-skills", ...args,
        ]);
      } finally { await rm(f.root, { recursive: true, force: true }); }
    });
  }
}

test("cwd comparison accepts filesystem aliases but rejects genuinely different directories", async () => {
  const f = await fixture("Forge");
  try {
    assertSameDirectory(f.cwd, realpathSync(f.cwd));
    assert.throws(() => assertSameDirectory(f.root, f.cwd), assert.AssertionError);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("Forge preserves caller Forge trace/snapshot options and custom agent directory with spaces", async () => {
  const f = await fixture("Forge");
  try {
    const agent = join(f.root, "custom agent");
    const result = spawnSync(f.launcher, [], {
      cwd: f.cwd, encoding: "utf8",
      env: { PATH: `${f.root}:${process.env.PATH}`, HOME: f.root, PI_CODING_AGENT_DIR: agent,
        FORGE_FOR_PI: "0", FORGE_FOR_PI_TRACE: "1", FORGE_FOR_PI_SNAPSHOT_SCOPE: "all" },
    });
    assert.equal(result.status, 0, result.stderr);
    const observed = JSON.parse(result.stdout);
    assert.equal(observed.env.FORGE_FOR_PI, "1");
    assert.equal(observed.env.FORGE_FOR_PI_TRACE, "1");
    assert.equal(observed.env.FORGE_FOR_PI_SNAPSHOT_SCOPE, "all");
    assert.equal(observed.args[2], join(agent, "extensions/forge-for-pi/index.ts"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("installer and verifier pin exactly Pi 1.0.4 and only manage Forge destinations", async () => {
  const verify = await readFile(new URL("../scripts/verify-install.sh", import.meta.url), "utf8");
  for (const script of [install, verify]) {
    assert.match(script, /EXPECTED_PI_VERSION="1\.0\.4"/);
    assert.doesNotMatch(script, /0\.84\.4/);
  }
  assert.match(install, /TARGET_DIR="\$EXTENSIONS_DIR\/forge-for-pi"/);
  assert.match(install, /write_launcher Forge 0/);
  assert.match(install, /write_launcher Forgetrace 1/);
  assert.doesNotMatch(install, /write_launcher (?:ForgeJev|ForgeApis)/);
  assert.match(verify, /diff -qr "\$SOURCE_DIR" "\$TARGET_DIR"/);
});
