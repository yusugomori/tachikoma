import { type ChildProcess, spawn } from "node:child_process";
import { request } from "node:http";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

export interface StartCodexAppServerProcessOptions {
  command?: string;
  port?: number;
  readyTimeoutMs?: number;
  detached?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Extra `codex` global args (e.g. `-c key=value` config overrides) placed before `app-server`. */
  configArgs?: string[];
}

export interface CodexAppServerProcess {
  pid: number;
  serverUrl: string;
  readyzUrl: string;
  child: ChildProcess;
  release(): void;
  stop(): Promise<void>;
}

export async function findFreePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.on("error", reject);
    server.listen(0, host, () => {
      const address = server.address();

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        if (typeof address === "object" && address && typeof address.port === "number") {
          resolve(address.port);
          return;
        }

        reject(new Error("Unable to allocate a free localhost port."));
      });
    });
  });
}

export async function startCodexAppServerProcess(
  options: StartCodexAppServerProcessOptions = {}
): Promise<CodexAppServerProcess> {
  const port = options.port ?? (await findFreePort());
  const serverUrl = `ws://127.0.0.1:${port}`;
  const readyzUrl = `http://127.0.0.1:${port}/readyz`;
  const command = options.command ?? process.env.TACHIKOMA_CODEX_COMMAND ?? "codex";
  const child = spawn(
    command,
    [...(options.configArgs ?? []), "app-server", "--listen", serverUrl],
    {
      detached: options.detached ?? true,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  const output: string[] = [];
  let spawnError: Error | undefined;

  child.stdout?.on("data", (chunk: Buffer | string) => {
    output.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    output.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
  });
  child.on("error", (error) => {
    spawnError = error;
    output.push(error.message);
  });

  await waitForReady({
    child,
    defaultReadyzUrl: readyzUrl,
    output,
    getSpawnError: () => spawnError,
    timeoutMs: options.readyTimeoutMs ?? 15000
  });

  const pid = child.pid;
  if (!pid) {
    throw new Error("Codex app-server process did not expose a PID.");
  }

  return {
    pid,
    serverUrl,
    readyzUrl,
    child,
    release: () => {
      releaseChild(child);
    },
    stop: async () => {
      await stopCodexAppServerPid(pid);
    }
  };
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    return code === "EPERM";
  }
}

export async function stopCodexAppServerPid(pid: number, timeoutMs = 5000): Promise<boolean> {
  if (!isProcessAlive(pid)) {
    return false;
  }

  process.kill(pid, "SIGTERM");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }

    await sleep(100);
  }

  if (isProcessAlive(pid)) {
    process.kill(pid, "SIGKILL");
  }

  return true;
}

function releaseChild(child: ChildProcess): void {
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

async function waitForReady(input: {
  child: ChildProcess;
  defaultReadyzUrl: string;
  output: string[];
  getSpawnError: () => Error | undefined;
  timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  const readyzUrls = new Set([input.defaultReadyzUrl]);

  while (Date.now() < deadline) {
    const log = input.output.join("");
    const discoveredReadyzUrl = discoverReadyzUrl(log);
    const spawnError = input.getSpawnError();

    if (discoveredReadyzUrl) {
      readyzUrls.add(discoveredReadyzUrl);
    }

    if (spawnError) {
      throw spawnError;
    }

    if (input.child.exitCode !== null || input.child.signalCode !== null) {
      throw new Error(`Codex app-server exited before readiness.${formatOutput(log)}`);
    }

    for (const readyzUrl of readyzUrls) {
      if (await isReady(readyzUrl)) {
        return;
      }
    }

    await sleep(100);
  }

  throw new Error(
    `Timed out waiting for Codex app-server readiness.${formatOutput(input.output.join(""))}`
  );
}

function discoverReadyzUrl(output: string): string | undefined {
  return output.match(/https?:\/\/[^\s"']+\/readyz/)?.[0];
}

function isReady(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(url, { timeout: 500 }, (res) => {
      res.resume();
      resolve(Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 300));
    });

    req.on("error", () => {
      resolve(false);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function formatOutput(output: string): string {
  const trimmed = output.trim();

  return trimmed ? ` output: ${trimmed}` : "";
}
