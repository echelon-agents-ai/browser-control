// bue-input — OS-level input fallback for Browser Control.
//
// Some pages (a job-application form was the trigger case) ignore CDP synthetic input events (Input.dispatchMouseEvent /
// Input.dispatchKeyEvent), because those events don't carry a real HID origin. This CLI/daemon
// generates GENUINE CGEvents (CoreGraphics HID event taps) that are indistinguishable from a human
// using the mouse/keyboard, so they land on any page — including ones that specifically check for
// synthetic input.
//
// Two personalities, same command grammar:
//   1. CLI, one-shot: `bue-input <command> [args...]` — runs one command and exits.
//   2. Server, long-running: `bue-input serve --socket <path>` — listens on a 0600 Unix domain
//      socket, one JSON command per line in, one JSON result per line out. This is the personality
//      the daemon (nativeInput.ts) actually talks to, launched by its own launchd LaunchAgent
//      (dev.browsercontrol.input) so the macOS Accessibility (TCC) grant attaches to THIS binary's
//      own process, not to whatever spawned it (a grant on a binary spawned as a child of `node`
//      is a grant on node's responsible process, which is useless once the daemon restarts under
//      a different parent — Delta's finding, 2026-09-23).
//
// Coordinates: all x/y arguments are GLOBAL SCREEN POINTS, top-left origin (CoreGraphics' native
// coordinate space on macOS — NOT AppKit's bottom-left origin). Callers (nativeInput.ts) are
// responsible for mapping browser/CSS pixels into this space.
//
// Build: see build.sh (swiftc -O, then ad-hoc codesign with a STABLE identifier so the binary's
// on-disk identity — and therefore its TCC grant — survives rebuilds whose content didn't change).

import ApplicationServices
import AppKit
import CoreGraphics
import Foundation

// MARK: - JSON helpers

func jsonString(_ obj: Any) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) else {
        return "{\"error\":\"JSON_ENCODE_FAILED\"}"
    }
    return String(data: data, encoding: .utf8) ?? "{\"error\":\"JSON_ENCODE_FAILED\"}"
}

func printResultAndExit(_ obj: [String: Any], exitCode: Int32 = 0) -> Never {
    print(jsonString(obj))
    exit(exitCode)
}

func printErrorAndExit(_ message: String, exitCode: Int32 = 1) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    print(jsonString(["ok": false, "error": message]))
    exit(exitCode)
}

// MARK: - Trust check

func isTrusted(prompt: Bool = false) -> Bool {
    if prompt {
        let opts: NSDictionary = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true]
        return AXIsProcessTrustedWithOptions(opts)
    }
    return AXIsProcessTrusted()
}

// MARK: - Key name -> CGKeyCode

// Minimal US-layout keycode table for the named keys/modifiers we support. `type` (arbitrary text)
// does NOT go through this table — it uses CGEventKeyboardSetUnicodeString instead, so it's
// layout- and language-independent.
let namedKeyCodes: [String: CGKeyCode] = [
    "return": 0x24, "enter": 0x24,
    "tab": 0x30,
    "escape": 0x35, "esc": 0x35,
    "space": 0x31,
    "backspace": 0x33, "delete": 0x33,
    "forwarddelete": 0x75,
    "left": 0x7B, "right": 0x7C, "down": 0x7D, "up": 0x7E,
    "home": 0x73, "end": 0x77, "pageup": 0x74, "pagedown": 0x79,
    "cmd": 0x37, "command": 0x37,
    "shift": 0x38,
    "capslock": 0x39,
    "option": 0x3A, "alt": 0x3A,
    "control": 0x3B, "ctrl": 0x3B,
    "rightshift": 0x3C,
    "rightoption": 0x3D, "rightalt": 0x3D,
    "rightcontrol": 0x3E, "rightctrl": 0x3E,
    "function": 0x3F, "fn": 0x3F,
]

let modifierFlagForName: [String: CGEventFlags] = [
    "cmd": .maskCommand, "command": .maskCommand,
    "shift": .maskShift,
    "option": .maskAlternate, "alt": .maskAlternate,
    "control": .maskControl, "ctrl": .maskControl,
]

// MARK: - Core input primitives

func postMouseMove(x: Double, y: Double) {
    let point = CGPoint(x: x, y: y)
    let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)
    event?.post(tap: .cghidEventTap)
}

