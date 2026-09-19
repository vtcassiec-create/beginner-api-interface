/*
 * Sonder — patterns, projects, and the notes between them.
 *
 * A pattern is a recipe. A project is one time you cooked it. The shelf
 * holds patterns (source, standing notes, links, files); the needles hold
 * projects (who it's for, which size, counters, dated notes, photos), as many
 * per pattern as there are feet in the family.
 *
 * Reuses Petrichor's login (same Supabase project, same browser session) and
 * talks to Supabase directly under row-level security — no server in the
 * middle except /api/sonder_ask, which hands a pattern + question to Claude.
 * Hash routes: #/  #/pattern/<id>  #/project/<id>  #/new-pattern  #/new-project/<patternId?>
 */

const $ = (id) => document.getElementById(id);
const BUCKET = "sonder";

let db = null;
let session = null;
let user = null;
let patterns = [];
let projects = [];
let counters = new Map();   // projectId -> [counter]
let signedUrlCache = new Map();

// ---------- boot ----------

async function boot() {
  let cfg;
  try { cfg = await (await fetch("/api/config")).json(); }
  catch (e) { return showSetupError("Couldn't reach /api/config. Make sure the app is deployed."); }
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    return showSetupError("Supabase isn't configured (SUPABASE_URL / SUPABASE_ANON_KEY).");
  }
  if (!window.supabase || typeof window.supabase.createClient !== "function") {
    return showSetupError("Supabase SDK didn't load. Check your connection and refresh.");
  }
  db = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

  const { data: { session: s } } = await db.auth.getSession();
  session = s;
  if (session) enterApp(); else showSignIn();

  db.auth.onAuthStateChange((event, s2) => {
    if (event === "SIGNED_IN" && s2) {
      const already = user && user.id === s2.user.id && !$("so-shell").hidden;
      session = s2;
      if (!already) enterApp();
    } else if (event === "SIGNED_OUT") { session = null; user = null; showSignIn(); }
  });

  wireSignIn();
  window.addEventListener("hashchange", route);
  $("so-file-input").addEventListener("change", onFilePicked);
}

function showSetupError(msg) {
  $("signin-screen").hidden = true; $("so-shell").hidden = true;
  $("setup-error").hidden = false; $("setup-error-msg").textContent = msg;
}
function showSignIn() {
  $("setup-error").hidden = true; $("so-shell").hidden = true; $("signin-screen").hidden = false;
}
async function enterApp() {
  user = session.user;
  $("signin-screen").hidden = true; $("setup-error").hidden = true; $("so-shell").hidden = false;
  await loadAll();
  route();
}

// ---------- sign-in (mirrors the drawer's email-OTP flow) ----------

let signinEmail = "";
function wireSignIn() {
  $("signin-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("signin-email").value.trim();
    if (!$("signin-code").hidden) return verifyCode(signinEmail || email, $("signin-code").value.trim());
    if (email) await sendCode(email);
  });
  $("signin-have-code").addEventListener("click", () => {
    const email = $("signin-email").value.trim();
    if (!email) return signinMsg("Enter your email first, then your code.", true);
    showCodeStep(email, `Enter the code from your email for ${email}.`);
  });
  $("signin-restart").addEventListener("click", resetSignIn);
}
function signinMsg(text, isError) {
  const m = $("signin-msg"); m.textContent = text; m.className = "signin-msg " + (isError ? "error" : "success");
}
function showCodeStep(email, message) {
  signinEmail = email;
  $("signin-email").hidden = true; $("signin-code").hidden = false; $("signin-code").value = ""; $("signin-code").focus();
  $("signin-submit").textContent = "Verify & sign in"; $("signin-restart").hidden = false; $("signin-have-code").hidden = true;
  signinMsg(message, false);
}
async function sendCode(email) {
  const { error } = await db.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
  if (error) { signinMsg(error.message, true); $("signin-have-code").hidden = false; return; }
  showCodeStep(email, `Enter the code sent to ${email}.`);
}
async function verifyCode(email, code) {
  const { error } = await db.auth.verifyOtp({ email, token: code, type: "email" });
  if (error) signinMsg(error.message, true);
}
function resetSignIn() {
  signinEmail = "";
  $("signin-email").hidden = false; $("signin-email").value = ""; $("signin-code").hidden = true;
  $("signin-submit").textContent = "Send code"; $("signin-restart").hidden = true; $("signin-have-code").hidden = false;
  $("signin-msg").textContent = "";
}

// ---------- data ----------

async function loadAll() {
  const [p, j, c] = await Promise.all([
    db.from("sonder_patterns").select("*").order("updated_at", { ascending: false }),
    db.from("sonder_projects").select("*").order("updated_at", { ascending: false }),
    db.from("sonder_counters").select("*").order("position", { ascending: true }),
  ]);
  const err = p.error || j.error || c.error;
  if (err) {
    toast(/relation .* does not exist/i.test(err.message)
      ? "Sonder's tables aren't set up yet — run docs/sonder-schema.sql in Supabase."
      : err.message);
  }
  patterns = p.data || [];
  projects = j.data || [];
  counters = new Map();
  for (const row of (c.data || [])) {
    if (!counters.has(row.project_id)) counters.set(row.project_id, []);
    counters.get(row.project_id).push(row);
  }
}

const patternById = (id) => patterns.find((p) => p.id === id) || null;
const projectById = (id) => projects.find((p) => p.id === id) || null;
const projectsOf = (patternId) => projects.filter((p) => p.pattern_id === patternId);

