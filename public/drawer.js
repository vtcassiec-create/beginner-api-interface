/*
 * Cassie's Drawer — client logic.
 *
 * Her own room in the shared vault. Reuses Petrichor's login (same Supabase
 * project, same browser session — so if she's signed in to the chat app, she's
 * already signed in here), then talks to /api/drawer to list, read, and save
 * notes under Cassie/. No model, no tokens — just her drawer opening.
 */

const $ = (id) => document.getElementById(id);

let db = null;
let session = null;
let notes = [];
let current = null;        // { path, title } of the open note
let dirty = false;

const ROOT = "Cassie/";

// ---------- boot ----------

async function boot() {
  let cfg;
  try {
    cfg = await (await fetch("/api/config")).json();
  } catch (e) {
    return showSetupError("Couldn't reach /api/config. Make sure the app is deployed.");
  }
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    return showSetupError("Supabase isn't configured (SUPABASE_URL / SUPABASE_ANON_KEY).");
  }
  if (!window.supabase || typeof window.supabase.createClient !== "function") {
    return showSetupError("Supabase SDK didn't load. Check your connection and refresh.");
  }
  db = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

  const { data: { session: s } } = await db.auth.getSession();
  session = s;
  if (session) enterDrawer();
  else showSignIn();

  db.auth.onAuthStateChange((event, s2) => {
    if (event === "SIGNED_IN" && s2) { session = s2; enterDrawer(); }
    else if (event === "SIGNED_OUT") { session = null; showSignIn(); }
  });

  wireSignIn();
  wireDrawer();
}

function showSetupError(msg) {
  $("signin-screen").hidden = true;
  $("drawer-shell").hidden = true;
  $("setup-error").hidden = false;
  $("setup-error-msg").textContent = msg;
}

function showSignIn() {
  $("setup-error").hidden = true;
  $("drawer-shell").hidden = true;
  $("signin-screen").hidden = false;
}

async function enterDrawer() {
  $("signin-screen").hidden = true;
  $("setup-error").hidden = true;
  $("drawer-shell").hidden = false;
  await loadList();
  loadGatherable();          // non-blocking — her room shows right away
}

// ---------- sign-in (mirrors the main app's email-OTP flow) ----------

let signinEmail = "";

function wireSignIn() {
  $("signin-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("signin-email").value.trim();
    if (!$("signin-code").hidden) {
      return verifyCode(signinEmail || email, $("signin-code").value.trim());
    }
    if (!email) return;
    await sendCode(email);
  });
  $("signin-have-code").addEventListener("click", useExistingCode);
  $("signin-restart").addEventListener("click", resetSignIn);
}

function showCodeStep(email, message) {
  signinEmail = email;
  $("signin-email").hidden = true;
  $("signin-code").hidden = false;
  $("signin-code").value = "";
  $("signin-code").focus();
  $("signin-submit").textContent = "Verify & sign in";
  $("signin-restart").hidden = false;
  $("signin-have-code").hidden = true;
  const msg = $("signin-msg");
  msg.textContent = message;
  msg.className = "signin-msg success";
}

async function sendCode(email) {
  const { error } = await db.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
  if (error) {
    const msg = $("signin-msg");
    msg.textContent = error.message;
    msg.className = "signin-msg error";
    $("signin-have-code").hidden = false;
    return;
  }
  showCodeStep(email, `Enter the code sent to ${email}.`);
}

function useExistingCode() {
  const email = $("signin-email").value.trim();
  if (!email) {
    const msg = $("signin-msg");
    msg.textContent = "Enter your email first, then your code.";
    msg.className = "signin-msg error";
    return;
  }
  showCodeStep(email, `Enter the code from your email for ${email}.`);
}

async function verifyCode(email, code) {
  const { error } = await db.auth.verifyOtp({ email, token: code, type: "email" });
  if (error) {
    const msg = $("signin-msg");
    msg.textContent = error.message;
    msg.className = "signin-msg error";
  }
}

function resetSignIn() {
  signinEmail = "";
  $("signin-email").hidden = false;
  $("signin-email").value = "";
  $("signin-code").hidden = true;
  $("signin-submit").textContent = "Send code";
  $("signin-restart").hidden = true;
  $("signin-have-code").hidden = false;
  $("signin-msg").textContent = "";
}

// ---------- API ----------

async function api(action, payload) {
  if (!session || !session.access_token) {
    const { data: { session: s } } = await db.auth.getSession();
    session = s;
  }
  if (!session || !session.access_token) throw new Error("Please sign in again.");
  const r = await fetch("/api/drawer", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ action, ...payload }),
  });
  let data = {};
  try { data = await r.json(); } catch (e) {}
  if (!r.ok || data.error) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

// ---------- list ----------

async function loadList() {
  $("drawer-count").textContent = "Opening…";
  try {
    const data = await api("list", {});
    notes = Array.isArray(data.notes) ? data.notes : [];
    renderList();
  } catch (e) {
    $("drawer-count").textContent = "";
    toast(e.message || "Couldn't open the drawer");
  }
}