func postMouseClick(x: Double, y: Double, button: String, count: Int) {
    let point = CGPoint(x: x, y: y)
    let (downType, upType, cgButton): (CGEventType, CGEventType, CGMouseButton) = {
        switch button {
        case "right": return (.rightMouseDown, .rightMouseUp, .right)
        default: return (.leftMouseDown, .leftMouseUp, .left)
        }
    }()
    for i in 1...max(1, count) {
        let down = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: point, mouseButton: cgButton)
        down?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
        down?.post(tap: .cghidEventTap)
        usleep(20_000)
        let up = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: point, mouseButton: cgButton)
        up?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
        up?.post(tap: .cghidEventTap)
        if i < count { usleep(60_000) }
    }
}

func postMouseDown(x: Double, y: Double, button: String) {
    let point = CGPoint(x: x, y: y)
    let (downType, cgButton): (CGEventType, CGMouseButton) = button == "right" ? (.rightMouseDown, .right) : (.leftMouseDown, .left)
    CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: point, mouseButton: cgButton)?.post(tap: .cghidEventTap)
}

func postMouseUp(x: Double, y: Double, button: String) {
    let point = CGPoint(x: x, y: y)
    let (upType, cgButton): (CGEventType, CGMouseButton) = button == "right" ? (.rightMouseUp, .right) : (.leftMouseUp, .left)
    CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: point, mouseButton: cgButton)?.post(tap: .cghidEventTap)
}

func postScroll(x: Double, y: Double, dx: Int32, dy: Int32) {
    postMouseMove(x: x, y: y)
    // wheel1 = vertical, wheel2 = horizontal; CGEvent scroll deltas are in "lines".
    let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(dy), wheel2: Int32(dx), wheel3: 0)
    event?.post(tap: .cghidEventTap)
}

/// Eased (ease-in-out), human-like path from (x0,y0) to (x1,y1) over `ms` milliseconds in `steps`
/// increments, with small jitter, ending with the cursor left at the destination.
func postPath(x0: Double, y0: Double, x1: Double, y1: Double, ms: Int, steps: Int) {
    let n = max(2, steps)
    let stepDelayUs = UInt32(max(1, ms) * 1000 / n)
    for i in 0...n {
        let t = Double(i) / Double(n)
        // Ease-in-out cubic.
        let eased = t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2
        var x = x0 + (x1 - x0) * eased
        var y = y0 + (y1 - y0) * eased
        if i > 0 && i < n {
            x += Double.random(in: -1.2...1.2)
            y += Double.random(in: -1.2...1.2)
        }
        postMouseMove(x: x, y: y)
        usleep(stepDelayUs)
    }
    // Land exactly on the destination.
    postMouseMove(x: x1, y: y1)
}

func parseKeyChord(_ chord: String) -> (code: CGKeyCode, flags: CGEventFlags)? {
    let parts = chord.lowercased().split(separator: "+").map(String.init)
    guard let last = parts.last, let code = namedKeyCodes[last] else { return nil }
    var flags: CGEventFlags = []
    for mod in parts.dropLast() {
        if let f = modifierFlagForName[mod] { flags.insert(f) }
    }
    return (code, flags)
}

func postKey(_ chord: String) -> Bool {
    guard let (code, flags) = parseKeyChord(chord) else { return false }
    let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)
    down?.flags = flags
    down?.post(tap: .cghidEventTap)
    usleep(15_000)
    let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
    up?.flags = flags
    up?.post(tap: .cghidEventTap)
    return true
}

func postType(_ text: String) {
    for scalar in text.unicodeScalars {
        var chars: [UniChar] = []
        let utf16 = String(scalar).utf16
        for u in utf16 { chars.append(u) }
        let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
        down?.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: chars)
        down?.post(tap: .cghidEventTap)
        usleep(6_000)
        let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
        up?.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: chars)
        up?.post(tap: .cghidEventTap)
        usleep(UInt32(Double.random(in: 8_000...22_000)))
    }
}

func focusPid(_ pid: Int32) -> Bool {
    guard let app = NSRunningApplication_(pid: pid) else { return false }
    return app.activate()
}

// AppKit's NSRunningApplication(processIdentifier:) wrapper, isolated so it's easy to unit-reason
// about (and so a future test target can stub it).
struct NSRunningApplication_ {
    let app: NSRunningApplication
    init?(pid: Int32) {
        guard let a = NSRunningApplication(processIdentifier: pid) else { return nil }
        self.app = a
    }
    func activate() -> Bool {
        return app.activate(options: [])
    }
}

// MARK: - Command dispatch (shared between CLI one-shot and `serve` socket)

enum CommandError: Error, CustomStringConvertible {
    case badArgs(String)
    case untrusted
    var description: String {
        switch self {
        case .badArgs(let m): return m
        case .untrusted: return "ACCESSIBILITY_UNTRUSTED"
        }
    }
}

