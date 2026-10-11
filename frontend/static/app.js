"use strict";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let cy = null;
let lastResult = null;
let rankDir = "LR";
let lastSource = { type: "upload", name: "Analysis" };
let currentUser = null;
let agentEnabled = false;
let authMode = "login";
let lastProposals = [];
const activeLangs = new Set(["sql", "sas", "python"]);

const LANG_COLOR = { sql: "#3b82f6", sas: "#f59e0b", python: "#22c55e", "": "#8a97a8" };
const ROLE_COLOR = { root: "#3b82f6", sink: "#22c55e", mid: "#a855f7", runtime: "#64748b" };
const LINEAGE_VIEWS = { summary: "Summary", datasets: "Datasets", operations: "Operations", details: "Details", review: "Review" };
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Screen switching
// ---------------------------------------------------------------------------
function showWorkspace() { $("home").hidden = true; $("workspace").hidden = false; }
function showHome() {
  $("workspace").hidden = true; $("home").hidden = false;
  if (cy) { cy.destroy(); cy = null; }
  lastResult = null;
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------
function showLoading(on) { $("loading").hidden = !on; }

async function postForm(url, form) {
  showLoading(true);
  try {
    const res = await fetch(url, { method: "POST", body: form });
    const data = await res.json();
    showWorkspace();
    render(data);
  } catch (e) {
    alert("Parse failed: " + e);
  } finally {
    showLoading(false);
  }
}

function uploadFiles(files) {
  const fd = new FormData();
  for (const f of files) fd.append("files", f);
  const names = Array.from(files).map((f) => f.name);
  lastSource = { type: "upload", name: names.length === 1 ? names[0] : `Upload · ${names.length} files` };
  postForm("/api/parse", fd);
}
function loadDemo() {
  lastSource = { type: "samples", name: "Quick demo" };
  postForm("/api/parse-samples", new FormData());
}
function loadBatch(id) {
  const fd = new FormData(); fd.append("name", id);
  lastSource = { type: "batch", name: id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) };
  postForm("/api/parse-batch", fd);
}

async function loadBatchCards() {
  try {
    const res = await fetch("/api/batches");
    const { batches } = await res.json();
    const grid = $("batchGrid");
    grid.innerHTML = "";
    batches.forEach((b) => {
      const card = document.createElement("div");
      card.className = "batch-card";
      card.onclick = () => loadBatch(b.id);
      card.innerHTML = `
        <h4>${b.name}</h4>
        <div class="meta"><span>${b.files} files</span><span>${b.lines.toLocaleString()} lines</span></div>
        <div class="langs">${b.languages.map((l) => `<span class="lg ${l}">${l}</span>`).join("")}</div>`;
      grid.appendChild(card);
    });
  } catch (e) { /* no batches */ }
}

// ---------------------------------------------------------------------------
// Graph rendering
// ---------------------------------------------------------------------------
function cyStyle() {
  return [
    { selector: "node", style: {
        "background-color": (n) => ROLE_COLOR[n.data("role")] || "#a855f7",
        "label": "data(label)", "color": "#cdd7e4", "font-size": 11, "font-weight": 500,
        "text-valign": "bottom", "text-margin-y": 6, "text-wrap": "ellipsis", "text-max-width": 130,
        "width": 24, "height": 24, "border-width": 2, "border-color": "#0b0e13",
        "shape": (n) => { const t = n.data("type");
          return t === "file" ? "round-rectangle" : t === "view" ? "diamond"
            : t === "chart" ? "hexagon" : t === "report" ? "tag"
            : t === "process" ? "barrel" : "ellipse"; } } },
    { selector: "node.hl", style: { "border-color": "#ec0000", "border-width": 3,
        "width": 30, "height": 30, "font-weight": 700, "color": "#fff" } },
    { selector: "edge", style: {
        "width": 2, "line-color": (e) => LANG_COLOR[e.data("language")] || "#8a97a8",
        "target-arrow-color": (e) => LANG_COLOR[e.data("language")] || "#8a97a8",
        "target-arrow-shape": "triangle", "curve-style": "bezier", "arrow-scale": 1,
        "line-style": (e) => e.data("confidence") === "low" ? "dashed" : "solid", "opacity": 0.8 } },
    { selector: "edge.hl", style: { "width": 3.5, "opacity": 1, "z-index": 99 } },
    { selector: "edge.ai-edge", style: {
        "line-color": "#f59e0b", "target-arrow-color": "#f59e0b",
        "target-arrow-shape": "triangle", "line-style": "solid",
        "width": 2.5, "opacity": 0.95, "z-index": 50 } },
    { selector: "node.ai-node", style: { "border-color": "#f59e0b", "border-width": 2.5 } },
    { selector: ".faded", style: { "opacity": 0.08, "text-opacity": 0.08 } },
    { selector: ".hidden", style: { "display": "none" } },
  ];
}

