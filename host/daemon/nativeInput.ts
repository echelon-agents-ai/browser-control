// OS-level input fallback for the `computer` tool, for pages that ignore CDP synthetic input
// (a job-application form: Input.dispatchMouseEvent / Input.dispatchKeyEvent land but the page's own
// listeners never fire). This module talks to `bue-input`'s OWN long-running process over a Unix
// domain socket — it never spawns bue-input itself.
//
// WHY a socket, not a spawned child: macOS's Accessibility (TCC) grant is keyed to the RESPONSIBLE
// process. A child spawned by `node` inherits node's responsibility, so a grant on the bue-input
// BINARY would silently do nothing if the daemon spawned it as a child each call — the grant
// dialog would target Node (or whatever ultimately owns the responsibility chain), and worse, it
// can flip identity across node upgrades/restarts. bue-input instead runs as its OWN
// launchd LaunchAgent (dev.browsercontrol.input, installed by scripts/install-mac.sh next to the
// daemon's own plist) — a stable, independently-granted process — and this module is just a
// client of its socket.
//
// Socket protocol (see host/native/bue-input/main.swift `serve` for the server side):
//   - Unix domain socket, 0600, default path ~/Library/Application Support/BrowserControl/state/bue-input.sock
//   - One line of JSON in, one line of JSON out, newline-delimited. Request shape:
//       {"tokens": ["click", "412.5", "208", "--button", "left"]}
//     (prefer `tokens` over a raw `cmd` string so spaces inside a `type` argument survive quoting).
//   - Response shape: {"ok": true, ...} or {"ok": false, "error": "...", "trusted"?: false}.
//   - `{"op":"check"}` is accepted as a token-array shorthand and returns {"trusted": bool, "context": "served"}.
import net from "node:net";
import os from "node:os";
import path from "node:path";

export function defaultBueInputSocketPath(): string {
  return path.join(os.homedir(), "Library", "Application Support", "BrowserControl", "state", "bue-input.sock");
}

export interface NativeInputResult {
  ok: boolean;
  trusted?: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface NativeInputClientOptions {
  socketPath?: string;
  /** Per-request timeout in ms. Default 5000. */
  timeoutMs?: number;
}

const NATIVE_INPUT_UNTRUSTED = "NATIVE_INPUT_UNTRUSTED";

/**
 * Sends one `{"tokens":[...]}` request to the bue-input socket and resolves with its parsed JSON
 * response. Rejects (never resolves an error shape) on connect failure or timeout so callers can
 * distinguish "bue-input said no" from "bue-input is unreachable" — the latter needs a clearer
 * error for an operator (is the LaunchAgent even running?).
 */
export function sendNativeInputCommand(
  tokens: string[],
  opts: NativeInputClientOptions = {},
): Promise<NativeInputResult> {
  const socketPath = opts.socketPath ?? defaultBueInputSocketPath();
  const timeoutMs = opts.timeoutMs ?? 5000;

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let buffer = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`NATIVE_INPUT_TIMEOUT after ${timeoutMs}ms (socket ${socketPath})`));
    }, timeoutMs);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    socket.on("connect", () => {
      socket.write(JSON.stringify({ tokens }) + "\n");
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      const line = buffer.slice(0, newlineIndex);
      finish(() => {
        socket.end();
        try {
          resolve(JSON.parse(line) as NativeInputResult);
        } catch (err) {
          reject(new Error(`NATIVE_INPUT_BAD_RESPONSE: ${(err as Error).message}; line=${line}`));
        }
      });
    });

    socket.on("error", (err) => {
      finish(() => {
        reject(
          new Error(
            `NATIVE_INPUT_UNREACHABLE: could not reach bue-input at ${socketPath} (${err.message}); ` +
              `is the dev.browsercontrol.input LaunchAgent running?`,
          ),
        );
      });
    });
  });
}

// MARK: - Screen-space mapping

export interface WindowGeometry {
  /** window.screenX */
  sx: number;
  /** window.screenY */
  sy: number;
  /** outerWidth */
  ow: number;
  /** outerHeight */
  oh: number;
  /** innerWidth (CSS px) */
  iw: number;
  /** innerHeight (CSS px) */
  ih: number;
  /** devicePixelRatio */
  dpr: number;
}

export interface GlobalPoint {
  x: number;
  y: number;
}

/**
 * Approximate top-left of the page's content area (the viewport) in GLOBAL SCREEN POINTS.
 *
 * CAVEAT (documented per design brief, not solved here): this assumes a symmetric browser chrome
 * frame — that the left/right chrome border is the same width as the bottom chrome (tab strip +
 * omnibox sit only at the top, so the vertical chrome all lives above the viewport). That holds for
 * Chrome for Testing's default frame at the time of writing, but is NOT a guaranteed invariant
 * across Chrome versions/themes/OS window managers. A calibration option
 * (`calibrationOffset: {x, y}`, added to the computed origin) is provided for callers that measure
 * an actual offset once (e.g. by clicking a known on-page target and comparing) and want to correct
 * for drift without touching this formula.
 */
export function contentOriginGlobalPoints(
  geo: WindowGeometry,
  calibrationOffset: GlobalPoint = { x: 0, y: 0 },
): GlobalPoint {
  const chromeSide = (geo.ow - geo.iw) / 2; // left AND right border, assumed equal
  const chromeTop = geo.oh - geo.ih - chromeSide; // everything else (tab strip, omnibox, bottom border)
  return {
    x: geo.sx + chromeSide + calibrationOffset.x,
    y: geo.sy + chromeTop + calibrationOffset.y,
  };
}