func requireDouble(_ args: [String], _ index: Int, _ name: String) throws -> Double {
    guard index < args.count, let v = Double(args[index]) else {
        throw CommandError.badArgs("missing/invalid \(name) at position \(index)")
    }
    return v
}

func flagValue(_ args: [String], _ flag: String) -> String? {
    guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
    return args[i + 1]
}

/// Runs one command (already split into whitespace-safe tokens: `cmd arg1 arg2 --flag value ...`)
/// and returns a JSON-serializable result dict. Throws CommandError on bad input; the caller
/// decides how to report that (stderr+exit for CLI, an error field for `serve`).
func runCommand(_ tokens: [String]) throws -> [String: Any] {
    guard let cmd = tokens.first else { throw CommandError.badArgs("empty command") }
    let rest = Array(tokens.dropFirst())

    // Every actuating command (not `check`) requires Accessibility trust.
    if cmd != "check" && !isTrusted() {
        throw CommandError.untrusted
    }

    switch cmd {
    case "check":
        return ["trusted": isTrusted(), "context": "served"]

    case "prompt":
        return ["trusted": isTrusted(prompt: true)]

    case "move":
        let x = try requireDouble(rest, 0, "x")
        let y = try requireDouble(rest, 1, "y")
        postMouseMove(x: x, y: y)
        return ["ok": true, "trusted": true]

    case "click":
        let x = try requireDouble(rest, 0, "x")
        let y = try requireDouble(rest, 1, "y")
        let button = flagValue(rest, "--button") ?? "left"
        let count = Int(flagValue(rest, "--count") ?? "1") ?? 1
        postMouseClick(x: x, y: y, button: button, count: count)
        return ["ok": true, "trusted": true]

    case "down":
        let x = try requireDouble(rest, 0, "x")
        let y = try requireDouble(rest, 1, "y")
        let button = flagValue(rest, "--button") ?? "left"
        postMouseDown(x: x, y: y, button: button)
        return ["ok": true, "trusted": true]

    case "up":
        let x = try requireDouble(rest, 0, "x")
        let y = try requireDouble(rest, 1, "y")
        let button = flagValue(rest, "--button") ?? "left"
        postMouseUp(x: x, y: y, button: button)
        return ["ok": true, "trusted": true]

    case "path":
        let x0 = try requireDouble(rest, 0, "x0")
        let y0 = try requireDouble(rest, 1, "y0")
        let x1 = try requireDouble(rest, 2, "x1")
        let y1 = try requireDouble(rest, 3, "y1")
        let ms = Int(flagValue(rest, "--ms") ?? "400") ?? 400
        let steps = Int(flagValue(rest, "--steps") ?? "30") ?? 30
        postPath(x0: x0, y0: y0, x1: x1, y1: y1, ms: ms, steps: steps)
        return ["ok": true, "trusted": true]

    case "scroll":
        let x = try requireDouble(rest, 0, "x")
        let y = try requireDouble(rest, 1, "y")
        let dx = Int32(try requireDouble(rest, 2, "dx"))
        let dy = Int32(try requireDouble(rest, 3, "dy"))
        postScroll(x: x, y: y, dx: dx, dy: dy)
        return ["ok": true, "trusted": true]

    case "key":
        guard let chord = rest.first else { throw CommandError.badArgs("missing key name") }
        guard postKey(chord) else { throw CommandError.badArgs("unknown key '\(chord)'") }
        return ["ok": true, "trusted": true]

    case "type":
        guard let text = rest.first else { throw CommandError.badArgs("missing text") }
        postType(text)
        return ["ok": true, "trusted": true]

    case "focus":
        guard let pidStr = flagValue(rest, "--pid"), let pid = Int32(pidStr) else {
            throw CommandError.badArgs("missing --pid")
        }
        let ok = focusPid(pid)
        return ["ok": ok, "trusted": true]

    default:
        throw CommandError.badArgs("unknown command '\(cmd)'")
    }
}

// MARK: - `serve` — long-running Unix domain socket server

