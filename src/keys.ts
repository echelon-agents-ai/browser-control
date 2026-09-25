// xdotool-style key names ("Enter", "cmd+a", "ctrl+shift+t") → CDP Input.dispatchKeyEvent params.
import { BueError } from "./protocol";

export interface KeyDef { key: string; code: string; vk: number; text?: string }

const MODS: Record<string, { bit: number; def: KeyDef }> = {
  alt: { bit: 1, def: { key: "Alt", code: "AltLeft", vk: 18 } },
  ctrl: { bit: 2, def: { key: "Control", code: "ControlLeft", vk: 17 } },
  cmd: { bit: 4, def: { key: "Meta", code: "MetaLeft", vk: 91 } },
  shift: { bit: 8, def: { key: "Shift", code: "ShiftLeft", vk: 16 } },
};
const MOD_ALIASES: Record<string, string> = {
  alt: "alt", option: "alt", opt: "alt",
  ctrl: "ctrl", control: "ctrl",
  cmd: "cmd", command: "cmd", meta: "cmd", super: "cmd", win: "cmd",
  shift: "shift",
};
export function modifierName(s: string): string | undefined {
  return MOD_ALIASES[s.toLowerCase()];
}

const NAMED: Record<string, KeyDef> = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  kp_enter: { key: "Enter", code: "NumpadEnter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  esc: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  insert: { key: "Insert", code: "Insert", vk: 45 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
  page_up: { key: "PageUp", code: "PageUp", vk: 33 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  prior: { key: "PageUp", code: "PageUp", vk: 33 },
  page_down: { key: "PageDown", code: "PageDown", vk: 34 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
  next: { key: "PageDown", code: "PageDown", vk: 34 },
  up: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  space: { key: " ", code: "Space", vk: 32, text: " " },
  minus: { key: "-", code: "Minus", vk: 189, text: "-" },
  equal: { key: "=", code: "Equal", vk: 187, text: "=" },
  comma: { key: ",", code: "Comma", vk: 188, text: "," },
  period: { key: ".", code: "Period", vk: 190, text: "." },
  slash: { key: "/", code: "Slash", vk: 191, text: "/" },
  semicolon: { key: ";", code: "Semicolon", vk: 186, text: ";" },
  apostrophe: { key: "'", code: "Quote", vk: 222, text: "'" },
  bracketleft: { key: "[", code: "BracketLeft", vk: 219, text: "[" },
  bracketright: { key: "]", code: "BracketRight", vk: 221, text: "]" },
  backslash: { key: "\\", code: "Backslash", vk: 220, text: "\\" },
  grave: { key: "`", code: "Backquote", vk: 192, text: "`" },
};
for (let i = 1; i <= 12; i++) NAMED[`f${i}`] = { key: `F${i}`, code: `F${i}`, vk: 111 + i };
const PUNCT: Record<string, string> = { "-": "minus", "=": "equal", ",": "comma", ".": "period", "/": "slash", ";": "semicolon", "'": "apostrophe", "[": "bracketleft", "]": "bracketright", "\\": "backslash", "`": "grave" };

/** Editing commands Chrome only runs when asked explicitly (CDP key events do not trigger OS shortcuts). */
const COMMANDS: Record<string, string> = { a: "selectAll", c: "copy", x: "cut", v: "paste", z: "undo" };

export interface Chord {
  mods: string[];
  modifiers: number;
  key: KeyDef;
  commands?: string[];
}

function baseKey(name: string, shift: boolean): KeyDef | undefined {
  if (name.length === 1) {
    const c = name;
    if (/[a-z]/i.test(c)) {
      const k = shift ? c.toUpperCase() : c.toLowerCase();
      return { key: k, code: `Key${c.toUpperCase()}`, vk: c.toUpperCase().charCodeAt(0), text: k };
    }
    if (/[0-9]/.test(c)) return { key: c, code: `Digit${c}`, vk: c.charCodeAt(0), text: c };
    if (PUNCT[c]) return NAMED[PUNCT[c]];
    return undefined;
  }
  return NAMED[name.toLowerCase()];
}

/** Parses one chord like "ctrl+shift+t". `echo=false` keeps the input out of error messages. */
export function parseChord(s: string, echo = true): Chord {
  const parts = s.split("+");
  // "ctrl++" → the key is "+": not supported (xdotool calls it "plus"); keep it simple and loud
  const keyName = parts.pop() ?? "";
  const mods: string[] = [];
  for (const p of parts) {
    const m = modifierName(p);
    if (!m) throw new BueError("BAD_REQUEST", echo ? `unknown modifier '${p}' in '${s}' (use shift, ctrl, alt, cmd)` : "unknown modifier (use shift, ctrl, alt, cmd)");
    if (!mods.includes(m)) mods.push(m);
  }
  // a bare modifier ("shift") is a key press of that modifier
  const bareMod = modifierName(keyName);
  const key = bareMod ? MODS[bareMod].def : baseKey(keyName, mods.includes("shift"));
  if (!key) throw new BueError("BAD_REQUEST", echo ? `unknown key '${keyName}' in '${s}'` : "unknown key name");
  const modifiers = mods.reduce((a, m) => a | MODS[m].bit, 0);
  const letter = key.key.toLowerCase();
  let commands: string[] | undefined;
  if ((mods.includes("cmd") || mods.includes("ctrl")) && !mods.includes("alt") && COMMANDS[letter]) {
    commands = [letter === "z" && mods.includes("shift") ? "redo" : COMMANDS[letter]];
  }
  return { mods, modifiers, key, commands };
}

/** "ctrl+a Delete" → two chords (space-separated sequence, like xdotool). */
export function parseKeys(s: string, echo = true): Chord[] {
  const chords = s.trim().split(/\s+/).filter(Boolean).map((c) => parseChord(c, echo));
  if (!chords.length) throw new BueError("BAD_REQUEST", "key needs at least one key name");
  return chords;
}

export function modDef(m: string): { bit: number; def: KeyDef } {
  return MODS[m];
}
