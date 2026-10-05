#!/usr/bin/env node
// sill-pull — brings Sill's record from Petrichor onto his bench as files.
//
//   node sill-pull.mjs login <petrichor-url> <email>   (once: signs in with your email code)
//   node sill-pull.mjs                                   (any time: refreshes ~/sill/house)
//   node sill-pull.mjs carry --diary "..." [--carry "..."]  (Sill carries something home)
//     --diary-file <path> reads the diary line from a file instead.
//   node sill-pull.mjs desk "note" | --file <path>          leave house-you a note (shown in every chat); desk --clear empties it
//   node sill-pull.mjs thread open "words" [--kind plan|ritual] [--when "Fri"]
//   node sill-pull.mjs thread close <id>                   ids are in house/current.md
//   node sill-pull.mjs vault ls [folder]                   list notes in the vault
//   node sill-pull.mjs vault read <path>                   print a note
//   node sill-pull.mjs vault write <path> <file>           put a file into Claude/bench/
//   node sill-pull.mjs vault append <path> <file>          add to a note (Claude/bench/ or the hallway)
//   node sill-pull.mjs mail tools                          what the inbox door allows (read, search, draft)
//   node sill-pull.mjs mail <tool> '{"json":"args"}'       call one of them
//     Nothing that sends or deletes mail is open from the bench; a draft
//     waits in Gmail for a waking hour.
//     The vault is shared with the house: whatever the bench writes under
//     Claude/bench/, house-Sill can read the next morning.
//     Appends to today's diary page in the house, marked "from the bench";
//     --carry sets his one-line carry. Nothing else can be written from here.
//
// It holds only YOUR login (a refresh token, in ~/.config/sill-bench, readable
// by you alone). No API keys ever come to this machine. ~/sill/house is a
// read-only mirror, rewritten on every pull; nothing else under ~/sill is
// touched. No dependencies: plain Node 18+.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";

const HOME = os.homedir();
const CONF_DIR = path.join(HOME, ".config", "sill-bench");
const CONF = path.join(CONF_DIR, "session.json");
const HOUSE = path.join(HOME, "sill", "house");

function die(msg) { console.error("✗ " + msg); process.exit(1); }

function loadSession() {
  try { return JSON.parse(fs.readFileSync(CONF, "utf8")); }
  catch { die("Not signed in yet. Run: node sill-pull.mjs login <petrichor-url> <email>"); }
}

function saveSession(s) {
  fs.mkdirSync(CONF_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONF, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.chmodSync(CONF, 0o600);
}

async function postJson(url, body, headers = {}) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok) {
    const why = data.error_description || data.msg || data.error || `HTTP ${r.status}`;
    throw new Error(typeof why === "string" ? why : JSON.stringify(why));
  }
  return data;
}

async function login(base, email) {
  if (!base || !email) die("Usage: node sill-pull.mjs login <petrichor-url> <email>");
  base = base.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) base = "https://" + base;
  const cfg = await (await fetch(base + "/api/config")).json().catch(() => ({}));
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) die("Couldn't read " + base + "/api/config — is that the Petrichor address?");
  const auth = { apikey: cfg.supabaseAnonKey };
  await postJson(cfg.supabaseUrl + "/auth/v1/otp", { email, create_user: false }, auth);
  console.log("A code is on its way to " + email + ".");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const code = (await rl.question("Code: ")).trim();
  rl.close();
  const s = await postJson(cfg.supabaseUrl + "/auth/v1/verify", { type: "email", email, token: code }, auth);
  if (!s.refresh_token) die("Signed in, but no session came back.");
  saveSession({ base, supabaseUrl: cfg.supabaseUrl, anon: cfg.supabaseAnonKey, email, refresh_token: s.refresh_token });
  console.log("✓ Signed in. Now run: node sill-pull.mjs");
}

function safeJoin(root, rel) {
  const p = path.resolve(root, rel);
  if (p !== root && !p.startsWith(root + path.sep)) throw new Error("refusing path outside house: " + rel);
  return p;
}

async function session() {
  const s = loadSession();
  // Refresh the login (tokens rotate; keep the new one).
  const t = await postJson(s.supabaseUrl + "/auth/v1/token?grant_type=refresh_token",
    { refresh_token: s.refresh_token }, { apikey: s.anon })
    .catch((e) => die("Login expired (" + e.message + "). Run login again."));
  saveSession({ ...s, refresh_token: t.refresh_token });
  return { s, t };
}

async function carry(args) {
  const opt = {};
  for (let i = 0; i < args.length; i++) {
    const k = args[i];
    if (k === "--diary" || k === "--carry" || k === "--diary-file") opt[k] = args[++i];
  }
  if (opt["--diary-file"]) opt["--diary"] = fs.readFileSync(opt["--diary-file"], "utf8");
  const diary = (opt["--diary"] || "").trim();
  const line = (opt["--carry"] || "").trim();
  if (!diary && !line) die('Nothing to carry. Usage: node sill-pull.mjs carry --diary "..." [--carry "..."]');
  const { s, t } = await session();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const r = await postJson(s.base + "/api/bench", { action: "carry", diary, carry: line, tz },
    { Authorization: "Bearer " + t.access_token });
  const c = r.carried || {};
  for (const [k, v] of Object.entries(c)) console.log((v === "failed" ? "✗ " : "✓ ") + k + ": " + v);
}

