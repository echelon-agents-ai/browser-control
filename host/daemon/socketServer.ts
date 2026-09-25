// The daemon's Unix-domain-socket SERVER. Each `shim` process (spawned by Chrome per
// connectNative) connects here as a client and relays its stdio frames both ways. The daemon wraps
// each accepted socket as an ExtensionClient (extensionClient.ts) — the socket carries the same
// 4-byte-LE + JSON framing the extension puts on its native-messaging port.
//
// The socket lives at ~/Library/Application Support/BrowserControl/host.sock, mode 0600.
//
// TENANT ROUTING (slice 2): the first frame on every accepted socket must be a hello
// { type: "bue_hello", tenant, token } written by the shim (see tenantSupervisor.ts header for the
// env-var binding design). validateHello decides; only then is the socket wrapped as THAT tenant's
// ExtensionClient in a Map<tenant, ExtensionClient>. No hello / bad token → socket destroyed, never
// registered. getExtensionClient(tenant) returns only that tenant's client or throws
// NATIVE_HOST_DISCONNECTED. There is no "most recent connection" fallback any more.
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { BueError } from "../shared/protocolTypes.js";
import { PassThrough } from "node:stream";
import { createExtensionClient, type ExtensionClient } from "./extensionClient.js";
import type { HelloFrame } from "./tenantSupervisor.js";

export function defaultSocketPath(): string {
  return path.join(os.homedir(), "Library", "Application Support", "BrowserControl", "host.sock");
}

export interface SocketServer {
  address: string;
  /** Resolves once the Unix-domain socket is actually bound and accepting connections (net.Server's
   *  "listening" event fired) — never on a rejection; a listen error is logged and the promise stays
   *  pending. Callers that must not let a shim/CfT dial before the socket exists await this before
   *  doing anything that could trigger a tenant launch (see daemon/index.ts main()). */
  ready: Promise<void>;
  getExtensionClient(tenant: string): ExtensionClient;
  connectionCount(): number;
  tenants(): string[];
  close(): void;
}

export interface SocketServerOptions {
  socketPath?: string;
  log?: (line: string) => void;
  /** Decides whether a hello binds the socket to its tenant (supervisor.validateHello). */
  validateHello: (hello: HelloFrame) => boolean;
  /** Registered tenant connection dropped. */
  onTenantDisconnected?: (tenant: string) => void;
  /** Max ms to wait for the hello before dropping the socket. */
  helloTimeoutMs?: number;
}

const MAX_HELLO_BYTES = 4096;

export function startSocketServer(opts: SocketServerOptions): SocketServer {
  const socketPath = opts.socketPath ?? defaultSocketPath();
  const log = opts.log ?? ((line: string) => console.error(line));
  const helloTimeoutMs = opts.helloTimeoutMs ?? 5000;

  mkdirSync(path.dirname(socketPath), { recursive: true });
  if (existsSync(socketPath)) rmSync(socketPath); // clear a stale socket from a prior run

  const byTenant = new Map<string, ExtensionClient>();
  const all = new Set<ExtensionClient>();

  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      log("shim sent no hello in time; dropping");
      socket.destroy();
    }, helloTimeoutMs);

    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 4) return;
      const len = buf.readUInt32LE(0);
      if (len > MAX_HELLO_BYTES) return reject("oversized hello");
      if (buf.length < 4 + len) return;
      socket.off("data", onData);
      clearTimeout(timer);
      let hello: HelloFrame;
      try {
        hello = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
      } catch {
        return reject("malformed hello");
      }
      let ok = false;
      try {
        ok = opts.validateHello(hello);
      } catch {
        ok = false;
      }
      if (!ok) return reject(`hello rejected for tenant '${typeof hello?.tenant === "string" ? hello.tenant : "?"}'`);
      register(hello.tenant, buf.subarray(4 + len));
    };

    const reject = (why: string) => {
      clearTimeout(timer);
      socket.off("data", onData);
      log(`shim refused: ${why}`);
      socket.destroy();
    };

    const register = (tenant: string, rest: Buffer) => {
      // Re-feed any bytes that arrived behind the hello, then pipe the live socket into the client.
      const input = new PassThrough();
      if (rest.length) input.write(rest);
      socket.pipe(input);
      const client = createExtensionClient(input, socket);
      const prev = byTenant.get(tenant);
      if (prev && prev !== client) prev.close();
      byTenant.set(tenant, client);
      all.add(client);
      log(`shim connected for tenant ${tenant}`);
      const drop = () => {
        all.delete(client);
        client.close();
        if (byTenant.get(tenant) === client) {
          byTenant.delete(tenant);
          opts.onTenantDisconnected?.(tenant);
        }
        log(`shim disconnected for tenant ${tenant}`);
      };
      socket.on("close", drop);
      socket.on("error", drop);
    };

    socket.on("data", onData);
    socket.on("error", () => clearTimeout(timer));
  });

  let resolveReady: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  server.listen(socketPath, () => {
    try {
      chmodSync(socketPath, 0o600);
    } catch (e) {
      log(`warning: could not chmod socket to 0600: ${e instanceof Error ? e.message : String(e)}`);
    }
    resolveReady();
  });

  return {
    address: socketPath,
    ready,
    getExtensionClient(tenant) {
      const c = byTenant.get(tenant);
      if (c && c.isConnected()) return c;
      throw new BueError("NATIVE_HOST_DISCONNECTED", `no extension is connected for tenant '${tenant}'`);
    },
    connectionCount() {
      return [...all].filter((c) => c.isConnected()).length;
    },
    tenants() {
      return [...byTenant.keys()];
    },
    close() {
      for (const c of all) c.close();
      server.close();
      if (existsSync(socketPath)) {
        try {
          rmSync(socketPath);
        } catch {
          /* best-effort cleanup */
        }
      }
    },
  };
}
