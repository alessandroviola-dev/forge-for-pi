// Qualification against the real installed Pi CLI, without sending a prompt.
// --source tests generated launchers before installation; default tests installed launchers.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const names = ["FORGE_FOR_PI", "FORGE_FOR_PI_TRACE", "FORGE_FOR_PI_SNAPSHOT_SCOPE",
  "FORGEJEV", "FORGEJEV_TRACE", "FORGEJEV_JEV_ROUTING", "FORGEAPIS", "FORGEAPIS_TRACE", "FORGEAPIS_JEV_ROUTING"];
const cleanEnv = { ...process.env };
for (const key of names) delete cleanEnv[key];
const pi = execFileSync("bash", ["-c", "command -v pi"], { env: cleanEnv, encoding: "utf8" }).trim();
const realPi = await realpath(pi);
const piPackage = await findPiPackage(realPi);

async function findPiPackage(entrypoint) {
  let directory = dirname(entrypoint);
  while (true) {
    try {
      const metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if (metadata.name === "@earendil-works/pi-coding-agent") return metadata;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error("Pi package metadata not found above its real entrypoint");
    directory = parent;
  }
}
assert.equal(piPackage.name, "@earendil-works/pi-coding-agent", "pi resolves to the real Pi package, not a Forge wrapper");
assert.equal(execFileSync(pi, ["--version"], { env: cleanEnv, encoding: "utf8" }).trim(), "1.0.4");
const piModule = pathToFileURL(join(dirname(realPi), "index.js")).href;
const root = await mkdtemp(join(tmpdir(), "forge-runtime-"));
const agent = resolve(process.env.PI_CODING_AGENT_DIR || join(process.env.HOME, ".pi/agent"));
const expectedEntry = await realpath(join(agent, "extensions/forge-for-pi/index.ts"));
const results = [];

try {
  const preload = join(root, "inspect-loader.mjs");
  // Observe Pi's own loader after factory execution. No test extension or tool is registered.
  await writeFile(preload, `
import { DefaultResourceLoader } from ${JSON.stringify(piModule)};
import { writeFile } from "node:fs/promises";
const reload = DefaultResourceLoader.prototype.reload;
DefaultResourceLoader.prototype.reload = async function (...args) {
  await reload.apply(this, args);
  const result = this.getExtensions();
  await writeFile(process.env.FORGE_QUALIFICATION_REPORT, JSON.stringify({
    extensions: result.extensions.map((e) => ({
      path: e.path, tools: [...e.tools.keys()], commands: [...e.commands.keys()],
      flags: [...e.flags.keys()], handlers: [...e.handlers.keys()]
    })),
    errorCount: result.errors.length,
    env: Object.fromEntries(${JSON.stringify(names)}.map((name) => [name, process.env[name] ?? null]))
  }));
};
`);
  let launcherDir = join(process.env.HOME, ".local/bin");
  if (process.argv.includes("--source")) {
    launcherDir = root;
    const install = await readFile(new URL("../scripts/install.sh", import.meta.url), "utf8");
    const bodies = [...install.matchAll(/cat > "\$temporary" <<'EOF'\n([\s\S]*?)\nEOF/g)].map((m) => m[1]);
    for (const name of ["Forge", "Forgetrace"]) {
      const body = bodies.find((s) => s.includes("FORGE_FOR_PI_TRACE=1") === (name === "Forgetrace"));
      assert.ok(body);
      await writeFile(join(root, name), `${body}\n`, { mode: 0o755 });
    }
  }

  const scenarios = [["Forge", false], ["Forge", true], ["Forgetrace", false], ["Forgetrace", true], ["pi", false]];
  for (const [name, contaminated] of scenarios) {
    const report = join(root, `${name}-${contaminated}.json`);
    // Plain Pi is tested only with a CLEAN activation environment. Raw Pi
    // with deliberate sibling opt-ins is outside the Forge launcher's contract.
    const env = { ...cleanEnv };
    if (contaminated) for (const key of names.filter((key) => key.startsWith("FORGEJEV") || key.startsWith("FORGEAPIS"))) env[key] = "1";
    Object.assign(env, { NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`,
      FORGE_QUALIFICATION_REPORT: report, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" });
    const response = await run(name === "pi" ? pi : join(launcherDir, name), env);
    assert.equal(response.success, true, `${name}: RPC get_state succeeded`);
    assert.equal(response.data.isStreaming, false);
    const observed = JSON.parse(await readFile(report, "utf8"));
    assert.equal(observed.errorCount, 0, `${name}: no extension load errors`);
    if (name === "pi") {
      const products = observed.extensions.filter((e) => /\/(forge-for-pi|forgejev|forgeapis)\/index\.ts$/.test(e.path));
      for (const e of products) {
        for (const kind of ["tools", "commands", "flags", "handlers"]) assert.equal(e[kind].length, 0, `${e.path}: inactive ${kind}`);
      }
      for (const key of names) assert.equal(observed.env[key], null);
    } else {
      assert.equal(observed.extensions.length, 1, `${name}: exactly one extension loaded`);
      assert.equal(await realpath(observed.extensions[0].path), expectedEntry);
      assert.deepEqual(observed.extensions[0].tools.sort(), ["edit", "read"]);
      assert.equal(observed.extensions[0].commands.length, 0);
      assert.equal(observed.extensions[0].flags.length, 0);
      assert.ok(observed.extensions[0].handlers.includes("session_start"));
      assert.equal(observed.env.FORGE_FOR_PI, "1");
      assert.equal(observed.env.FORGE_FOR_PI_TRACE, name === "Forgetrace" ? "1" : null);
      for (const key of names.filter((key) => key.startsWith("FORGEJEV") || key.startsWith("FORGEAPIS"))) assert.equal(observed.env[key], null);
    }
    results.push({ launcher: name, environment: contaminated ? "sibling activation=1" : "clean", result: "PASS", modelCalls: 0 });
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}

function run(command, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, ["--mode", "rpc", "--no-session", "--offline", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files"], {
      cwd: root, env, stdio: ["pipe", "pipe", "pipe"],
    });
    let response;
    let buffer = "";
    let stderr = "";
    const deadline = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Pi runtime qualification timeout")); }, 30_000);
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (message.type === "response" && message.id === "qualification-state") {
            response = message;
            child.stdin.end();
          }
        } catch { child.kill("SIGKILL"); reject(new Error("Pi emitted invalid RPC JSON")); }
      }
    });
    child.on("error", (error) => { clearTimeout(deadline); reject(error); });
    child.on("close", (code) => {
      clearTimeout(deadline);
      // Never dump user configuration, provider state or captured stderr.
      if (code !== 0 || !response || /Error in extension|Failed to load extension/i.test(stderr)) reject(new Error(`Pi runtime qualification failed (exit ${code})`));
      else resolveRun(response);
    });
    child.stdin.on("error", () => {});
    child.stdin.write(`${JSON.stringify({ type: "get_state", id: "qualification-state" })}\n`);
  });
}
