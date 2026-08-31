// Starts and monitors SSH tunnels for remote gateway access.
import { spawn } from "node:child_process";
import net from "node:net";
import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { formatErrorMessage, isErrno } from "./errors.js";
import { ensurePortAvailable, PortInUseError } from "./ports.js";
import { resolveSshClient } from "./ssh-client.js";

export type SshParsedTarget = {
  user?: string;
  host: string;
  port: number;
};

export type SshTunnel = {
  parsedTarget: SshParsedTarget;
  localPort: number;
  remotePort: number;
  pid: number | null;
  stderr: string[];
  stop: () => Promise<void>;
};

function hasControlOrWhitespace(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f || /\s/.test(char)) {
      return true;
    }
  }
  return false;
}

function isSafeSshTargetUser(user: string): boolean {
  return !hasControlOrWhitespace(user) && !user.startsWith("-");
}

// Reject hosts that would corrupt the SSH HostName field or enable argument
// injection. Parsed targets are later interpolated into unquoted ssh_config
// directives and argv, so each accepted user/host must stay one SSH token.
function isSafeSshTargetHost(host: string): boolean {
  return (
    !hasControlOrWhitespace(host) &&
    !host.startsWith("-") &&
    !host.startsWith(":") &&
    !host.endsWith(":") &&
    !host.includes("@")
  );
}

export function parseSshTarget(raw: string): SshParsedTarget | null {
  const trimmed = raw.trim().replace(/^ssh\s+/, "");
  if (!trimmed) {
    return null;
  }

  const [userPart, hostPart] = trimmed.includes("@")
    ? ((): [string | undefined, string] => {
        const idx = trimmed.indexOf("@");
        const user = trimmed.slice(0, idx).trim();
        const host = trimmed.slice(idx + 1).trim();
        return [user || undefined, host];
      })()
    : [undefined, trimmed];

  const colonIdx = hostPart.lastIndexOf(":");
  if (colonIdx > 0 && colonIdx < hostPart.length - 1) {
    const host = hostPart.slice(0, colonIdx).trim();
    const portRaw = hostPart.slice(colonIdx + 1).trim();
    const port = parseStrictPositiveInteger(portRaw);
    if (!host || port === undefined || port > 65535) {
      return null;
    }
    if (!isSafeSshTargetHost(host)) {
      return null;
    }
    if (userPart !== undefined && !isSafeSshTargetUser(userPart)) {
      return null;
    }
    return { user: userPart, host, port };
  }

  if (!hostPart) {
    return null;
  }
  if (!isSafeSshTargetHost(hostPart)) {
    return null;
  }
  if (userPart !== undefined && !isSafeSshTargetUser(userPart)) {
    return null;
  }
  return { user: userPart, host: hostPart, port: 22 };
}

async function pickEphemeralPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      server.close(() => {
        if (!addr || typeof addr === "string") {
          reject(new Error("failed to allocate a local port"));
          return;
        }
        resolve(addr.port);
      });
    });
  });
}

async function canConnectLocal(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(250, () => done(false));
  });
}

async function waitForLocalListener(port: number, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await canConnectLocal(port)) {
      return;
    }
    await new Promise((r) => {
      setTimeout(r, 50);
    });
  }
  throw new Error(`ssh tunnel did not start listening on localhost:${port}`);
}