// Sub-folder under Cassie/ that a note lives in ("" = the drawer's top level).
function subFolder(path) {
  const rest = path.startsWith(ROOT) ? path.slice(ROOT.length) : path;
  const slash = rest.lastIndexOf("/");
  return slash === -1 ? "" : rest.slice(0, slash);
}

function titleOf(note) {
  if (note.title && note.title.trim()) return note.title.trim();
  const name = note.path.split("/").pop() || note.path;
  return name.replace(/\.md$/i, "");
}

function renderList() {
  const list = $("drawer-list");
  list.innerHTML = "";
  $("drawer-count").textContent =
    notes.length ? `${notes.length} ${notes.length === 1 ? "thing" : "things"}` : "Empty — for now";

  // Group by sub-folder, top level first, then folders alphabetically.
  const groups = {};
  for (const n of notes) {
    const f = subFolder(n.path);
    (groups[f] = groups[f] || []).push(n);
  }
  const folders = Object.keys(groups).sort((a, b) => {
    if (a === "") return -1;
    if (b === "") return 1;
    return a.localeCompare(b);
  });

  for (const f of folders) {
    if (f !== "" || folders.length > 1) {
      const label = document.createElement("div");
      label.className = "drawer-folder-label";
      label.textContent = f === "" ? "Loose in the drawer" : f;
      list.appendChild(label);
    }
    for (const n of groups[f]) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "drawer-list-item" + (current && current.path === n.path ? " active" : "");
      const t = document.createElement("div");
      t.className = "drawer-item-title";
      t.textContent = titleOf(n);
      const m = document.createElement("div");
      m.className = "drawer-item-meta";
      m.textContent = [
        typeof n.wordCount === "number" ? `${n.wordCount} words` : "",
        fmtDate(n.lastModified),
      ].filter(Boolean).join(" · ");
      btn.appendChild(t);
      btn.appendChild(m);
      btn.addEventListener("click", () => openNote(n.path));
      li.appendChild(btn);
      list.appendChild(li);
    }
  }
}

function fmtDate(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch (e) { return ""; }
}

// ---------- gather (pull her writing/poetry in from elsewhere) ----------

async function loadGatherable() {
  try {
    const data = await api("gatherable", {});
    renderGatherable(Array.isArray(data.notes) ? data.notes : []);
  } catch (e) {
    // Non-fatal: the drawer itself still works without the gather panel.
  }
}