function render(data) {
  lastResult = data;
  if (cy) cy.destroy();
  cy = cytoscape({
    container: $("graph"), elements: data.elements, style: cyStyle(),
    layout: { name: "dagre", rankDir, nodeSep: 26, rankSep: 85, edgeSep: 10, padding: 36 },
    wheelSensitivity: 0.25, minZoom: 0.2, maxZoom: 2.5,
  });
  cy.on("tap", "node", (e) => selectNode(e.target));
  cy.on("tap", "edge", (e) => selectEdge(e.target));
  cy.on("tap", (e) => { if (e.target === cy) clearHighlight(); });

  applyLangFilter();
  renderSummary(data);
  renderDatasets(data);
  renderOperations(data);
  renderReview(data);
  switchView("summary");
  if (agentEnabled) runAgentReview();
}

// ---------------------------------------------------------------------------
// Summary tab
// ---------------------------------------------------------------------------
function renderSummary(data) {
  const s = data.stats || {};
  const c = confidenceStats(data);
  const cells = [
    ["datasets", "Datasets"], ["operations", "Transformations"],
    ["foundation", "Source datasets"], ["outputs", "Final outputs"],
    ["intermediate", "Intermediate"], ["files", "Code files"],
  ];
  const langs = s.by_language || {};
  const maxL = Math.max(1, ...Object.values(langs));
  const langBars = ["sql", "sas", "python"].filter((l) => langs[l]).map((l) => `
    <div class="bar-row"><span class="lab">${l.toUpperCase()}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${(langs[l] / maxL) * 100}%;background:${LANG_COLOR[l]}"></span></span>
      <span class="val">${langs[l]}</span></div>`).join("");

  $("paneSummary").innerHTML = `
    <div class="stat-grid">
      ${cells.map(([k, l]) => `<div class="stat"><div class="n">${s[k] ?? 0}</div><div class="l">${l}</div></div>`).join("")}
    </div>
    <div class="sec-title">Transformations by language</div>
    ${langBars || '<p class="muted empty">No transformations detected.</p>'}
    <div class="sec-title">Lineage confidence</div>
    <div class="bar-row"><span class="lab">Evidence</span>
      <span class="bar-track"><span class="bar-fill" style="width:${c.coverage}%;background:var(--sink)"></span></span>
      <span class="val">${c.coverage}%</span></div>
    <div class="bar-row"><span class="lab">Confidence</span>
      <span class="bar-track"><span class="bar-fill" style="width:${c.score}%;background:${c.score >= 75 ? 'var(--sink)' : c.score >= 50 ? 'var(--sas)' : 'var(--accent)'}"></span></span>
      <span class="val">${c.score}%</span></div>
    <div class="conf-break">
      <span><b style="color:var(--sink)">${c.high}</b> high</span>
      <span><b style="color:var(--sas)">${c.medium}</b> medium</span>
      <span><b style="color:var(--accent)">${c.low}</b> low</span>
    </div>
    <p class="muted empty" style="margin-top:10px"><b>Evidence</b> = share of transformations backed by a file, line and code snippet. <b>Confidence</b> is a weighted score of how reliably each mapping was resolved (SQL parses highest; SAS/Python macros and dynamic code score lower and are candidates for the AI review step).</p>`;
}
function confidenceStats(data) {
  const ops = data.operations || [];
  if (!ops.length) return { coverage: 100, score: 100, high: 0, medium: 0, low: 0 };
  const weight = { high: 1, medium: 0.7, low: 0.4 };
  let high = 0, medium = 0, low = 0, withEvidence = 0, weighted = 0;
  for (const o of ops) {
    const c = o.confidence || "medium";
    if (c === "high") high++; else if (c === "low") low++; else medium++;
    weighted += weight[c] ?? 0.7;
    if (o.snippet && o.file) withEvidence++;
  }
  return {
    coverage: Math.round((withEvidence / ops.length) * 100),
    score: Math.round((weighted / ops.length) * 100),
    high, medium, low,
  };
}

// ---------------------------------------------------------------------------
// Datasets tab
// ---------------------------------------------------------------------------
function renderDatasets(data) {
  const groups = [
    ["root", "Source", data.roots || []],
    ["mid", "Intermediate", data.intermediate || []],
    ["sink", "Output", data.sinks || []],
    ["runtime", "Runtime / dynamic", data.runtime || []],
  ];
  const ds = data.datasets || {};
  let html = "";
  for (const [role, label, ids] of groups) {
    html += `<div class="grouplabel"><span class="dot ${role}"></span>${label}<span class="cnt">${ids.length}</span></div>`;
    html += ids.map((id) => {
      const d = ds[id] || { name: id, type: "" };
      return `<div class="list-item" data-node="${id}">
        <span class="ico">${iconFor(d.type)}</span>
        <span class="nm" title="${d.name}">${d.name}</span>
        <span class="typ">${d.type}</span></div>`;
    }).join("");
  }
  const pane = $("paneDatasets");
  pane.innerHTML = html;
  pane.querySelectorAll(".list-item").forEach((el) =>
    el.onclick = () => focusNode(el.dataset.node));
}
function iconFor(t) {
  return t === "file" ? "◰" : t === "view" ? "◇"
    : t === "chart" ? "▨" : t === "report" ? "▤"
    : t === "process" ? "⚙" : "▦";
}