export async function startSshPortForward(opts: {
  target: string;
  identity?: string;
  localPortPreferred: number;
  remotePort: number;
  timeoutMs: number;
}): Promise<SshTunnel> {
  const parsed = parseSshTarget(opts.target);
  if (!parsed) {
    throw new Error(`invalid SSH target: ${opts.target}`);
  }

  const sshPath = resolveSshClient();
  if (!sshPath) {
    throw new Error("trusted SSH client not found in system directories");
  }

  let localPort = opts.localPortPreferred;
  try {
    await ensurePortAvailable(localPort, "127.0.0.1");
  } catch (err) {
    if (err instanceof PortInUseError || (isErrno(err) && err.code === "EADDRINUSE")) {
      localPort = await pickEphemeralPort();
    } else {
      throw err;
    }
  }

  const userHost = parsed.user ? `${parsed.user}@${parsed.host}` : parsed.host;
  const args = [
    "-N",
    "-L",
    `127.0.0.1:${localPort}:127.0.0.1:${opts.remotePort}`,
    "-p",
    String(parsed.port),
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "UpdateHostKeys=yes",
    "-o",
    "ConnectTimeout=5",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
  ];
  if (opts.identity?.trim()) {
    args.push("-i", opts.identity.trim());
  }
  // Security: Use '--' to prevent userHost from being interpreted as an option
  args.push("--", userHost);

  const stderr: string[] = [];
  const child = spawn(sshPath, args, {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const stderrStream = child.stderr;
  // Child events own tunnel failure. Keep the diagnostic pipe observed so a
  // stream error cannot become an uncaught exception during active use or teardown.
  stderrStream?.on("error", () => {});
  stderrStream?.setEncoding("utf8");
  stderrStream?.on("data", (chunk) => {
    const lines = normalizeStringEntries(String(chunk).split("\n"));
    stderr.push(...lines);
  });

  // Memoize teardown so concurrent callers join the same process-reaping
  // fence. `child.killed` only means a signal was dispatched, not that the
  // process is reaped — so parked concurrent callers must still await
  // `close`/`exit`, not return early. Track TERM/KILL escalation
  // exactly once and resolve only after the child settles.
  let teardownPromise: Promise<void> | undefined;
  let termSent = false;
  let killSent = false;
  let childExited = false;
  // Mark reaped once so already-exited idempotence is observable without
  // racing the `exit` handler that the teardown installs.
  child.once("exit", () => {
    childExited = true;
  });
  child.once("close", () => {
    childExited = true;
  });
  const stop = async () => {
    if (teardownPromise) {
      return teardownPromise;
    }
    // Already reaped — idempotent fast path without dispatching signals.
    if (childExited || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    teardownPromise = new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(killTimer);
        resolve();
      };
      const onExit = () => {
        finish();
      };
      child.once("exit", onExit);
      child.once("close", onExit);
      child.once("error", onExit);
      const killTimer = setTimeout(() => {
        if (killSent) {
          return;
        }
        killSent = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // Process may have already exited; treat as settled via exit/close.
        }
        // Do not resolve here — await the child's exit/close so delayed
        // post-SIGKILL settlement is still observed before resolving.
      }, 1500);
      // Unref the grace timer so it does not keep the process alive in tests.
      // SAFETY: NodeJS.Timeout unref is optional across platforms; guarded by optional chain
      const maybeTimer = killTimer as unknown as { unref?: () => void };
      maybeTimer.unref?.();

      if (!termSent) {
        termSent = true;
        try {
          const sent = child.kill("SIGTERM");
          if (!sent) {
            // Child already exited synchronously — let the exit/close handler settle.
          }
        } catch {
          // Child already exited — settle via the exit/close handler.
        }
      }
      // If the child was already reaped before we installed handlers, settle
      // immediately so we do not wait for an event that will never fire.
      if (child.exitCode !== null || child.signalCode !== null || childExited) {
        finish();
      }
    });
    return teardownPromise;
  };

  try {
    await Promise.race([
      waitForLocalListener(localPort, Math.max(250, opts.timeoutMs)),
      new Promise<void>((_, reject) => {
        child.once("error", (err) => reject(err));
        child.once("exit", (code, signal) => {
          reject(new Error(`ssh exited (${code ?? "null"}${signal ? `/${signal}` : ""})`));
        });
      }),
    ]);
  } catch (err) {
    await stop();
    const suffix = stderr.length > 0 ? `\n${stderr.join("\n")}` : "";
    throw new Error(`${formatErrorMessage(err)}${suffix}`, { cause: err });
  }

  return {
    parsedTarget: parsed,
    localPort,
    remotePort: opts.remotePort,
    pid: typeof child.pid === "number" ? child.pid : null,
    stderr,
    stop,
  };
}