function renderGatherable(items) {
  const wrap = $("drawer-gather-wrap");
  const list = $("drawer-gather-list");
  list.innerHTML = "";
  // Un-gathered first, then alphabetical.
  items.sort((a, b) => (a.mirrored - b.mirrored) || a.path.localeCompare(b.path));
  if (!items.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  const pending = items.filter((i) => !i.mirrored).length;
  $("drawer-gather-summary").textContent =
    `📥 Bring in from elsewhere${pending ? ` (${pending})` : ""}`;

  for (const it of items) {
    const li = document.createElement("li");
    li.className = "drawer-gather-item";
    const info = document.createElement("div");
    info.className = "drawer-gather-info";
    const t = document.createElement("div");
    t.className = "drawer-item-title";
    t.textContent = (it.title && it.title.trim()) ||
      (it.path.split("/").pop() || it.path).replace(/\.md$/i, "");
    const m = document.createElement("div");
    m.className = "drawer-item-meta";
    m.textContent = [
      it.folder,
      typeof it.wordCount === "number" ? `${it.wordCount} words` : "",
    ].filter(Boolean).join(" · ");
    info.appendChild(t);
    info.appendChild(m);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = it.mirrored ? "ghost small" : "primary small";
    btn.textContent = it.mirrored ? "Remove stray" : "Bring in";
    btn.title = it.mirrored
      ? "A copy is already in your drawer — clear this leftover original"
      : "Move this into your drawer";
    btn.addEventListener("click", () => gatherNote(it.path, btn));

    li.appendChild(info);
    li.appendChild(btn);
    list.appendChild(li);
  }
}

async function gatherNote(path, btn) {
  if (btn) { btn.disabled = true; btn.textContent = "…"; }
  try {
    await api("gather", { path });
    toast("Brought into your drawer ♡");
    await loadList();
    await loadGatherable();
  } catch (e) {
    toast(e.message || "Couldn't gather that");
    if (btn) { btn.disabled = false; }
  }
}

// ---------- open / edit / save ----------

async function openNote(path) {
  if (!await confirmDiscard()) return;
  try {
    const data = await api("read", { path });
    current = { path, title: titleOf({ path, title: (data.frontmatter || {}).title }) };
    showNote(data.content || "");
    renderList();   // refresh the active highlight
  } catch (e) {
    toast(e.message || "Couldn't open that note");
  }
}

function showNote(content) {
  $("drawer-empty").hidden = true;
  $("drawer-note").hidden = false;
  $("drawer-main").classList.add("has-note");
  $("drawer-note-title").textContent = current.title;
  $("drawer-note-path").textContent = current.path;
  $("drawer-content").value = content;
  setDirty(false);
}

function setDirty(d) {
  dirty = d;
  $("drawer-savestate").textContent = d ? "Unsaved changes" : (current ? "Saved" : "");
}

async function saveNote() {
  if (!current) return;
  const content = $("drawer-content").value;
  $("drawer-save-btn").disabled = true;
  $("drawer-savestate").textContent = "Saving…";
  try {
    await api("save", { path: current.path, content });
    setDirty(false);
    await loadList();
    toast("Saved to your drawer ♡");
  } catch (e) {
    $("drawer-savestate").textContent = "Unsaved changes";
    toast(e.message || "Couldn't save");
  } finally {
    $("drawer-save-btn").disabled = false;
  }
}

async function confirmDiscard() {
  if (!dirty) return true;
  return window.confirm("You have unsaved changes. Leave without saving?");
}

// ---------- new ----------

// Turn what she types into a safe relative path under Cassie/, keeping her
// casing and spaces (so folders read "Plant Tracking", not "plant-tracking").
// "/" makes a folder; illegal filename characters and ".." are stripped.
function sanitizeRel(input) {
  return String(input || "")
    .split("/")
    .map((seg) => seg.replace(/[\\:*?"<>|]/g, "").replace(/\.{2,}/g, "").trim())
    .filter(Boolean)
    .join("/");
}

async function createNote() {
  const raw = $("drawer-newtitle").value.trim();
  if (!raw) { $("drawer-newtitle").focus(); return; }
  const rel = sanitizeRel(raw);
  if (!rel) { toast("Give it a name with some letters or numbers ♡"); return; }
  const path = ROOT + rel + ".md";

  // Don't clobber something already there — just open it instead.
  const existing = notes.find((n) => n.path.toLowerCase() === path.toLowerCase());
  if (existing) {
    toast(`"${rel}" already exists — opening it`);
    hideNewForm();
    return openNote(existing.path);
  }
  if (!await confirmDiscard()) return;

  current = { path, title: rel.split("/").pop() };
  showNote("");
  setDirty(true);            // nothing saved yet — first Save creates it
  $("drawer-savestate").textContent = "New — Save to keep it";
  hideNewForm();
  $("drawer-content").focus();
}

// ---- move / rename / delete ----

async function renameNote() {
  if (!current) return;
  if (dirty) { toast("Save your changes first, then move it ♡"); return; }
  const rel = current.path.slice(ROOT.length).replace(/\.md$/i, "");
  const input = window.prompt(
    "New name — or Folder/Name to move it into a section:", rel);
  if (input == null) return;
  const cleaned = sanitizeRel(input);
  if (!cleaned) { toast("Give it a name with some letters or numbers ♡"); return; }
  const to = ROOT + cleaned + ".md";
  if (to.toLowerCase() === current.path.toLowerCase()) return;
  try {
    const data = await api("move", { from: current.path, to });
    current = { path: data.path, title: titleOf({ path: data.path }) };
    $("drawer-note-title").textContent = current.title;
    $("drawer-note-path").textContent = current.path;
    await loadList();
    toast("Moved ♡");
  } catch (e) {
    toast(e.message || "Couldn't move it");
  }
}

async function deleteNote() {
  if (!current) return;
  if (!window.confirm(
      `Move "${current.title}" to the trash? You can recover it from the vault's .trash folder.`)) {
    return;
  }
  try {
    await api("delete", { path: current.path });
    current = null;
    dirty = false;
    $("drawer-note").hidden = true;
    $("drawer-empty").hidden = false;
    $("drawer-main").classList.remove("has-note");
    await loadList();
    toast("Moved to trash ♡");
  } catch (e) {
    toast(e.message || "Couldn't delete it");
  }
}

function showNewForm() {
  $("drawer-newform").hidden = false;
  $("drawer-newtitle").value = "";
  $("drawer-newtitle").focus();
}
function hideNewForm() { $("drawer-newform").hidden = true; }

// ---------- wiring ----------

function wireDrawer() {
  $("drawer-new-btn").addEventListener("click", () =>
    $("drawer-newform").hidden ? showNewForm() : hideNewForm());
  $("drawer-create-btn").addEventListener("click", createNote);
  $("drawer-newtitle").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); createNote(); }
  });
  $("drawer-save-btn").addEventListener("click", saveNote);
  $("drawer-rename-btn").addEventListener("click", renameNote);
  $("drawer-delete-btn").addEventListener("click", deleteNote);
  $("drawer-content").addEventListener("input", () => { if (!dirty) setDirty(true); });

  // Cmd/Ctrl+S saves.
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (!$("drawer-note").hidden) saveNote();
    }
  });
  // Nudge before leaving with unsaved edits.
  window.addEventListener("beforeunload", (e) => {
    if (dirty) { e.preventDefault(); e.returnValue = ""; }
  });
}

// ---------- toast ----------

let toastTimer = null;
function toast(msg) {
  const el = $("toast");
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => { el.hidden = true; }, 300);
  }, 2600);
}

boot();