// ---------------------------------------------------------------------------
// Operations tab
// ---------------------------------------------------------------------------
function renderOperations(data) {
  const ops = data.operations || [];
  const pane = $("paneOperations");
  if (!ops.length) { pane.innerHTML = '<p class="muted empty">No transformations.</p>'; return; }
  pane.innerHTML = ops.map((o, i) => `
    <div class="op-item" data-op="${i}">
      <div class="op-head">
        <span class="tag ${o.language}">${o.language}</span>
        <span class="tag kind">${o.kind}</span>
      </div>
      <div class="op-flow">${(o.inputs || []).map((x) => esc(x)).join(", ") || "—"}
        <span class="arw">→</span><b>${esc(o.target)}</b></div>
      <div class="op-meta">${esc(o.file)}${o.line_start ? " : line " + o.line_start : ""}</div>
    </div>`).join("");
  pane.querySelectorAll(".op-item").forEach((el) =>
    el.onclick = () => selectEdgeByOp(ops[+el.dataset.op]));
}

// ---------------------------------------------------------------------------
// Review tab
// ---------------------------------------------------------------------------
function renderReview(data) {
  const warns = data.warnings || [];
  const badge = $("reviewBadge");
  if (warns.length) { badge.hidden = false; badge.textContent = warns.length; }
  else badge.hidden = true;
  const c = confidenceStats(data);
  const unresolved = c.low + c.medium;
  const integrityHtml = renderIntegrity(data.integrity);
  const warnHtml = warns.length
    ? warns.map((w) => `<div class="warn-item"><span>⚠</span><span>${esc(w)}</span></div>`).join("")
    : `<div class="ok-state"><div class="big">✓</div><p>No gaps or low-confidence mappings.<br/>All lineage is backed by code evidence.</p></div>`;
  const agentSection = `
    <div class="agent-block">
      <div class="agent-top">
        <div>
          <div class="sec-title" style="margin-top:0">AI lineage review <span class="auto-badge">automatic</span></div>
          <p class="muted empty" style="margin:2px 0 0">Every analysis runs a mandatory two-stage AI layer on top of the parser: a <b>discovery</b> agent resolves the ${unresolved} medium/low-confidence &amp; dynamic edge cases (SAS macros, SELECT INTO) the parser can't close statically, then a <b>validation</b> agent independently checks each proposal against the code evidence and knowledge base.</p>
        </div>
      </div>
      ${agentEnabled ? "" : `<div class="agent-hint">⚠ AI review is required but <code>GROQ_API_KEY</code> is not set on the server.</div>`}
      <div id="agentResult" class="agent-result"></div>
    </div>`;
  $("paneReview").innerHTML = integrityHtml + warnHtml + agentSection;
}

