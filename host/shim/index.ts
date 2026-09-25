// The stdio shim — the tiny executable Chrome's native-messaging manifest points at.
//
// Chrome spawns a FRESH host process over stdio per chrome.runtime.connectNative call, so the single
// long-running launchd daemon cannot itself be Chrome's stdio endpoint (architecture doc §3
// lifecycle). This shim is that per-connection stdio endpoint: it does NOTHING but relay bytes
// between its own stdin/stdout (Chrome's native-messaging pipe) and a Unix-domain socket connection
// to the daemon at ~/Library/Application Support/BrowserControl/host.sock.
//
// It is a PURE byte relay — it holds NO MCP server, no tenant/auth/1P logic, and crucially trusts NO
// tenant/agent field: tenant/agent stamping happens only inside the daemon from the validated bearer.
// Because the 4-byte-LE + JSON framing is a byte stream, piping raw bytes preserves frame boundaries
// exactly; the shim never parses or re-frames.
//
// ONE exception (slice 2 tenant binding, see daemon/tenantSupervisor.ts): before relaying, the shim
// writes a single hello frame { type: "bue_hello", tenant, token } built from BUE_TENANT /
// BUE_LAUNCH_TOKEN in its own env (inherited from the per-tenant CfT process). It is still no
// authority: the daemon validates the token against the launch it made and refuses on mismatch.
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { encodeMessage } from "../shared/framing.js";

export interface ShimHello {
  tenant: string;
  token: string;
}

/** Hello from env, or null if the shim was not launched under a supervised tenant Chrome. */
export function helloFromEnv(env: NodeJS.ProcessEnv = process.env): ShimHello | null {
  return env.BUE_TENANT && env.BUE_LAUNCH_TOKEN ? { tenant: env.BUE_TENANT, token: env.BUE_LAUNCH_TOKEN } : null;
}

export function defaultSocketPath(): string {
  return path.join(os.homedir(), "Library", "Application Support", "BrowserControl", "host.sock");
}

/** Connect attempts before giving up. MEASURED risk this guards against: the daemon's Unix socket
 *  can still be mid-bind (net.Server#listen is async) the instant Chrome spawns this shim right
 *  after a (re)start / cold tenant launch — a single failed connect used to exit non-zero
 *  immediately, and Chrome's MV3 native-messaging port does not retry connectNative for a while, so
 *  that one failed dial stranded the tenant. Cheap: at most (RETRY_ATTEMPTS-1) * RETRY_DELAY_MS =
 *  ~800ms of extra wait in the case that never needs it (daemon already up). */
export const RETRY_ATTEMPTS = 5;
export const RETRY_DELAY_MS = 200;

export function runShim(
  socketPath: string,
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
  onExit: (code: number) => void,
  hello: ShimHello | null = null,
  retryAttempts = RETRY_ATTEMPTS,
  retryDelayMs = RETRY_DELAY_MS,
): net.Socket {
  const die = (code: number) => onExit(code);
  let attempt = 0;
  let socket: net.Socket;

  const wire = (s: net.Socket) => {
    // Hello first — written before stdin is piped, so it is always the socket's first frame.
    if (hello) s.write(encodeMessage({ type: "bue_hello", tenant: hello.tenant, token: hello.token }));
    // daemon -> extension (stdout) and extension (stdin) -> daemon, as raw byte streams.
    s.pipe(stdout as NodeJS.WritableStream);
    (stdin as NodeJS.ReadableStream).pipe(s);
    s.on("close", () => die(0));
    (stdin as any).on?.("end", () => s.end());
    (stdin as any).on?.("close", () => s.end());
  };

  const connectOnce = () => {
    attempt += 1;
    socket = net.createConnection(socketPath);
    socket.once("connect", () => {
      socket.removeAllListeners("error");
      socket.on("error", () => die(1)); // post-connect failure: daemon down mid-session, exit non-zero
      wire(socket);
    });
    socket.once("error", () => {
      socket.destroy();
      if (attempt < retryAttempts) {
        setTimeout(connectOnce, retryDelayMs);
      } else {
        die(1); // daemon down / socket missing after all retries: exit non-zero, Chrome tears down the port
      }
    });
  };

  connectOnce();
  return socket!;
}

// Only run when invoked directly (node dist/shim/index.js), not when imported by tests.
if (process.argv[1] && /shim[\\/]index\.(ts|js)$/.test(process.argv[1])) {
  const socketPath = process.env.BUE_SOCKET_PATH ?? defaultSocketPath();
  runShim(socketPath, process.stdin, process.stdout, (code) => process.exit(code), helloFromEnv());
}