async function savePattern(id, fields) {
  if (id) {
    const { data, error } = await db.from("sonder_patterns").update(fields).eq("id", id).select().single();
    if (error) throw error;
    patterns = patterns.map((p) => (p.id === id ? data : p));
    return data;
  }
  const { data, error } = await db.from("sonder_patterns").insert({ user_id: user.id, ...fields }).select().single();
  if (error) throw error;
  patterns.unshift(data);
  return data;
}

async function saveProject(id, fields) {
  if (id) {
    const { data, error } = await db.from("sonder_projects").update(fields).eq("id", id).select().single();
    if (error) throw error;
    projects = projects.map((p) => (p.id === id ? data : p));
    return data;
  }
  const { data, error } = await db.from("sonder_projects").insert({ user_id: user.id, ...fields }).select().single();
  if (error) throw error;
  projects.unshift(data);
  return data;
}

async function saveCounter(id, fields) {
  const { data, error } = await db.from("sonder_counters").update(fields).eq("id", id).select().single();
  if (error) throw error;
  const list = counters.get(data.project_id) || [];
  counters.set(data.project_id, list.map((c) => (c.id === id ? data : c)));
  return data;
}

async function addCounter(projectId, name, target) {
  const list = counters.get(projectId) || [];
  const { data, error } = await db.from("sonder_counters")
    .insert({ user_id: user.id, project_id: projectId, name: name || "rows", target: target || null, position: list.length })
    .select().single();
  if (error) throw error;
  counters.set(projectId, [...list, data]);
  return data;
}

async function removeCounter(c) {
  const { error } = await db.from("sonder_counters").delete().eq("id", c.id);
  if (error) throw error;
  counters.set(c.project_id, (counters.get(c.project_id) || []).filter((x) => x.id !== c.id));
}

// ---------- storage ----------

async function uploadFile(file, folder) {
  const safe = file.name.replace(/[^\w.\-]+/g, "_").slice(-80);
  const path = `${user.id}/${folder}/${Date.now()}-${safe}`;
  const { error } = await db.storage.from(BUCKET).upload(path, file, { contentType: file.type || undefined });
  if (error) throw error;
  return { path, name: file.name, type: file.type || "", size: file.size };
}

async function signedUrl(path) {
  const hit = signedUrlCache.get(path);
  if (hit && hit.until > Date.now()) return hit.url;
  const { data, error } = await db.storage.from(BUCKET).createSignedUrl(path, 3600);
  if (error) throw error;
  signedUrlCache.set(path, { url: data.signedUrl, until: Date.now() + 50 * 60 * 1000 });
  return data.signedUrl;
}

async function removeStored(path) {
  try { await db.storage.from(BUCKET).remove([path]); } catch (e) { /* best-effort */ }
}

// One hidden file input, re-aimed per use.
let filePickHandler = null;
function pickFile(accept, handler) {
  const inp = $("so-file-input");
  inp.accept = accept || "";
  inp.value = "";
  filePickHandler = handler;
  inp.click();
}
async function onFilePicked(e) {
  const file = e.target.files && e.target.files[0];
  if (!file || !filePickHandler) return;
  const h = filePickHandler; filePickHandler = null;
  try { await h(file); } catch (err) { toast(err.message || "Upload failed"); }
}

// ---------- routing ----------