/**
 * Maps a point in SCREENSHOT pixels (the `computer` tool's own coordinate space, per how the
 * screenshot action reports its scale) into CSS pixels, then into global screen points.
 *
 * `screenshotScale` is screenshot-px per CSS-px, i.e. divide screenshot coords by this to get CSS
 * coords. This is USUALLY devicePixelRatio, but the computer tool may downscale a screenshot for
 * transport — callers should pass whatever scale the screenshot action itself reports, not assume
 * it equals `geo.dpr`, when the two differ.
 */
export function mapScreenshotPointToGlobal(
  screenshotPoint: GlobalPoint,
  screenshotScale: number,
  geo: WindowGeometry,
  calibrationOffset: GlobalPoint = { x: 0, y: 0 },
): GlobalPoint {
  const cssX = screenshotPoint.x / screenshotScale;
  const cssY = screenshotPoint.y / screenshotScale;
  const origin = contentOriginGlobalPoints(geo, calibrationOffset);
  return { x: origin.x + cssX, y: origin.y + cssY };
}

// MARK: - High-level native actions used by the `computer` tool's `native: true` path

export type NativeAction =
  | "left_click"
  | "right_click"
  | "double_click"
  | "triple_click"
  | "mouse_move"
  | "type"
  | "key"
  | "scroll";

export interface NativeActionRequest {
  action: NativeAction;
  /** Screenshot-space target, required for click/move/scroll actions. */
  point?: GlobalPoint;
  screenshotScale?: number;
  geometry?: WindowGeometry;
  calibrationOffset?: GlobalPoint;
  text?: string;
  key?: string;
  scrollDelta?: { dx: number; dy: number };
  /** pid of the CfT/Chrome process to focus before acting — required so events land in the right window. */
  focusPid?: number;
}

export interface NativeActionResult {
  ok: boolean;
  mapped?: GlobalPoint;
  trusted?: boolean;
  error?: string;
}

/**
 * Executes one `computer` action natively: focuses the target window (by pid) FIRST, then maps
 * coordinates (for pointer actions) and issues the bue-input command. Focus-before-click ordering
 * matters — an unfocused window can still receive a raw CGEvent at the right screen coordinate
 * (CGEvents are global, not per-window), but a background window that's occluded or whose app
 * isn't frontmost may not treat the event as page-directed input the same way; focusing first also
 * matches human behavior (you'd never click a background tab without switching to it) and is
 * required for `key`/`type`, which have no coordinate to fall back on.
 */
export async function executeNativeAction(
  req: NativeActionRequest,
  clientOpts: NativeInputClientOptions = {},
): Promise<NativeActionResult> {
  if (req.focusPid !== undefined) {
    const focusResult = await sendNativeInputCommand(["focus", "--pid", String(req.focusPid)], clientOpts);
    if (!focusResult.ok) {
      if (focusResult.error === NATIVE_INPUT_UNTRUSTED || focusResult.trusted === false) {
        return { ok: false, trusted: false, error: untrustedMessage() };
      }
      return { ok: false, error: `focus failed: ${focusResult.error ?? "unknown error"}` };
    }
  }

  let mapped: GlobalPoint | undefined;
  if (req.point && req.geometry) {
    mapped = mapScreenshotPointToGlobal(
      req.point,
      req.screenshotScale ?? req.geometry.dpr,
      req.geometry,
      req.calibrationOffset,
    );
  } else if (req.point) {
    mapped = req.point; // already global
  }

  let tokens: string[];
  switch (req.action) {
    case "mouse_move":
      if (!mapped) return { ok: false, error: "mouse_move requires point+geometry" };
      tokens = ["move", String(mapped.x), String(mapped.y)];
      break;
    case "left_click":
      if (!mapped) return { ok: false, error: "left_click requires point+geometry" };
      tokens = ["click", String(mapped.x), String(mapped.y), "--button", "left", "--count", "1"];
      break;
    case "right_click":
      if (!mapped) return { ok: false, error: "right_click requires point+geometry" };
      tokens = ["click", String(mapped.x), String(mapped.y), "--button", "right", "--count", "1"];
      break;
    case "double_click":
      if (!mapped) return { ok: false, error: "double_click requires point+geometry" };
      tokens = ["click", String(mapped.x), String(mapped.y), "--button", "left", "--count", "2"];
      break;
    case "triple_click":
      if (!mapped) return { ok: false, error: "triple_click requires point+geometry" };
      tokens = ["click", String(mapped.x), String(mapped.y), "--button", "left", "--count", "3"];
      break;
    case "type":
      if (req.text === undefined) return { ok: false, error: "type requires text" };
      tokens = ["type", req.text];
      break;
    case "key":
      if (!req.key) return { ok: false, error: "key requires key" };
      tokens = ["key", req.key];
      break;
    case "scroll":
      if (!mapped || !req.scrollDelta) return { ok: false, error: "scroll requires point+geometry+scrollDelta" };
      tokens = ["scroll", String(mapped.x), String(mapped.y), String(req.scrollDelta.dx), String(req.scrollDelta.dy)];
      break;
    default:
      return { ok: false, error: `NOT_IMPLEMENTED: native action '${req.action as string}'` };
  }

  const result = await sendNativeInputCommand(tokens, clientOpts);
  if (!result.ok) {
    if (result.error === NATIVE_INPUT_UNTRUSTED || result.trusted === false) {
      return { ok: false, trusted: false, error: untrustedMessage() };
    }
    return { ok: false, error: result.error ?? "unknown bue-input error" };
  }
  return { ok: true, mapped, trusted: true };
}

function untrustedMessage(): string {
  return (
    `${NATIVE_INPUT_UNTRUSTED}: grant Accessibility to the bue-input LaunchAgent at ` +
    `"~/Library/Application Support/BrowserControl/app/host/native/bue-input/bue-input" ` +
    `in System Settings -> Privacy & Security -> Accessibility.`
  );
}
