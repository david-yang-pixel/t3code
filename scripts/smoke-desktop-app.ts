// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Launches a packaged desktop app against a seeded T3 home, opens a thread, and checks its
// messages render. Release jobs run it so a build whose backend or bundle cannot start fails
// before it is published.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeUtil from "node:util";
import { _electron, chromium, type Browser, type ElectronApplication } from "playwright-core";

// A snapshot from an older build on purpose: the packaged server must migrate it forward, as it
// does for every upgrading user. It holds one project and two threads, nothing else.
const FIXTURE_DB = NodePath.join(import.meta.dirname, "fixtures/desktop-launch/statev2.sqlite");
const THREAD_TITLE = "Release launch check";
const THREAD_MESSAGE = "The release opens and shows this thread.";
const STEP_TIMEOUT_MS = 60_000;

const { values } = NodeUtil.parseArgs({
  options: {
    executable: { type: "string" },
    // An unpackaged app directory for a plain Electron executable, as PR CI runs it.
    app: { type: "string" },
    "artifacts-dir": { type: "string" },
    "renderer-cdp": { type: "boolean" },
  },
});
const executable = values.executable;
if (!executable)
  throw new Error(
    "Usage: smoke-desktop-app.ts --executable <app> [--app <dir>] [--artifacts-dir <dir>] [--renderer-cdp]",
  );
const artifactsDir = NodePath.resolve(values["artifacts-dir"] ?? "desktop-launch-check");

const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-desktop-launch-"));
const t3Home = NodePath.join(home, "t3");
NodeFS.mkdirSync(NodePath.join(t3Home, "userdata"), { recursive: true });
NodeFS.copyFileSync(FIXTURE_DB, NodePath.join(t3Home, "userdata/statev2.sqlite"));

let step = "launching the app";
let app: ElectronApplication | undefined;
let renderer: Browser | undefined;
let rendererProcess: NodeChildProcess.ChildProcess | undefined;
let rendererStderr = "";
const args = [...(values.app ? [NodePath.resolve(values.app)] : []), "--no-sandbox"];
const env = {
  ...process.env,
  XDG_CONFIG_HOME: NodePath.join(home, ".config"),
  XDG_DATA_HOME: NodePath.join(home, ".local/share"),
  T3CODE_HOME: t3Home,
  T3CODE_TELEMETRY_ENABLED: "false",
  T3CODE_DISABLE_AUTO_UPDATE: "true",
};

try {
  if (values["renderer-cdp"]) {
    // Packaged builds disable the Node inspector. Chromium's renderer endpoint suffices here.
    const child = NodeChildProcess.spawn(
      executable,
      [...args, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"],
      { env, stdio: ["ignore", "ignore", "pipe"] },
    );
    rendererProcess = child;
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      rendererStderr = `${rendererStderr}${chunk}`.slice(-12_000);
    });
    const lines = NodeReadline.createInterface({ input: child.stderr });
    const timeout = new AbortController();
    try {
      const endpoint = await Promise.race([
        new Promise<string>((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", (code, signal) => {
            reject(new Error(`Desktop app exited before CDP was ready (${code ?? signal}).`));
          });
          lines.on("line", (line) => {
            const url = line.match(/^DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)$/)?.[1];
            if (url) resolve(url);
          });
        }),
        NodeTimersPromises.setTimeout(STEP_TIMEOUT_MS, undefined, {
          signal: timeout.signal,
        }).then(() => {
          throw new Error("Timed out waiting for the desktop renderer's CDP endpoint.");
        }),
      ]);
      renderer = await chromium.connectOverCDP(endpoint, { timeout: STEP_TIMEOUT_MS });
    } finally {
      timeout.abort();
      lines.close();
      child.stderr.resume();
    }
  } else {
    app = await _electron.launch({
      executablePath: executable,
      args,
      env,
      timeout: STEP_TIMEOUT_MS,
    });
  }

  step = "waiting for the first window";
  const context = renderer?.contexts()[0];
  const page = app
    ? await app.firstWindow({ timeout: STEP_TIMEOUT_MS })
    : (context?.pages()[0] ?? (await context?.waitForEvent("page", { timeout: STEP_TIMEOUT_MS })));
  if (!page) throw new Error("Desktop app did not expose a browser context.");
  try {
    step = `finding "${THREAD_TITLE}" in the sidebar`;
    const thread = page.locator("li[data-thread-item]", { hasText: THREAD_TITLE });
    await thread.waitFor({ timeout: STEP_TIMEOUT_MS });
    step = "opening the thread";
    await thread.click();
    await page.getByText(THREAD_MESSAGE).waitFor({ timeout: STEP_TIMEOUT_MS });
  } catch (error) {
    NodeFS.mkdirSync(artifactsDir, { recursive: true });
    await page
      .screenshot({ path: NodePath.join(artifactsDir, "window.png"), timeout: 10_000 })
      .catch(() => {});
    throw error;
  }
  console.log("Desktop launch check passed: the app opened and showed the seeded thread.");
} catch (error) {
  console.error(`Desktop launch check failed while ${step}.`);
  NodeFS.mkdirSync(artifactsDir, { recursive: true });
  console.error(error instanceof Error ? error.message : error);
  if (rendererStderr) {
    NodeFS.writeFileSync(NodePath.join(artifactsDir, "renderer-stderr.log"), rendererStderr);
    console.error(rendererStderr);
  }
  const logs = NodePath.join(t3Home, "userdata/logs");
  if (NodeFS.existsSync(logs)) {
    NodeFS.cpSync(logs, NodePath.join(artifactsDir, "logs"), { recursive: true });
    const serverLog = NodePath.join(logs, "server-child.log");
    if (NodeFS.existsSync(serverLog)) {
      console.error("\nLast backend output (server-child.log):");
      console.error(NodeFS.readFileSync(serverLog, "utf8").split("\n").slice(-20).join("\n"));
    }
  }
  process.exitCode = 1;
} finally {
  rendererProcess?.kill("SIGTERM");
  await renderer?.close().catch(() => {});
  if (app) {
    // A hung app never finishes closing; kill it so the job does not wait for its timeout.
    // Playwright drops the process handle once the app closes, so read it first.
    const child = app.process();
    const closed = app.close().catch(() => {});
    await Promise.race([closed, NodeTimersPromises.setTimeout(10_000, undefined, { ref: false })]);
    child.kill("SIGKILL");
  }
  NodeFS.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
}