function route() {
  if (!user) return;
  const hash = location.hash || "#/";
  const m = hash.match(/^#\/(pattern|project|new-pattern|new-project)(?:\/([^/]+))?/);
  window.scrollTo(0, 0);
  if (!m) return renderHome();
  if (m[1] === "pattern") return renderPattern(m[2]);
  if (m[1] === "project") return renderProject(m[2]);
  if (m[1] === "new-pattern") return renderPatternForm(null);
  if (m[1] === "new-project") return renderProjectForm(null, m[2] || "");
}

// ---------- helpers ----------

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function linkify(text) {
  return esc(text).replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
}
function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
function fmtStamp(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function statusWord(s) {
  return { planned: "planned", knitting: "on the needles", paused: "paused", finished: "finished", frogged: "frogged" }[s] || s;
}
function fieldHtml(id, label, value, opts = {}) {
  const v = esc(value || "");
  if (opts.textarea) {
    return `<div class="so-field"><label for="${id}">${label}</label>
      <textarea id="${id}" class="${opts.cls || ""}" placeholder="${esc(opts.placeholder || "")}">${v}</textarea></div>`;
  }
  if (opts.select) {
    return `<div class="so-field"><label for="${id}">${label}</label><select id="${id}">${
      opts.select.map(([val, text]) => `<option value="${val}" ${val === value ? "selected" : ""}>${text}</option>`).join("")
    }</select></div>`;
  }
  return `<div class="so-field"><label for="${id}">${label}</label>
    <input id="${id}" type="${opts.type || "text"}" value="${v}" placeholder="${esc(opts.placeholder || "")}" /></div>`;
}
let toastTimer = null;
function toast(msg) {
  const t = $("toast"); if (!t) return;
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}
function countersSummary(projectId) {
  const list = counters.get(projectId) || [];
  if (!list.length) return "";
  return list.map((c) => `${c.name} ${c.value}${c.target ? "/" + c.target : ""}`).join(" · ");
}

// ---------- home ----------

function renderHome() {
  const active = projects.filter((p) => ["knitting", "planned", "paused"].includes(p.status));
  const done = projects.filter((p) => !["knitting", "planned", "paused"].includes(p.status));
  const shelf = patterns.filter((p) => !p.archived);
  const projectCard = (p) => {
    const pat = patternById(p.pattern_id);
    const meta = [pat ? pat.name : null, p.for_whom ? `for ${p.for_whom}` : null, p.size ? `size ${p.size}` : null]
      .filter(Boolean).join(" · ");
    const cs = countersSummary(p.id);
    return `<a class="so-card" href="#/project/${p.id}">
      <div class="so-card-title"><span>${esc(p.name)}</span><span class="so-pill ${esc(p.status)}">${esc(statusWord(p.status))}</span></div>
      <div class="so-card-meta">${esc(meta)}${cs ? `<br/>${esc(cs)}` : ""}</div></a>`;
  };
  $("so-main").innerHTML = `
    <section class="so-section">
      <div class="so-section-head"><h2>On the needles</h2>
        <button class="primary small" id="btn-new-project" type="button">&#65291; Project</button></div>
      ${active.length ? active.map(projectCard).join("") : `<div class="so-empty">Nothing on the needles. Start a project from a pattern on the shelf.</div>`}
    </section>
    <section class="so-section">
      <div class="so-section-head"><h2>The shelf</h2>
        <button class="primary small" id="btn-new-pattern" type="button">&#65291; Pattern</button></div>
      ${shelf.length ? shelf.map((p) => {
        const n = projectsOf(p.id).length;
        const meta = [p.designer, n ? `${n} project${n === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ");
        return `<a class="so-card" href="#/pattern/${p.id}">
          <div class="so-card-title"><span>${esc(p.name)}</span></div>
          <div class="so-card-meta">${esc(meta)}${(p.tags || []).length ? `<div>${p.tags.map((t) => `<span class="so-tag">${esc(t)}</span>`).join("")}</div>` : ""}</div></a>`;
      }).join("") : `<div class="so-empty">The shelf is empty. Add a pattern: a link, a photo, or the text itself.</div>`}
    </section>
    ${done.length ? `<details class="so-more"><summary>Finished &amp; frogged (${done.length})</summary>${done.map(projectCard).join("")}</details>` : ""}
    ${patterns.some((p) => p.archived) ? `<details class="so-more"><summary>Archived patterns</summary>${
      patterns.filter((p) => p.archived).map((p) => `<a class="so-card" href="#/pattern/${p.id}"><div class="so-card-title"><span>${esc(p.name)}</span></div></a>`).join("")
    }</details>` : ""}`;
  $("btn-new-project").addEventListener("click", () => { location.hash = "#/new-project"; });
  $("btn-new-pattern").addEventListener("click", () => { location.hash = "#/new-pattern"; });
}

// ---------- pattern form (new / edit) ----------

function patternFormHtml(p) {
  p = p || {};
  return `<div class="so-form">
    ${fieldHtml("f-name", "Name", p.name, { placeholder: "Peacock Socks" })}
    <div class="so-two">${fieldHtml("f-designer", "Designer", p.designer)}${fieldHtml("f-tags", "Tags", (p.tags || []).join(", "), { placeholder: "socks, gift" })}</div>
    ${fieldHtml("f-source", "Where it lives (link)", p.source_url, { type: "url", placeholder: "https://…" })}
    <div class="so-two">${fieldHtml("f-needles", "Needles", p.needles)}${fieldHtml("f-yarn", "Yarn", p.yarn)}</div>
    <div class="so-two">${fieldHtml("f-gauge", "Gauge", p.gauge, { placeholder: "40 sts × 56 rows / 10 cm" })}${fieldHtml("f-sizes", "Sizes", p.sizes, { placeholder: "S, M, L, XL (54, 62, 70, 78)" })}</div>
    ${fieldHtml("f-notes", "Standing notes (true every time)", p.notes, { textarea: true, placeholder: "I go up a needle on twisted stitches…" })}
    ${fieldHtml("f-body", "The pattern (paste or type it)", p.body, { textarea: true, cls: "so-body", placeholder: "Cast on 54 (62, 70, 78) sts…" })}
  </div>`;
}
function readPatternForm() {
  return {
    name: $("f-name").value.trim(),
    designer: $("f-designer").value.trim() || null,
    tags: $("f-tags").value.split(",").map((t) => t.trim()).filter(Boolean),
    source_url: $("f-source").value.trim() || null,
    needles: $("f-needles").value.trim() || null,
    yarn: $("f-yarn").value.trim() || null,
    gauge: $("f-gauge").value.trim() || null,
    sizes: $("f-sizes").value.trim() || null,
    notes: $("f-notes").value.trim() || null,
    body: $("f-body").value.trim() || null,
  };
}
function renderPatternForm(p) {
  $("so-main").innerHTML = `<a class="so-back" href="${p ? "#/pattern/" + p.id : "#/"}">&larr; ${p ? "Back to the pattern" : "Back"}</a>
    <div class="so-title">${p ? "Edit pattern" : "New pattern"}</div>
    ${patternFormHtml(p)}
    <div class="so-row end" style="margin-top:12px"><button class="primary" id="f-save" type="button">Save</button></div>`;
  $("f-save").addEventListener("click", async () => {
    const fields = readPatternForm();
    if (!fields.name) return toast("Give it a name.");
    try {
      const saved = await savePattern(p ? p.id : null, fields);
      location.hash = "#/pattern/" + saved.id;
    } catch (e) { toast(e.message); }
  });
  $("f-name").focus();
}

// ---------- pattern view ----------

async function renderPattern(id) {
  const p = patternById(id);
  if (!p) { $("so-main").innerHTML = `<a class="so-back" href="#/">&larr; Back</a><div class="so-empty">That pattern isn't here.</div>`; return; }
  const projs = projectsOf(p.id);
  const facts = [
    p.designer ? `by ${p.designer}` : null, p.needles, p.yarn, p.gauge, p.sizes ? `sizes ${p.sizes}` : null,
  ].filter(Boolean);
  $("so-main").innerHTML = `
    <a class="so-back" href="#/">&larr; Shelf</a>
    <div class="so-row between"><div class="so-title">${esc(p.name)}</div>
      <button class="ghost small" id="p-edit" type="button">Edit</button></div>
    <p class="so-sub">${esc(facts.join(" · "))}${p.source_url ? ` · <a href="${esc(p.source_url)}" target="_blank" rel="noopener">source</a>` : ""}
      ${(p.tags || []).length ? `<div>${p.tags.map((t) => `<span class="so-tag">${esc(t)}</span>`).join("")}</div>` : ""}</p>

    <section class="so-section">
      <div class="so-section-head"><h2>Projects from this pattern</h2>
        <button class="primary small" id="p-new-project" type="button">&#65291; Start one</button></div>
      ${projs.length ? projs.map((j) => `<a class="so-card" href="#/project/${j.id}">
        <div class="so-card-title"><span>${esc(j.name)}</span><span class="so-pill ${esc(j.status)}">${esc(statusWord(j.status))}</span></div>
        <div class="so-card-meta">${esc([j.for_whom ? `for ${j.for_whom}` : null, j.size ? `size ${j.size}` : null, j.yarn].filter(Boolean).join(" · "))}</div></a>`).join("")
        : `<div class="so-empty">No projects yet.</div>`}
    </section>

    ${p.notes ? `<section class="so-section"><div class="so-section-head"><h2>Standing notes</h2></div>
      <div class="so-note"><div class="so-note-text">${linkify(p.notes)}</div></div></section>` : ""}

    <section class="so-section">
      <div class="so-section-head"><h2>Ask about this pattern</h2></div>
      <div class="so-ask"><input id="p-ask-q" placeholder="One size bigger than XL?" /><button class="primary small" id="p-ask" type="button">Ask</button></div>
      <div id="p-ask-out"></div>
      <p class="muted small" style="margin:6px 0 0">Answers are saved below as notes. Runs on your API key; a few cents each.</p>
      <div id="p-asks">${renderAsks(p.links)}</div>
    </section>

    <section class="so-section">
      <div class="so-section-head"><h2>Links</h2></div>
      <div id="p-links">${renderLinks(p.links)}</div>
      <div class="so-inline-form"><input id="p-link-label" placeholder="Label" /><input id="p-link-url" type="url" placeholder="https://…" /><button class="ghost small" id="p-link-add" type="button">Add</button></div>
    </section>

    <section class="so-section">
      <div class="so-section-head"><h2>Files &amp; photos</h2><button class="ghost small" id="p-file-add" type="button">&#65291; Upload</button></div>
      <div id="p-files">${await renderFiles(p.files)}</div>
    </section>

    ${p.body ? `<section class="so-section"><div class="so-section-head"><h2>The pattern</h2></div>
      <div class="so-note"><div class="so-note-text">${linkify(p.body)}</div></div></section>` : ""}

    <div class="so-danger-zone so-row between">
      <button class="ghost small" id="p-archive" type="button">${p.archived ? "Unarchive" : "Archive"}</button>
      <button class="danger ghost small" id="p-delete" type="button">Delete pattern</button>
    </div>`;

  $("p-edit").addEventListener("click", () => renderPatternForm(p));
  $("p-new-project").addEventListener("click", () => { location.hash = "#/new-project/" + p.id; });
  wireLinks(p, "p-links", "p-link-label", "p-link-url", "p-link-add", (fields) => savePattern(p.id, fields));
  $("p-file-add").addEventListener("click", () => pickFile("image/*,application/pdf", async (file) => {
    toast("Uploading…");
    const f = await uploadFile(file, "patterns/" + p.id);
    const saved = await savePattern(p.id, { files: [...(p.files || []), f] });
    $("p-files").innerHTML = await renderFiles(saved.files);
    wireFileRemoves(saved, "p-files");
    toast("Uploaded.");
  }));
  wireFileRemoves(p, "p-files");
  wireAsk(p, null, "p-ask-q", "p-ask", "p-ask-out", "p-asks");
  $("p-archive").addEventListener("click", async () => {
    try { await savePattern(p.id, { archived: !p.archived }); renderPattern(p.id); } catch (e) { toast(e.message); }
  });
  $("p-delete").addEventListener("click", async () => {
    if (!confirm(`Delete "${p.name}"? Its projects stay, unlinked. This can't be undone.`)) return;
    try {
      for (const f of (p.files || [])) await removeStored(f.path);
      const { error } = await db.from("sonder_patterns").delete().eq("id", p.id);
      if (error) throw error;
      patterns = patterns.filter((x) => x.id !== p.id);
      projects = projects.map((j) => (j.pattern_id === p.id ? { ...j, pattern_id: null } : j));
      location.hash = "#/";
    } catch (e) { toast(e.message); }
  });
}