function renderIntegrity(ig) {
  if (!ig) return "";
  const st = ig.status || "review";
  const meta = {
    sound: { color: "var(--sink)", label: "Sound", ico: "✓" },
    review: { color: "var(--sas)", label: "Review advised", ico: "△" },
    attention: { color: "var(--accent)", label: "Needs attention", ico: "!" },
  }[st] || { color: "var(--muted)", label: st, ico: "•" };
  const sm = ig.summary || {};
  const checks = (ig.checks || []).map((ch) => {
    const sv = { error: "var(--accent)", warn: "var(--sas)", info: "var(--muted)" }[ch.severity] || "var(--muted)";
    const items = (ch.items || []).length
      ? `<ul class="ig-items">${ch.items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
    return `<div class="ig-check" style="border-color:${sv}">
      <div class="ig-check-head"><span class="ig-dot" style="background:${sv}"></span>
        <b>${esc(ch.label)}</b><span class="ig-count">${ch.count}</span></div>
      <div class="ig-detail">${esc(ch.detail || "")}</div>${items}</div>`;
  }).join("");
  return `<div class="integrity-block">
    <div class="ig-top">
      <div class="ig-score" style="border-color:${meta.color};color:${meta.color}">${ig.score}</div>
      <div>
        <div class="sec-title" style="margin:0">Lineage integrity
          <span class="ig-status" style="color:${meta.color}">${meta.ico} ${esc(meta.label)}</span></div>
        <p class="muted empty" style="margin:2px 0 0">A deterministic audit of the <b>whole</b> graph (not just AI proposals): ${sm.datasets ?? 0} datasets, ${sm.edges ?? 0} edges · ${sm.cycles ?? 0} cycles · ${sm.orphans ?? 0} orphans · ${sm.undefined ?? 0} undefined.</p>
      </div>
    </div>
    ${checks || `<div class="ok-state sm"><div class="big">✓</div><p>No structural issues — acyclic, fully connected, every dataset defined.</p></div>`}
  </div>`;
}

// ---------------------------------------------------------------------------
// Selection + details
// ---------------------------------------------------------------------------
function selectNode(node) {
  highlightNeighbourhood(node);
  const d = node.data();
  const ds = (lastResult.datasets || {})[d.id] || {};
  const up = node.incomers("node").map((n) => n.id());
  const down = node.outgoers("node").map((n) => n.id());
  const producing = (lastResult.operations || []).filter((o) => o.target === d.id);

  $("paneDetails").innerHTML = `
    <div class="d-head">
      <span class="bubble" style="background:${ROLE_COLOR[d.role]}">${iconFor(d.type)}</span>
      <div><h3>${esc(d.label)}</h3><span class="role">${d.role === "root" ? "Source" : d.role === "sink" ? "Output" : d.role === "runtime" ? "Runtime (dynamic)" : "Intermediate"} · ${d.type}</span></div>
    </div>
    <div class="d-actions">
      <button class="btn ghost sm" id="traceSrc">↞ Trace to source</button>
      <button class="btn ghost sm" id="traceImp">Trace impact ↠</button>
    </div>
    <div class="drow"><div class="k">Source file</div><div class="v">${esc(d.source_file || "—")}</div></div>
    <div class="drow"><div class="k">Upstream (${up.length})</div><div class="v chiplist">${chips(up)}</div></div>
    <div class="drow"><div class="k">Downstream (${down.length})</div><div class="v chiplist">${chips(down)}</div></div>
    ${producing.length ? `<div class="drow"><div class="k">Produced by</div>${producing.map(opEvidence).join("")}</div>` : ""}`;

  wireChips($("paneDetails"));
  $("traceSrc").onclick = () => tracePath(node, "in");
  $("traceImp").onclick = () => tracePath(node, "out");
  switchView("details");
}

function selectEdge(edge) {
  cy.elements().removeClass("hl faded");
  edge.addClass("hl"); edge.connectedNodes().addClass("hl");
  const d = edge.data();
  $("paneDetails").innerHTML = `
    <div class="d-head"><span class="bubble" style="background:${LANG_COLOR[d.language]}">${d.language[0].toUpperCase()}</span>
      <div><h3>Transformation</h3><span class="role">${d.language} · ${d.kind}</span></div></div>
    <div class="drow"><div class="k">Flow</div><div class="v">${esc(d.source)} <span class="arw">→</span> ${esc(d.target)}</div></div>
    <div class="drow"><div class="k">Confidence</div><div class="v">${d.confidence}</div></div>
    <div class="drow"><div class="k">Evidence</div><div class="v">${esc(d.file)}${d.line ? " : line " + d.line : ""}</div></div>
    <div class="drow"><div class="k">Code</div><pre class="code">${esc(d.snippet || "")}</pre></div>`;
  switchView("details");
}

function selectEdgeByOp(op) {
  if (!op.inputs || !op.inputs.length) return;
  const id = `e::${op.inputs[0]}::${op.target}`;
  const edge = cy.getElementById(id);
  if (edge && edge.nonempty()) { selectEdge(edge); fit(edge.connectedNodes()); }
}

function opEvidence(o) {
  return `<div class="op-item" style="margin-top:6px">
    <div class="op-head"><span class="tag ${o.language}">${o.language}</span><span class="tag kind">${o.kind}</span></div>
    <pre class="code">${esc(o.snippet || "")}</pre>
    <div class="op-meta">${esc(o.file)}${o.line_start ? " : line " + o.line_start : ""}</div></div>`;
}

function chips(ids) {
  if (!ids.length) return '<span class="muted">—</span>';
  return ids.map((x) => `<span class="minichip" data-node="${x}">${esc(x)}</span>`).join("");
}
function wireChips(root) {
  root.querySelectorAll(".minichip").forEach((el) =>
    el.onclick = () => focusNode(el.dataset.node));
}

// ---------------------------------------------------------------------------
// Highlighting / tracing
// ---------------------------------------------------------------------------
function highlightNeighbourhood(node) {
  cy.elements().removeClass("hl faded");
  const hood = node.closedNeighborhood();
  cy.elements().addClass("faded");
  hood.removeClass("faded").addClass("hl");
}
function tracePath(node, dir) {
  cy.elements().removeClass("hl faded");
  let coll = node;
  const walk = dir === "in"
    ? (n) => n.incomers()
    : (n) => n.outgoers();
  let frontier = node;
  const visited = cy.collection().union(node);
  // breadth-first accumulate full ancestry / descendants
  while (frontier.nonempty()) {
    const next = walk(frontier);
    const fresh = next.difference(visited);
    coll = coll.union(next);
    visited.merge(next);
    frontier = fresh.nodes();
  }
  cy.elements().addClass("faded");
  coll.removeClass("faded").addClass("hl");
  node.addClass("hl");
  fit(coll.nodes());
}
function clearHighlight() { if (cy) cy.elements().removeClass("hl faded"); }

function focusNode(id) {
  if (!cy) return;
  const node = cy.getElementById(id);
  if (node && node.nonempty()) {
    cy.animate({ center: { eles: node }, zoom: 1.3 }, { duration: 280 });
    selectNode(node);
  }
}
function fit(eles) { if (cy && eles && eles.nonempty()) cy.animate({ fit: { eles, padding: 60 } }, { duration: 280 }); }

// ---------------------------------------------------------------------------
// Language filter
// ---------------------------------------------------------------------------
function applyLangFilter() {
  if (!cy) return;
  cy.edges().forEach((e) => {
    const lang = e.data("language");
    e.toggleClass("hidden", lang && !activeLangs.has(lang));
  });
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
function runSearch(q) {
  if (!cy) return;
  q = q.trim().toLowerCase();
  cy.elements().removeClass("hl faded");
  if (!q) return;
  const match = cy.nodes().filter((n) =>
    n.id().toLowerCase().includes(q) || (n.data("label") || "").toLowerCase().includes(q));
  if (match.empty()) return;
  cy.elements().addClass("faded");
  match.removeClass("faded").addClass("hl");
  fit(match);
}

// ---------------------------------------------------------------------------
// Left-rail view switching (Lineage sub-views + History)
// ---------------------------------------------------------------------------
function switchView(name) {
  document.querySelectorAll(".rail-item").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
  const isHistory = name === "history";
  const panel = document.querySelector(".ws-panel");
  const graph = $("graph");
  const hist = $("wsHistory");
  const legend = $("wsLegend");
  if (panel) panel.hidden = isHistory;
  if (graph) graph.hidden = isHistory;
  if (hist) hist.hidden = !isHistory;
  if (legend) legend.hidden = isHistory;

  if (isHistory) {
    if (currentUser) loadHistory();
    else renderHistoryCTA();
    return;
  }

  document.querySelectorAll(".tabpane").forEach((p) => p.classList.toggle("active", p.dataset.pane === name));
  const title = $("panelTitle");
  if (title) title.textContent = LINEAGE_VIEWS[name] || "";
  // The Review view carries wide AI cards — give the panel more room.
  if (panel) {
    panel.classList.toggle("wide", name === "review");
    if (cy) setTimeout(() => cy.resize(), 210);
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
function download(name, content) {
  const blob = new Blob([content], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------
function esc(s) { return String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------
async function checkAuth() {
  try {
    const res = await fetch("/api/auth/me");
    const data = await res.json();
    currentUser = data.user;
    agentEnabled = !!data.agent;
  } catch (e) { currentUser = null; }
  updateAcctUI();
  if (currentUser) loadHistory(); else { $("historySection").hidden = true; }
}

function updateAcctUI() {
  const loggedIn = !!currentUser;
  const acctHtml = loggedIn
    ? `<span class="acct-email" title="${esc(currentUser.username)}">${esc(currentUser.username)}</span>
       <button class="btn ghost sm" data-signout>Sign out</button>`
    : `<button class="btn ghost sm" data-signin>Sign in</button>`;
  const home = $("acctArea");
  if (home) home.innerHTML = acctHtml;
  const rail = $("acctAreaWs");
  if (rail) {
    rail.innerHTML = loggedIn ? acctHtml
      : `<button class="btn ghost sm block" data-signin>Sign in to save</button>`;
  }
  document.querySelectorAll("[data-signout]").forEach((b) => b.onclick = signOut);
  document.querySelectorAll("[data-signin]").forEach((b) => b.onclick = () => openAuth("login"));
}

function openAuth(mode) {
  authMode = mode;
  $("authError").hidden = true;
  $("authForm").reset();
  applyAuthMode();
  $("authModal").hidden = false;
  $("authUsername").focus();
}
function closeAuth() { $("authModal").hidden = true; }
function applyAuthMode() {
  const login = authMode === "login";
  $("authTitle").textContent = login ? "Sign in to Lineis" : "Create your account";
  $("authSub").textContent = login
    ? "Save your analyses and revisit them any time."
    : "Your analyses are stored locally on this machine.";
  $("authSubmit").textContent = login ? "Sign in" : "Create account";
  $("authSwitchText").textContent = login ? "New here?" : "Already have an account?";
  $("authToggle").textContent = login ? "Create an account" : "Sign in";
  $("authPassword").setAttribute("autocomplete", login ? "current-password" : "new-password");
}

async function submitAuth(e) {
  e.preventDefault();
  const username = $("authUsername").value.trim();
  const password = $("authPassword").value;
  const url = authMode === "login" ? "/api/auth/login" : "/api/auth/register";
  try {
    const res = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      const err = $("authError");
      err.textContent = data.error || "Something went wrong."; err.hidden = false;
      return;
    }
    closeAuth();
    await checkAuth();
  } catch (e) {
    const err = $("authError");
    err.textContent = "Network error. Is the server running?"; err.hidden = false;
  }
}

async function signOut() {
  await fetch("/api/auth/logout", { method: "POST" });
  currentUser = null;
  updateAcctUI();
  $("historySection").hidden = true;
  const wsHist = $("wsHistory");
  if (wsHist && !wsHist.hidden) renderHistoryCTA();
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------
function goHomeHistory() {
  if (!currentUser) { openAuth("login"); return; }
  const sec = $("historySection");
  if (sec) { sec.hidden = false; sec.scrollIntoView({ behavior: "smooth", block: "start" }); }
  loadHistory();
}

async function loadHistory() {
  if (!currentUser) return;
  try {
    const res = await fetch("/api/history");
    if (!res.ok) return;
    const { analyses } = await res.json();
    renderHistory(analyses);
  } catch (e) { /* ignore */ }
}

function renderHistory(analyses) {
  const sec = $("historySection");
  if (sec) sec.hidden = false;
  fillHistory($("historyList"), $("historyCount"), analyses);
  fillHistory($("historyListWs"), $("historyCountWs"), analyses);
}

function renderHistoryCTA() {
  const list = $("historyListWs");
  const count = $("historyCountWs");
  if (count) count.textContent = "";
  if (!list) return;
  list.innerHTML = `<div class="hist-cta">
    <p class="muted">Sign in to save analyses and revisit them any time.</p>
    <button class="btn primary sm" data-signin>Sign in</button></div>`;
  list.querySelectorAll("[data-signin]").forEach((b) => b.onclick = () => openAuth("login"));
}

function fillHistory(list, countEl, analyses) {
  if (!list) return;
  if (countEl) countEl.textContent = analyses.length ? `${analyses.length} saved` : "";
  if (!analyses.length) {
    list.innerHTML = `<p class="muted empty">No saved analyses yet. Parse some code and hit ★ Save.</p>`;
    return;
  }
  list.innerHTML = analyses.map((a) => {
    const s = a.stats || {};
    const when = new Date(a.created_at).toLocaleString();
    return `<div class="hist-item" data-id="${a.id}">
      <div class="hist-main">
        <div class="hist-name">${esc(a.name)}</div>
        <div class="hist-meta">${esc(a.source_type)} · ${s.datasets ?? 0} datasets · ${s.operations ?? 0} transforms · ${when}</div>
      </div>
      <button class="hist-del" data-del="${a.id}" title="Delete">🗑</button>
    </div>`;
  }).join("");
  list.querySelectorAll(".hist-item").forEach((el) => {
    el.querySelector(".hist-main").onclick = () => openSaved(el.dataset.id);
  });
  list.querySelectorAll(".hist-del").forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); deleteSaved(b.dataset.del); };
  });
}

async function openSaved(id) {
  showLoading(true);
  try {
    const res = await fetch(`/api/history/${id}`);
    if (!res.ok) throw new Error("not found");
    const data = await res.json();
    showWorkspace();
    render(data);
  } catch (e) { alert("Could not load analysis."); }
  finally { showLoading(false); }
}

async function deleteSaved(id) {
  if (!confirm("Delete this saved analysis?")) return;
  await fetch(`/api/history/${id}`, { method: "DELETE" });
  loadHistory();
}

async function saveCurrent() {
  if (!lastResult) return;
  if (!currentUser) { openAuth("login"); return; }
  const name = prompt("Name this analysis:", lastSource.name || "Analysis");
  if (name === null) return;
  const btn = $("saveBtn");
  const prev = btn.textContent; btn.textContent = "Saving…"; btn.disabled = true;
  try {
    const res = await fetch("/api/history", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() || lastSource.name, source_type: lastSource.type, result: lastResult }),
    });
    if (!res.ok) throw new Error("save failed");
    btn.textContent = "✓ Saved";
    loadHistory();
    setTimeout(() => { btn.textContent = prev; btn.disabled = false; }, 1400);
  } catch (e) {
    btn.textContent = prev; btn.disabled = false;
    alert("Could not save analysis.");
  }
}

// ---------------------------------------------------------------------------
// AI review agent
// ---------------------------------------------------------------------------
async function runAgentReview() {
  if (!lastResult) return;
  const host = $("agentResult");
  if (host) host.innerHTML = `<div class="agent-loading"><div class="spinner sm"></div> Stage 1 · discovery agent resolving medium/low-confidence &amp; edge cases…</div>`;
  try {
    const res = await fetch("/api/agent/review", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ result: lastResult }),
    });
    const data = await res.json();
    renderAgentResult(data);
  } catch (e) {
    if (host) host.innerHTML = `<div class="warn-item"><span>⚠</span><span>AI review failed to run.</span></div>`;
  }
}

function renderAgentResult(data) {
  const host = $("agentResult");
  if (!host) return;
  if (data.error) {
    host.innerHTML = `<div class="warn-item"><span>⚠</span><span>${esc(data.error)}</span></div>`;
    return;
  }
  const proposals = data.proposals || [];
  if (!proposals.length) {
    lastProposals = [];
    host.innerHTML = `<p class="muted empty">${esc(data.message || "No proposals returned.")}</p>`;
    return;
  }
  lastProposals = proposals;
  const vmap = {};
  (data.validations || []).forEach((v) => { vmap[v.op_id] = v; });
  const globalV = vmap["*"];

  const ku = data.context_used || {};
  const kbline = `KB grounding: ${ku.rules || 0} rules · ${ku.sas_idioms || 0} SAS idioms` +
    (ku.glossary && ku.glossary.length ? ` · glossary [${ku.glossary.map(esc).join(", ")}]` : "");
  let html = `<div class="agent-note">
    <b>Stage 1 Discovery</b> → <b>Stage 2 Validation</b> · reviewed ${data.reviewed ?? proposals.length} op(s) with ${esc(data.model || "the model")}.<br>
    ${esc(kbline)}<br>Accept a proposal to add it to the lineage graph as an AI-inferred edge, or reject it.</div>`;
  if (globalV) {
    html += `<div class="warn-item"><span>⚠</span><span>Validation stage: ${esc((globalV.issues || []).join("; ") || globalV.comment || "unavailable")}</span></div>`;
  }

  html += proposals.map((s, i) => {
    const conf = Math.round((s.confidence ?? 0) * 100);
    const cc = conf >= 75 ? "var(--sink)" : conf >= 50 ? "var(--sas)" : "var(--accent)";
    const asum = (s.assumptions || []).map((a) => `<li>${esc(a)}</li>`).join("");
    const cols = (s.columns || []).length ? `<div class="agent-cols">columns: ${(s.columns || []).map(esc).join(", ")}</div>` : "";
    const v = vmap[s.op_id];
    let verdict = "";
    if (v) {
      const vc = { confirmed: "var(--sink)", needs_review: "var(--sas)", rejected: "var(--accent)" }[v.verdict] || "var(--muted)";
      const vlabel = { confirmed: "✓ Confirmed", needs_review: "△ Needs review", rejected: "✗ Rejected" }[v.verdict] || v.verdict;
      const issues = (v.issues || []).map((x) => `<li>${esc(x)}</li>`).join("");
      verdict = `<div class="agent-verdict" style="border-color:${vc}">
        <span class="vbadge" style="color:${vc}">${esc(vlabel)}</span>
        ${v.confidence != null ? `<span class="muted">validator ${Math.round(v.confidence * 100)}%</span>` : ""}
        ${v.comment ? `<div class="agent-rat">${esc(v.comment)}</div>` : ""}
        ${issues ? `<div class="agent-asum"><span>Issues</span><ul>${issues}</ul></div>` : ""}
      </div>`;
    }
    return `<div class="agent-card" data-idx="${i}">
      <div class="agent-head">
        <span class="agent-op">${esc(s.op_id || "op")}</span>
        <span class="agent-conf" style="color:${cc}">${conf}% proposed</span>
      </div>
      <div class="agent-flow">${(s.proposed_inputs || []).map(esc).join(", ") || "—"} <span class="arw">→</span> <b>${esc(s.proposed_target || "?")}</b></div>
      ${cols}
      ${s.rationale ? `<div class="agent-rat">${esc(s.rationale)}</div>` : ""}
      ${asum ? `<div class="agent-asum"><span>Assumptions</span><ul>${asum}</ul></div>` : ""}
      ${verdict}
      <div class="agent-actions">
        <button class="btn sm accept" data-accept="${i}">✓ Accept into lineage</button>
        <button class="btn sm reject" data-reject="${i}">✗ Reject</button>
      </div>
    </div>`;
  }).join("");
  host.innerHTML = html;
  host.querySelectorAll("[data-accept]").forEach((b) => b.onclick = () => acceptProposal(+b.dataset.accept));
  host.querySelectorAll("[data-reject]").forEach((b) => b.onclick = () => rejectProposal(+b.dataset.reject));
}

// ---------------------------------------------------------------------------
// Accept / reject agent proposals — accepted ones become AI-inferred edges.
// ---------------------------------------------------------------------------
function resolveNodeId(name) {
  if (!cy || name == null) return null;
  const exact = cy.getElementById(String(name));
  if (exact && exact.nonempty()) return String(name);
  const lower = String(name).toLowerCase();
  const match = cy.nodes().filter((x) =>
    String(x.data("label")).toLowerCase() === lower || String(x.id()).toLowerCase() === lower);
  return match.nonempty() ? match[0].id() : null;
}

function ensureGraphNode(name) {
  let id = resolveNodeId(name);
  if (id) return id;
  id = "ai::" + name;
  if (cy.getElementById(id).empty()) {
    const data = { id, label: String(name), type: "inferred", role: "mid", source_file: "AI-inferred" };
    cy.add({ group: "nodes", data, classes: "ai-node" });
    if (lastResult && lastResult.elements) lastResult.elements.push({ data, classes: "ai-node" });
  }
  return id;
}

function addAiEdge(sId, tId, p) {
  if (sId === tId) return;
  // If the parser already drew an edge between these two nodes, confirm it in
  // place (solid amber) instead of stacking a second parallel dashed line.
  const existing = cy.edges().filter((e) =>
    e.data("source") === sId && e.data("target") === tId && !e.hasClass("ai-edge"));
  if (existing.nonempty()) {
    existing.addClass("ai-edge").data("aiConfirmed", true);
    return;
  }
  const id = "ai::" + sId + "::" + tId;
  if (cy.getElementById(id).nonempty()) return;
  const data = {
    id, source: sId, target: tId, language: "ai", confidence: "ai",
    kind: "ai-inferred", file: p.op_id || "", line: 0, snippet: p.rationale || "",
  };
  cy.add({ group: "edges", data, classes: "ai-edge" });
  if (lastResult && lastResult.elements) lastResult.elements.push({ data, classes: "ai-edge" });
}

function acceptProposal(idx) {
  const p = lastProposals[idx];
  if (!p || !cy) return;
  const tId = ensureGraphNode(p.proposed_target || `ai-target-${idx}`);
  (p.proposed_inputs || []).forEach((inp) => addAiEdge(ensureGraphNode(inp), tId, p));
  cy.layout({ name: "dagre", rankDir, nodeSep: 26, rankSep: 85, edgeSep: 10, padding: 36 }).run();
  markProposal(idx, "accepted");
}

function rejectProposal(idx) { markProposal(idx, "rejected"); }

function markProposal(idx, state) {
  const card = document.querySelector(`.agent-card[data-idx="${idx}"]`);
  if (!card) return;
  card.classList.remove("accepted", "rejected");
  card.classList.add(state);
  const actions = card.querySelector(".agent-actions");
  if (actions) {
    actions.innerHTML = state === "accepted"
      ? `<span class="agent-status ok">✓ Accepted · added to lineage graph</span>
         <button class="btn sm reject" data-reject="${idx}">Undo</button>`
      : `<span class="agent-status no">✗ Rejected</span>
         <button class="btn sm accept" data-accept="${idx}">Accept instead</button>`;
    actions.querySelectorAll("[data-accept]").forEach((b) => b.onclick = () => acceptProposal(+b.dataset.accept));
    actions.querySelectorAll("[data-reject]").forEach((b) => b.onclick = () => undoProposal(+b.dataset.reject));
  }
}

function undoProposal(idx) {
  const p = lastProposals[idx];
  if (p && cy) {
    const tId = resolveNodeId(p.proposed_target);
    (p.proposed_inputs || []).forEach((inp) => {
      const sId = resolveNodeId(inp);
      if (sId && tId) {
        const eid = "ai::" + sId + "::" + tId;
        const e = cy.getElementById(eid);
        if (e.nonempty()) e.remove();
        if (lastResult && lastResult.elements) {
          lastResult.elements = lastResult.elements.filter((el) => !(el.data && el.data.id === eid));
        }
        // revert any parser edge we confirmed in place
        cy.edges().filter((x) => x.data("source") === sId && x.data("target") === tId && x.data("aiConfirmed"))
          .removeClass("ai-edge").removeData("aiConfirmed");
      }
    });
    cy.nodes(".ai-node").forEach((n) => { if (n.connectedEdges().empty()) {
      const nid = n.id();
      n.remove();
      if (lastResult && lastResult.elements) lastResult.elements = lastResult.elements.filter((el) => !(el.data && el.data.id === nid));
    }});
  }
  const card = document.querySelector(`.agent-card[data-idx="${idx}"]`);
  if (card) {
    card.classList.remove("accepted", "rejected");
    const actions = card.querySelector(".agent-actions");
    if (actions) {
      actions.innerHTML = `<button class="btn sm accept" data-accept="${idx}">✓ Accept into lineage</button>
        <button class="btn sm reject" data-reject="${idx}">✗ Reject</button>`;
      actions.querySelectorAll("[data-accept]").forEach((b) => b.onclick = () => acceptProposal(+b.dataset.accept));
      actions.querySelectorAll("[data-reject]").forEach((b) => b.onclick = () => rejectProposal(+b.dataset.reject));
    }
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function initEvents() {
  const dz = $("dropzone");
  dz.onclick = (e) => { if (e.target.id !== "browseBtn") $("fileInput").click(); };
  $("browseBtn").onclick = (e) => { e.stopPropagation(); $("fileInput").click(); };
  $("fileInput").onchange = (e) => { if (e.target.files.length) uploadFiles(e.target.files); };
  ["dragover", "dragenter"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", (e) => { if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files); });

  $("demoBtn") && ($("demoBtn").onclick = loadDemo);
  $("newBtn").onclick = showHome;
  $("homeHistoryBtn") && ($("homeHistoryBtn").onclick = goHomeHistory);

  // Brand (logo + wordmark) returns to home / new analysis.
  const brandWs = $("brandWs");
  if (brandWs) {
    brandWs.onclick = showHome;
    brandWs.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showHome(); } };
  }
  const brandHome = $("brandHome");
  if (brandHome) {
    brandHome.onclick = showHome;
    brandHome.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showHome(); } };
  }

  document.querySelectorAll(".rail-item").forEach((t) => t.onclick = () => switchView(t.dataset.view));
  document.querySelectorAll(".chip-toggle").forEach((c) => c.onclick = () => {
    const lang = c.dataset.lang;
    if (activeLangs.has(lang)) activeLangs.delete(lang); else activeLangs.add(lang);
    c.classList.toggle("active");
    applyLangFilter();
  });

  $("search").oninput = (e) => runSearch(e.target.value);
  $("layoutBtn").onclick = () => {
    rankDir = rankDir === "LR" ? "TB" : "LR";
    if (cy) cy.layout({ name: "dagre", rankDir, nodeSep: 26, rankSep: 85, padding: 36 }).run();
  };
  $("fitBtn").onclick = () => cy && cy.animate({ fit: { padding: 40 } }, { duration: 250 });
  $("resetHl").onclick = clearHighlight;
  $("exportJson").onclick = () => lastResult && download("lineage.json", JSON.stringify(lastResult, null, 2));
  $("exportOl").onclick = () => lastResult && download("openlineage.json", JSON.stringify(lastResult.openlineage, null, 2));
  $("saveBtn").onclick = saveCurrent;

  // Auth (sign-in / sign-out buttons are wired in updateAcctUI)
  $("authClose").onclick = closeAuth;
  $("authToggle").onclick = () => { authMode = authMode === "login" ? "register" : "login"; $("authError").hidden = true; applyAuthMode(); };
  $("authForm").onsubmit = submitAuth;
  $("authModal").addEventListener("click", (e) => { if (e.target.id === "authModal") closeAuth(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("authModal").hidden) closeAuth(); });
}

initEvents();
updateAcctUI();
loadBatchCards();
checkAuth();