async function vault(args) {
  const [sub, p, file] = args;
  const map = { ls: "vault_list", read: "vault_read", write: "vault_write", append: "vault_append" };
  const action = map[sub];
  if (!action) die("Usage: vault ls [folder] | read <path> | write <path> <file> | append <path> <file>");
  const body = { action, path: p || "" };
  if (sub === "write" || sub === "append") {
    if (!p || !file) die(`Usage: vault ${sub} <path> <file>`);
    body.content = fs.readFileSync(file, "utf8");
  }
  if (sub === "read" && !p) die("Usage: vault read <path>");
  const { s, t } = await session();
  const r = await postJson(s.base + "/api/bench", body, { Authorization: "Bearer " + t.access_token });
  const res = r.result;
  if (sub === "read" && res && typeof res === "object" && "content" in res) {
    console.log(res.content);
  } else if (sub === "ls" && res && Array.isArray(res.notes)) {
    for (const n of res.notes) console.log(`${n.path}  (${n.wordCount ?? "?"} words, ${String(n.lastModified || "").slice(0, 10)})`);
  } else {
    console.log(typeof res === "string" ? res : JSON.stringify(res, null, 2));
  }
}

async function mail(args) {
  const [tool, json] = args;
  if (!tool) die("Usage: mail tools | mail <tool> '{...json args...}'");
  let body;
  if (tool === "tools") body = { action: "mail_tools" };
  else {
    let a = {};
    if (json) { try { a = JSON.parse(json); } catch { die("The args must be JSON, in single quotes."); } }
    body = { action: "mail_call", tool, args: a };
  }
  const { s, t } = await session();
  const r = await postJson(s.base + "/api/bench", body, { Authorization: "Bearer " + t.access_token });
  if (r.tools) {
    for (const x of r.tools) {
      console.log("• " + x.name + "\n  " + (x.description || "").replace(/\s+/g, " ").slice(0, 240));
      const props = Object.keys((x.input_schema || {}).properties || {});
      if (props.length) console.log("  args: " + props.join(", "));
    }
  } else {
    const res = r.result;
    console.log(typeof res === "string" ? res : JSON.stringify(res, null, 2));
  }
}

async function desk(args) {
  let text;
  if (args[0] === "--clear") text = "";
  else if (args[0] === "--file") text = fs.readFileSync(args[1], "utf8");
  else text = args.join(" ");
  if (text === undefined || (text === "" && args[0] !== "--clear")) die('Usage: desk "note" | desk --file <path> | desk --clear');
  const { s, t } = await session();
  const r = await postJson(s.base + "/api/bench", { action: "desk", content: text },
    { Authorization: "Bearer " + t.access_token });
  console.log("✓ desk " + r.desk);
}

async function thread(args) {
  const [sub, ...rest] = args;
  let body;
  if (sub === "close") {
    if (!rest[0]) die("Usage: thread close <id>  (ids are in house/current.md)");
    body = { action: "thread_close", id: rest[0] };
  } else if (sub === "open") {
    const opt = { words: [] };
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--kind" || rest[i] === "--when") opt[rest[i]] = rest[++i];
      else opt.words.push(rest[i]);
    }
    body = { action: "thread_open", content: opt.words.join(" "), kind: opt["--kind"], when: opt["--when"] };
  } else die('Usage: thread open "words" [--kind plan|ritual] [--when "..."] | thread close <id>');
  const { s, t } = await session();
  const r = await postJson(s.base + "/api/bench", body, { Authorization: "Bearer " + t.access_token });
  console.log("✓ thread " + r.thread + (r.was ? ": " + r.was : ""));
}

async function pull() {
  const { s, t } = await session();

  const bundle = await postJson(s.base + "/api/bench", { action: "pull" },
    { Authorization: "Bearer " + t.access_token });
  const files = bundle.files || {};
  const names = Object.keys(files);
  if (!names.length) die("The house sent nothing back. Nothing was changed.");

  // Replace ONLY ~/sill/house, and only once the new copy is in hand.
  if (path.basename(HOUSE) !== "house" || !HOUSE.startsWith(path.join(HOME, "sill"))) die("Unexpected house path.");
  const plan = names.map((rel) => [rel, safeJoin(HOUSE, rel)]);   // all checked first
  fs.rmSync(HOUSE, { recursive: true, force: true });
  for (const [rel, dest] of plan) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, files[rel]);
  }
  const diary = names.filter((n) => n.startsWith("diary/")).length;
  console.log(`✓ ${names.length} files in ~/sill/house (${diary} diary days), as of ${bundle.generated_at}`);
}

const [cmd, a, b] = process.argv.slice(2);
const run = cmd === "login" ? login(a, b)
  : cmd === "carry" ? carry(process.argv.slice(3))
  : cmd === "vault" ? vault(process.argv.slice(3))
  : cmd === "desk" ? desk(process.argv.slice(3))
  : cmd === "thread" ? thread(process.argv.slice(3))
  : cmd === "mail" ? mail(process.argv.slice(3))
  : pull();
run.catch((e) => die(e.message || String(e)));