// Links live in one JSONB list; "ask" answers ride in the same list with
// kind: "ask" so a pattern's Q&A stays attached to it.
function plainLinks(list) { return (list || []).filter((l) => l && l.kind !== "ask"); }
function askNotes(list) { return (list || []).filter((l) => l && l.kind === "ask"); }
function renderLinks(list) {
  const ls = plainLinks(list);
  if (!ls.length) return `<div class="so-empty">No links yet.</div>`;
  return ls.map((l, i) => `<div class="so-link"><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label || l.url)}</a>
    <button class="ghost small" data-rm-link="${i}" type="button">&times;</button></div>`).join("");
}
function renderAsks(list) {
  return askNotes(list).slice().reverse().map((a) => `<div class="so-note ask">
    <div class="so-note-at"><span>${esc(fmtStamp(a.at))} · ${esc(a.q)}</span><button class="ghost small" data-rm-ask="${esc(a.at)}" type="button">&times;</button></div>
    <div class="so-note-text">${linkify(a.a)}</div></div>`).join("");
}
function wireLinks(row, listId, labelId, urlId, addId, save) {
  const rewire = (saved) => {
    row.links = saved.links;
    $(listId).innerHTML = renderLinks(row.links);
    $(listId).querySelectorAll("[data-rm-link]").forEach((b) => b.addEventListener("click", async () => {
      const ls = plainLinks(row.links); ls.splice(parseInt(b.dataset.rmLink, 10), 1);
      try { rewire(await save({ links: [...ls, ...askNotes(row.links)] })); } catch (e) { toast(e.message); }
    }));
  };
  rewire(row);
  $(addId).addEventListener("click", async () => {
    let url = $(urlId).value.trim(); const label = $(labelId).value.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    try {
      rewire(await save({ links: [...(row.links || []), { label: label || url, url }] }));
      $(urlId).value = ""; $(labelId).value = "";
    } catch (e) { toast(e.message); }
  });
}