// Line-oriented JSON protocol: each line in is `{"tokens":["click","100","200"]}` (preferred) or
// `{"cmd":"click 100 200 --button left"}` (a raw command string, split on whitespace — text/type
// args should prefer `tokens` so spaces in the string survive). Each line out is one JSON object:
// `{"ok":true,...}` or `{"ok":false,"error":"..."}`. Connections may send many lines; the server
// never closes on its own.
func serve(socketPath: String) -> Never {
    unlink(socketPath) // stale socket from a previous run
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { printErrorAndExit("SOCKET_CREATE_FAILED") }

    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let pathBytes = Array(socketPath.utf8)
    guard pathBytes.count < MemoryLayout.size(ofValue: addr.sun_path) else {
        printErrorAndExit("SOCKET_PATH_TOO_LONG")
    }
    withUnsafeMutableBytes(of: &addr.sun_path) { buf in
        pathBytes.withUnsafeBytes { src in
            buf.copyBytes(from: src)
        }
    }
    let addrLen = socklen_t(MemoryLayout<sockaddr_un>.size)
    let bindResult = withUnsafePointer(to: &addr) { ptr -> Int32 in
        ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
            bind(fd, sa, addrLen)
        }
    }
    guard bindResult == 0 else { printErrorAndExit("SOCKET_BIND_FAILED errno=\(errno)") }
    chmod(socketPath, 0o600) // 0600: local-user-only, per the design brief
    guard listen(fd, 16) == 0 else { printErrorAndExit("SOCKET_LISTEN_FAILED errno=\(errno)") }

    FileHandle.standardError.write("bue-input serve: listening on \(socketPath)\n".data(using: .utf8)!)

    while true {
        let clientFd = accept(fd, nil, nil)
        if clientFd < 0 { continue }
        handleClient(clientFd)
    }
}

func handleClient(_ clientFd: Int32) {
    defer { close(clientFd) }
    let handle = FileHandle(fileDescriptor: clientFd, closeOnDealloc: false)
    var buffer = Data()
    while true {
        let chunk = handle.availableData
        if chunk.isEmpty { break } // client closed
        buffer.append(chunk)
        while let newlineRange = buffer.range(of: Data([0x0A])) {
            let lineData = buffer.subdata(in: buffer.startIndex..<newlineRange.lowerBound)
            buffer.removeSubrange(buffer.startIndex..<newlineRange.upperBound)
            guard !lineData.isEmpty else { continue }
            let response = handleLine(lineData)
            var out = response
            out += "\n"
            handle.write(out.data(using: .utf8)!)
        }
    }
}

func handleLine(_ lineData: Data) -> String {
    guard let obj = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any] else {
        return jsonString(["ok": false, "error": "BAD_JSON"])
    }
    var tokens: [String] = []
    if let t = obj["tokens"] as? [String] {
        tokens = t
    } else if let cmdStr = obj["cmd"] as? String {
        tokens = cmdStr.split(separator: " ").map(String.init)
    } else if let op = obj["op"] as? String {
        // Explicit {"op":"check"} form called out in the design brief for the installer's
        // post-bootstrap trust probe.
        tokens = [op]
    } else {
        return jsonString(["ok": false, "error": "BAD_REQUEST: expected tokens[] or cmd or op"])
    }

    do {
        var result = try runCommand(tokens)
        result["ok"] = result["ok"] ?? true
        return jsonString(result)
    } catch let err as CommandError {
        switch err {
        case .untrusted:
            return jsonString(["ok": false, "trusted": false, "error": "NATIVE_INPUT_UNTRUSTED"])
        case .badArgs(let m):
            return jsonString(["ok": false, "error": m])
        }
    } catch {
        return jsonString(["ok": false, "error": "\(error)"])
    }
}

// MARK: - Entry point

let argv = Array(CommandLine.arguments.dropFirst())

if argv.isEmpty {
    printErrorAndExit("usage: bue-input <check|prompt|move|click|down|up|path|scroll|key|type|focus|serve> [...]")
}

switch argv[0] {
case "--check", "check":
    // CLI-context trust check. Labeled explicitly: Accessibility trust is per-PROCESS, and a CLI
    // invocation runs as a throwaway child of whatever shell/daemon launched it — this result does
    // NOT reflect the trust of the long-running `serve` process (see design note at file top).
    print(jsonString(["trusted": isTrusted(), "context": "cli-only (not the served process)"]))
    exit(0)

case "--prompt":
    print(jsonString(["trusted": isTrusted(prompt: true), "context": "cli-only (not the served process)"]))
    exit(0)

case "serve":
    guard let socketPath = flagValue(Array(argv.dropFirst()), "--socket") else {
        printErrorAndExit("usage: bue-input serve --socket <path>")
    }
    serve(socketPath: socketPath)

default:
    do {
        let result = try runCommand(argv)
        printResultAndExit(result)
    } catch let err as CommandError {
        switch err {
        case .untrusted:
            printErrorAndExit("NATIVE_INPUT_UNTRUSTED: Accessibility permission not granted to this process", exitCode: 3)
        case .badArgs(let m):
            printErrorAndExit(m, exitCode: 1)
        }
    } catch {
        printErrorAndExit("\(error)", exitCode: 1)
    }
}