async function renderFiles(files) {
  const fs = files || [];
  if (!fs.length) return `<div class="so-empty">Nothing uploaded yet.</div>`;
  const parts = [];
  for (let i = 0; i < fs.length; i++) {
    const f = fs[i];
    let url = "";
    try { url = await signedUrl(f.path); } catch (e) {}
    if ((f.type || "").startsWith("image/")) {
      parts.push(`<div class="so-photo"><a href="${esc(url)}" target="_blank" rel="noopener"><img src="${esc(url)}" alt="${esc(f.name)}" loading="lazy" /></a>
        <button class="ghost small" data-rm-file="${i}" type="button">&times;</button></div>`);
    } else {
      parts.push(`<div class="so-link" style="grid-column:1/-1"><a href="${esc(url)}" target="_blank" rel="noopener">&#128196; ${esc(f.name)}</a>
        <button class="ghost small" data-rm-file="${i}" type="button">&times;</button></div>`);
    }
  }
  return `<div class="so-photos">${parts.join("")}</div>`;
}
function wireFileRemoves(p, listId) {
  $(listId).querySelectorAll("[data-rm-file]").forEach((b) => b.addEventListener("click", async () => {
    const i = parseInt(b.dataset.rmFile, 10);
    const f = (p.files || [])[i];
    if (!f || !confirm(`Remove ${f.name}?`)) return;
    try {
      await removeStored(f.path);
      const files = (p.files || []).filter((_, k) => k !== i);
      const saved = await savePattern(p.id, { files });
      p.files = saved.files;
      $(listId).innerHTML = await renderFiles(p.files);
      wireFileRemoves(p, listId);
    } catch (e) { toast(e.message); }
  }));
}

// ---------- ask ----------

function patternContext(p, j) {
  const lines = [];
  if (p) {
    lines.push(`Pattern: ${p.name}${p.designer ? " by " + p.designer : ""}`);
    for (const [k, v] of [["Sizes", p.sizes], ["Needles", p.needles], ["Yarn", p.yarn], ["Gauge", p.gauge], ["Standing notes", p.notes]]) {
      if (v) lines.push(`${k}: ${v}`);
    }
    if (p.body) lines.push("", "PATTERN TEXT:", p.body);
  }
  if (j) {
    lines.push("", `Project: ${j.name}`);
    for (const [k, v] of [["For", j.for_whom], ["Size", j.size], ["Yarn", j.yarn], ["Needles", j.needles], ["Gauge", j.gauge], ["Status", j.status], ["Measurements", j.measurements]]) {
      if (v) lines.push(`${k}: ${v}`);
    }
    const cs = countersSummary(j.id); if (cs) lines.push(`Counters: ${cs}`);
    const notes = (j.notes || []).slice(-8);
    if (notes.length) lines.push("Recent notes:", ...notes.map((n) => `- ${fmtStamp(n.at)}: ${n.text}`));
  }
  return lines.join("\n");
}

function wireAsk(p, j, qId, btnId, outId, listId) {
  $(btnId).addEventListener("click", async () => {
    const q = $(qId).value.trim();
    if (!q) return;
    if (!session || !session.access_token) return toast("Please sign in again.");
    $(btnId).disabled = true; $(outId).innerHTML = `<div class="so-empty">Thinking…</div>`;
    try {
      const r = await fetch("/api/sonder_ask", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${session.access_token}` },
        body: JSON.stringify({ question: q, context: patternContext(p, j) }),
      });
      let data = {}; try { data = await r.json(); } catch (e) {}
      if (!r.ok || data.error) throw new Error(data.error || `Request failed (${r.status})`);
      const entry = { kind: "ask", at: new Date().toISOString(), q, a: data.answer };
      if (j) {
        const saved = await saveProject(j.id, { notes: [...(j.notes || []), { at: entry.at, text: `Asked: ${q}\n\n${data.answer}`, ask: true }] });
        j.notes = saved.notes;
        $(listId).innerHTML = renderNotes(j.notes); wireNoteRemoves(j, listId);
      } else {
        const saved = await savePattern(p.id, { links: [...(p.links || []), entry] });
        p.links = saved.links;
        $(listId).innerHTML = renderAsks(p.links); wireAskRemoves(p, listId);
      }
      $(outId).innerHTML = ""; $(qId).value = "";
    } catch (e) {
      $(outId).innerHTML = `<div class="so-empty">${esc(e.message)}</div>`;
    } finally { $(btnId).disabled = false; }
  });
  if (!j) wireAskRemoves(p, listId);
}
function wireAskRemoves(p, listId) {
  $(listId).querySelectorAll("[data-rm-ask]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Remove this answer?")) return;
    try {
      const saved = await savePattern(p.id, { links: (p.links || []).filter((l) => !(l.kind === "ask" && l.at === b.dataset.rmAsk)) });
      p.links = saved.links; $(listId).innerHTML = renderAsks(p.links); wireAskRemoves(p, listId);
    } catch (e) { toast(e.message); }
  }));
}

// ---------- project form ----------

function projectFormHtml(j, patternId) {
  j = j || {};
  const pid = j.pattern_id || patternId || "";
  const options = [["", "— none —"], ...patterns.filter((p) => !p.archived || p.id === pid).map((p) => [p.id, p.name])];
  return `<div class="so-form">
    ${fieldHtml("f-name", "Name", j.name, { placeholder: "Dad's peacocks" })}
    ${fieldHtml("f-pattern", "Pattern", pid, { select: options })}
    <div class="so-two">${fieldHtml("f-for", "For", j.for_whom, { placeholder: "Dad" })}${fieldHtml("f-size", "Size", j.size, { placeholder: "XXL (86 sts)" })}</div>
    <div class="so-two">${fieldHtml("f-yarn", "Yarn", j.yarn)}${fieldHtml("f-needles", "Needles", j.needles, { placeholder: "2.5 mm" })}</div>
    <div class="so-two">${fieldHtml("f-gauge", "Your gauge", j.gauge)}${fieldHtml("f-status", "Status", j.status || "knitting", { select: [["planned", "Planned"], ["knitting", "On the needles"], ["paused", "Paused"], ["finished", "Finished"], ["frogged", "Frogged"]] })}</div>
    <div class="so-two">${fieldHtml("f-started", "Started", j.started_on, { type: "date" })}${fieldHtml("f-finished", "Finished", j.finished_on, { type: "date" })}</div>
    ${fieldHtml("f-measure", "How it came out", j.measurements, { textarea: true, placeholder: "27 cm foot, fit was perfect" })}
  </div>`;
}
function readProjectForm() {
  return {
    name: $("f-name").value.trim(),
    pattern_id: $("f-pattern").value || null,
    for_whom: $("f-for").value.trim() || null,
    size: $("f-size").value.trim() || null,
    yarn: $("f-yarn").value.trim() || null,
    needles: $("f-needles").value.trim() || null,
    gauge: $("f-gauge").value.trim() || null,
    status: $("f-status").value,
    started_on: $("f-started").value || null,
    finished_on: $("f-finished").value || null,
    measurements: $("f-measure").value.trim() || null,
  };
}
function renderProjectForm(j, patternId) {
  const pat = patternById(patternId);
  $("so-main").innerHTML = `<a class="so-back" href="${j ? "#/project/" + j.id : (pat ? "#/pattern/" + pat.id : "#/")}">&larr; Back</a>
    <div class="so-title">${j ? "Edit project" : "New project"}</div>
    ${projectFormHtml(j, patternId)}
    <div class="so-row end" style="margin-top:12px"><button class="primary" id="f-save" type="button">Save</button></div>`;
  if (!j && pat) {
    // Sensible defaults from the recipe; she changes what differs this time.
    $("f-yarn").value = pat.yarn || ""; $("f-needles").value = pat.needles || "";
    if (!$("f-started").value) $("f-started").value = new Date().toISOString().slice(0, 10);
  }
  $("f-save").addEventListener("click", async () => {
    const fields = readProjectForm();
    if (!fields.name) return toast("Give it a name.");
    try {
      const saved = await saveProject(j ? j.id : null, fields);
      if (!j) await addCounter(saved.id, "rows", null);
      location.hash = "#/project/" + saved.id;
    } catch (e) { toast(e.message); }
  });
  $("f-name").focus();
}

// ---------- project view ----------

async function renderProject(id) {
  const j = projectById(id);
  if (!j) { $("so-main").innerHTML = `<a class="so-back" href="#/">&larr; Back</a><div class="so-empty">That project isn't here.</div>`; return; }
  const pat = patternById(j.pattern_id);
  const facts = [j.for_whom ? `for ${j.for_whom}` : null, j.size ? `size ${j.size}` : null, j.yarn, j.needles, j.gauge,
    j.started_on ? `started ${fmtDate(j.started_on)}` : null, j.finished_on ? `finished ${fmtDate(j.finished_on)}` : null].filter(Boolean);
  $("so-main").innerHTML = `
    <a class="so-back" href="${pat ? "#/pattern/" + pat.id : "#/"}">&larr; ${pat ? esc(pat.name) : "Home"}</a>
    <div class="so-row between"><div class="so-title">${esc(j.name)}</div>
      <div class="so-row"><span class="so-pill ${esc(j.status)}">${esc(statusWord(j.status))}</span><button class="ghost small" id="j-edit" type="button">Edit</button></div></div>
    <p class="so-sub">${esc(facts.join(" · "))}</p>
    ${j.measurements ? `<div class="so-note"><div class="so-note-text">${linkify(j.measurements)}</div></div>` : ""}

    <section class="so-section">
      <div class="so-section-head"><h2>Counters</h2><button class="ghost small" id="j-counter-add" type="button">&#65291; Counter</button></div>
      <div id="j-counters"></div>
    </section>

    <section class="so-section">
      <div class="so-section-head"><h2>Notes</h2></div>
      <div class="so-field"><textarea id="j-note-text" placeholder="Turned the heel. Went up to 2.75 mm for the foot…"></textarea></div>
      <div class="so-row between" style="margin-top:6px">
        <div class="so-ask" style="flex:1;margin:0"><input id="j-ask-q" placeholder="Ask: how many rows to 27 cm?" /><button class="ghost small" id="j-ask" type="button">Ask</button></div>
        <button class="primary small" id="j-note-add" type="button">Add note</button></div>
      <div id="j-ask-out"></div>
      <div id="j-notes" style="margin-top:10px">${renderNotes(j.notes)}</div>
    </section>

    <section class="so-section">
      <div class="so-section-head"><h2>Photos</h2><button class="ghost small" id="j-photo-add" type="button">&#65291; Photo</button></div>
      <div id="j-photos">${await renderPhotos(j.photos)}</div>
    </section>

    <section class="so-section">
      <div class="so-section-head"><h2>Links</h2></div>
      <div id="j-links">${renderLinks(j.links)}</div>
      <div class="so-inline-form"><input id="j-link-label" placeholder="Label" /><input id="j-link-url" type="url" placeholder="https://…" /><button class="ghost small" id="j-link-add" type="button">Add</button></div>
    </section>

    ${pat && pat.notes ? `<section class="so-section"><div class="so-section-head"><h2>Pattern's standing notes</h2></div>
      <div class="so-note"><div class="so-note-text">${linkify(pat.notes)}</div></div></section>` : ""}
    ${pat && pat.body ? `<details class="so-more"><summary>The pattern</summary><div class="so-note"><div class="so-note-text">${linkify(pat.body)}</div></div></details>` : ""}

    <div class="so-danger-zone so-row end"><button class="danger ghost small" id="j-delete" type="button">Delete project</button></div>`;

  $("j-edit").addEventListener("click", () => renderProjectForm(j, j.pattern_id));
  renderCounters(j);
  $("j-counter-add").addEventListener("click", async () => {
    const name = prompt("Name the counter", "rows"); if (name === null) return;
    const t = prompt("Target (leave blank for none)", ""); if (t === null) return;
    try { await addCounter(j.id, name.trim() || "rows", parseInt(t, 10) || null); renderCounters(j); } catch (e) { toast(e.message); }
  });
  $("j-note-add").addEventListener("click", async () => {
    const text = $("j-note-text").value.trim(); if (!text) return;
    try {
      const saved = await saveProject(j.id, { notes: [...(j.notes || []), { at: new Date().toISOString(), text }] });
      j.notes = saved.notes; $("j-note-text").value = "";
      $("j-notes").innerHTML = renderNotes(j.notes); wireNoteRemoves(j, "j-notes");
    } catch (e) { toast(e.message); }
  });
  wireNoteRemoves(j, "j-notes");
  wireAsk(pat, j, "j-ask-q", "j-ask", "j-ask-out", "j-notes");
  $("j-photo-add").addEventListener("click", () => pickFile("image/*", async (file) => {
    toast("Uploading…");
    const f = await uploadFile(file, "projects/" + j.id);
    const saved = await saveProject(j.id, { photos: [...(j.photos || []), { path: f.path, at: new Date().toISOString() }] });
    j.photos = saved.photos;
    $("j-photos").innerHTML = await renderPhotos(j.photos); wirePhotoRemoves(j, "j-photos");
    toast("Added.");
  }));
  wirePhotoRemoves(j, "j-photos");
  wireLinks(j, "j-links", "j-link-label", "j-link-url", "j-link-add", (fields) => saveProject(j.id, fields));
  $("j-delete").addEventListener("click", async () => {
    if (!confirm(`Delete "${j.name}" and its counters, notes and photos? This can't be undone.`)) return;
    try {
      for (const ph of (j.photos || [])) await removeStored(ph.path);
      const { error } = await db.from("sonder_projects").delete().eq("id", j.id);
      if (error) throw error;
      projects = projects.filter((x) => x.id !== j.id); counters.delete(j.id);
      location.hash = pat ? "#/pattern/" + pat.id : "#/";
    } catch (e) { toast(e.message); }
  });
}

function renderNotes(notes) {
  const ns = (notes || []).slice().reverse();
  if (!ns.length) return `<div class="so-empty">No notes yet.</div>`;
  return ns.map((n) => `<div class="so-note ${n.ask ? "ask" : ""}">
    <div class="so-note-at"><span>${esc(fmtStamp(n.at))}</span><button class="ghost small" data-rm-note="${esc(n.at)}" type="button">&times;</button></div>
    <div class="so-note-text">${linkify(n.text)}</div></div>`).join("");
}
function wireNoteRemoves(j, listId) {
  $(listId).querySelectorAll("[data-rm-note]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Remove this note?")) return;
    try {
      const saved = await saveProject(j.id, { notes: (j.notes || []).filter((n) => n.at !== b.dataset.rmNote) });
      j.notes = saved.notes; $(listId).innerHTML = renderNotes(j.notes); wireNoteRemoves(j, listId);
    } catch (e) { toast(e.message); }
  }));
}

async function renderPhotos(photos) {
  const ps = photos || [];
  if (!ps.length) return `<div class="so-empty">No photos yet.</div>`;
  const parts = [];
  for (let i = 0; i < ps.length; i++) {
    let url = ""; try { url = await signedUrl(ps[i].path); } catch (e) {}
    parts.push(`<div class="so-photo"><a href="${esc(url)}" target="_blank" rel="noopener"><img src="${esc(url)}" alt="" loading="lazy" /></a>
      <button class="ghost small" data-rm-photo="${i}" type="button">&times;</button></div>`);
  }
  return `<div class="so-photos">${parts.join("")}</div>`;
}
function wirePhotoRemoves(j, listId) {
  $(listId).querySelectorAll("[data-rm-photo]").forEach((b) => b.addEventListener("click", async () => {
    const i = parseInt(b.dataset.rmPhoto, 10); const ph = (j.photos || [])[i];
    if (!ph || !confirm("Remove this photo?")) return;
    try {
      await removeStored(ph.path);
      const saved = await saveProject(j.id, { photos: (j.photos || []).filter((_, k) => k !== i) });
      j.photos = saved.photos; $(listId).innerHTML = await renderPhotos(j.photos); wirePhotoRemoves(j, listId);
    } catch (e) { toast(e.message); }
  }));
}

// ---------- counters ----------
// Taps land instantly on screen; the row is written a beat later (debounced
// per counter), so a run of +1s is one write, not twenty.

const counterTimers = new Map();
function renderCounters(j) {
  const list = counters.get(j.id) || [];
  const wrap = $("j-counters");
  if (!list.length) { wrap.innerHTML = `<div class="so-empty">No counters. Add one for rows, repeats, or a section.</div>`; return; }
  wrap.innerHTML = list.map((c) => `<div class="so-counter" data-cid="${c.id}">
    <div class="so-counter-top"><input class="so-counter-name" value="${esc(c.name)}" aria-label="Counter name" />
      <button class="ghost small" data-act="remove" type="button" title="Remove">&times;</button></div>
    <div class="so-counter-row">
      <button class="so-counter-btn" data-act="minus" type="button" aria-label="Minus one">&minus;</button>
      <div class="so-counter-val ${c.target && c.value >= c.target ? "done" : ""}"><span data-val>${c.value}</span>${c.target ? `<small> / ${c.target}</small>` : ""}</div>
      <button class="so-counter-btn plus" data-act="plus" type="button" aria-label="Plus one">+</button>
    </div>
    <div class="so-counter-foot"><label class="muted small">target <input type="number" inputmode="numeric" value="${c.target == null ? "" : c.target}" data-target /></label>
      <button class="ghost small" data-act="reset" type="button">Reset</button></div>
  </div>`).join("");
  wrap.querySelectorAll(".so-counter").forEach((el) => {
    const id = el.dataset.cid;
    const get = () => (counters.get(j.id) || []).find((x) => x.id === id);
    const schedule = (fields) => {
      clearTimeout(counterTimers.get(id));
      counterTimers.set(id, setTimeout(async () => {
        try { await saveCounter(id, fields); } catch (e) { toast("Counter didn't save: " + e.message); }
      }, 600));
    };
    const paint = () => {
      const c = get(); if (!c) return;
      el.querySelector("[data-val]").textContent = c.value;
      el.querySelector(".so-counter-val").classList.toggle("done", !!(c.target && c.value >= c.target));
    };
    const bump = (d) => {
      const c = get(); if (!c) return;
      c.value = Math.max(0, c.value + d); paint(); schedule({ value: c.value });
      if (navigator.vibrate) { try { navigator.vibrate(c.target && c.value === c.target ? [30, 60, 30] : 12); } catch (e) {} }
    };
    el.querySelector("[data-act=plus]").addEventListener("click", () => bump(1));
    el.querySelector("[data-act=minus]").addEventListener("click", () => bump(-1));
    el.querySelector("[data-act=reset]").addEventListener("click", () => {
      const c = get(); if (!c || !confirm(`Reset "${c.name}" to 0?`)) return;
      c.value = 0; paint(); schedule({ value: 0 });
    });
    el.querySelector("[data-act=remove]").addEventListener("click", async () => {
      const c = get(); if (!c || !confirm(`Remove the "${c.name}" counter?`)) return;
      try { await removeCounter(c); renderCounters(j); } catch (e) { toast(e.message); }
    });
    el.querySelector(".so-counter-name").addEventListener("change", (e) => {
      const c = get(); if (!c) return;
      c.name = e.target.value.trim() || "rows"; e.target.value = c.name; schedule({ name: c.name });
    });
    el.querySelector("[data-target]").addEventListener("change", (e) => {
      const c = get(); if (!c) return;
      const t = parseInt(e.target.value, 10);
      c.target = Number.isFinite(t) && t > 0 ? t : null;
      // Re-render this one card's readout so "/ target" appears or goes.
      const val = el.querySelector(".so-counter-val");
      val.innerHTML = `<span data-val>${c.value}</span>${c.target ? `<small> / ${c.target}</small>` : ""}`;
      paint(); schedule({ target: c.target });
    });
  });
}

boot();
