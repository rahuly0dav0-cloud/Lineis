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

const LANG_COLOR = { sql: "#5a93ff", sas: "#f6ad3c", python: "#2fd196", "": "#8e9aab" };
const ROLE_COLOR = { root: "#5a93ff", sink: "#2fd196", mid: "#b280ff", runtime: "#64748b" };
// Dark card fills per role — same visual language as the field-flow chart.
const NODE_FILL = { root: "#101a2b", sink: "#0e2018", mid: "#191333", runtime: "#1a1f27" };
const cardW = (label) => {
  const longest = String(label || "").split("\n").reduce((m, l) => Math.max(m, l.length), 0);
  return Math.max(94, Math.min(190, longest * 7 + 26));
};
const LINEAGE_VIEWS = { summary: "Summary", datasets: "Datasets", operations: "Operations", details: "Inspect", review: "Review" };
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Screen switching
// ---------------------------------------------------------------------------
function showWorkspace() { $("home").hidden = true; $("workspace").hidden = false; }
function showHome() {
  $("workspace").hidden = true; $("home").hidden = false;
  closeColGraph();
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
        "shape": "round-rectangle",
        "background-color": (n) => NODE_FILL[n.data("role")] || "#191333",
        "border-width": 2, "border-color": (n) => ROLE_COLOR[n.data("role")] || "#b280ff",
        "label": "data(label)", "color": "#e8edf5", "font-size": 11, "font-weight": 600,
        "text-valign": "center", "text-halign": "center",
        "text-wrap": "wrap", "text-max-width": 150,
        "width": (n) => cardW(n.data("label")), "height": 40, "padding": 6 } },
    { selector: "node.hl", style: { "border-color": "#ec0000", "border-width": 2.5, "color": "#fff" } },
    // Column-trace mode: a participating card shows the field name under the
    // dataset name; the focused field's card is filled red.
    { selector: "node.colmode", style: {
        "label": "data(colBadge)", "text-max-width": 168, "font-size": 10.5,
        "width": (n) => cardW(n.data("colBadge")), "height": 50 } },
    { selector: "node.colfocus", style: {
        "border-color": "#ec0000", "border-width": 3, "background-color": "#2a1113", "color": "#fff" } },
    { selector: "edge", style: {
        "width": 2, "line-color": (e) => LANG_COLOR[e.data("language")] || "#8a97a8",
        "target-arrow-color": (e) => LANG_COLOR[e.data("language")] || "#8a97a8",
        "target-arrow-shape": "triangle", "curve-style": "bezier", "arrow-scale": 1,
        "line-style": (e) => e.data("confidence") === "low" ? "dashed" : "solid", "opacity": 0.8 } },
    { selector: "edge.hl", style: { "width": 3.5, "opacity": 1, "z-index": 99 } },
    { selector: "edge.ai-edge", style: {
        "line-color": "#f6ad3c", "target-arrow-color": "#f6ad3c",
        "target-arrow-shape": "triangle", "line-style": "solid",
        "width": 2.5, "opacity": 0.95, "z-index": 50 } },
    { selector: "node.ai-node", style: { "border-color": "#f6ad3c", "border-width": 2.5 } },
    { selector: ".faded", style: { "opacity": 0.1, "text-opacity": 0.1 } },
    { selector: ".hidden", style: { "display": "none" } },
  ];
}

// Shared dagre layout — wider gaps than the old dot nodes need, since the
// datasets now render as full cards.
function dagreLayout() {
  return { name: "dagre", rankDir, nodeSep: 34, rankSep: 110, edgeSep: 12, padding: 40 };
}

function render(data) {
  lastResult = data;
  closeColGraph();
  if (cy) cy.destroy();
  cy = cytoscape({
    container: $("graph"), elements: data.elements, style: cyStyle(),
    layout: dagreLayout(),
    wheelSensitivity: 0.25, minZoom: 0.2, maxZoom: 2.5,
  });
  cy.on("tap", "node", (e) => {
    const id = e.target.id();
    const now = Date.now();
    if (lastTap.id === id && now - lastTap.t < 320) {   // double-tap centres on it
      cy.animate({ center: { eles: e.target }, zoom: 1.3 }, { duration: 260 });
    }
    lastTap = { id, t: now };
    hideGraphHint(false);
    selectNode(e.target);
  });
  cy.on("tap", "edge", (e) => selectEdge(e.target));
  cy.on("tap", (e) => { if (e.target === cy) clearHighlight(); });

  applyLangFilter();
  renderSummary(data);
  renderDatasets(data);
  renderOperations(data);
  renderReview(data);
  switchView("summary");
  showGraphHint();
  if (agentEnabled) runAgentReview();
}

// A one-time coachmark over the graph so the key actions (trace to source /
// impact) are discoverable before a node is ever clicked.
let lastTap = { id: null, t: 0 };
function showGraphHint() {
  const h = $("graphHint");
  if (!h) return;
  if (localStorage.getItem("lineis_hint_dismissed") === "1") { h.hidden = true; return; }
  h.hidden = false;
}
function hideGraphHint(persist) {
  const h = $("graphHint");
  if (h) h.hidden = true;
  if (persist) localStorage.setItem("lineis_hint_dismissed", "1");
}

// ---------------------------------------------------------------------------
// Summary tab
// ---------------------------------------------------------------------------
function renderSummary(data) {
  const s = data.stats || {};
  const c = confidenceStats(data);
  const cells = [
    ["datasets", "Datasets", "datasets", ""],
    ["operations", "Transformations", "operations", ""],
    ["foundation", "Source datasets", "datasets", "root"],
    ["outputs", "Final outputs", "datasets", "sink"],
    ["intermediate", "Intermediate", "datasets", "mid"],
    ["files", "Code files", "operations", ""],
  ];
  const langs = s.by_language || {};
  const maxL = Math.max(1, ...Object.values(langs));
  const langBars = ["sql", "sas", "python"].filter((l) => langs[l]).map((l) => `
    <div class="bar-row"><span class="lab">${l.toUpperCase()}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${(langs[l] / maxL) * 100}%;background:${LANG_COLOR[l]}"></span></span>
      <span class="val">${langs[l]}</span></div>`).join("");

  $("paneSummary").innerHTML = `
    <div class="stat-grid">
      ${cells.map(([k, l, view, group]) => `<button class="stat link" data-goto="${view}"${group ? ` data-group="${group}"` : ""} title="View ${l.toLowerCase()}">
        <div class="n">${s[k] ?? 0}</div><div class="l">${l}</div>
        <span class="stat-go" aria-hidden="true">↗</span></button>`).join("")}
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
  $("paneSummary").querySelectorAll(".stat.link").forEach((el) => {
    el.onclick = () => gotoView(el.dataset.goto, el.dataset.group);
  });
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
    html += `<div class="grouplabel" data-role="${role}"><span class="dot ${role}"></span>${label}<span class="cnt">${ids.length}</span></div>`;
    html += ids.map((id) => {
      const d = ds[id] || { name: id, type: "" };
      const nc = (d.columns || []).length;
      return `<div class="list-item" data-node="${id}">
        <span class="ico">${iconFor(d.type)}</span>
        <span class="nm" title="${d.name}">${d.name}</span>
        ${nc ? `<span class="col-badge" title="${nc} column${nc > 1 ? "s" : ""} found in code">${nc}&nbsp;col</span>` : ""}
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
  closeColGraph();
  clearColMode();
  highlightNeighbourhood(node);
  const d = node.data();
  const ds = (lastResult.datasets || {})[d.id] || {};
  const up = node.incomers("node").map((n) => n.id());
  const down = node.outgoers("node").map((n) => n.id());
  const producing = (lastResult.operations || []).filter((o) => o.target === d.id);
  const cols = ds.columns || [];
  const declared = cols.filter((c) => c.source === "declared").length;
  const schemaHtml = cols.length ? `
    <div class="drow">
      <div class="k">Schema · ${cols.length} column${cols.length > 1 ? "s" : ""} <span class="k-sub">${declared ? "declared in code" : "derived from SELECT"} · click a field to trace it</span></div>
      <div class="schema">
        ${cols.map((c) => `<div class="col-row clickable" data-col="${esc(c.name)}" title="Trace ${esc(c.name)} to source &amp; impact">
          <span class="col-name">${esc(c.name)}</span>
          ${c.dtype ? `<span class="col-type">${esc(c.dtype)}</span>` : ""}
          <span class="col-src ${c.source}" title="${c.source === "declared" ? "Declared in a CREATE TABLE statement" : "Derived from a SELECT projection"}">${c.source}</span>
          <span class="col-trace" aria-hidden="true">⤳</span>
        </div>`).join("")}
      </div>
    </div>` : `
    <div class="drow">
      <div class="k">Schema</div>
      <div class="schema-empty">No column-level schema was found in the code for this dataset${d.type === "file" ? " — it is read as a raw file without an explicit column list" : ""}.</div>
    </div>`;

  $("paneDetails").innerHTML = `
    <div class="d-head">
      <span class="bubble" style="background:${ROLE_COLOR[d.role]}">${iconFor(d.type)}</span>
      <div><h3>${esc(d.label)}</h3><span class="role">${d.role === "root" ? "Source" : d.role === "sink" ? "Output" : d.role === "runtime" ? "Runtime (dynamic)" : "Intermediate"} · ${d.type}</span></div>
    </div>
    <div class="d-actions">
      <button class="btn trace-btn src" id="traceSrc">
        <span class="tb-ico">↞</span>
        <span class="tb-txt"><b>Trace to source</b><small>Where this comes from</small></span>
      </button>
      <button class="btn trace-btn imp" id="traceImp">
        <span class="tb-ico">↠</span>
        <span class="tb-txt"><b>Trace impact</b><small>What depends on this</small></span>
      </button>
    </div>
    ${schemaHtml}
    <div class="drow"><div class="k">Source file</div><div class="v">${esc(d.source_file || "—")}</div></div>
    <div class="drow"><div class="k">Upstream (${up.length})</div><div class="v chiplist">${chips(up)}</div></div>
    <div class="drow"><div class="k">Downstream (${down.length})</div><div class="v chiplist">${chips(down)}</div></div>
    ${producing.length ? `<div class="drow"><div class="k">Produced by</div>${producing.map(opEvidence).join("")}</div>` : ""}`;

  wireChips($("paneDetails"));
  $("paneDetails").querySelectorAll(".col-row[data-col]").forEach((el) =>
    el.onclick = () => selectColumn(d.id, el.dataset.col));
  $("traceSrc").onclick = () => tracePath(node, "in");
  $("traceImp").onclick = () => tracePath(node, "out");
  switchView("details");
}

function selectEdge(edge) {
  closeColGraph();
  clearColMode();
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
// Column-level lineage (field trace to source / impact)
// Built from each operation's column_map ({target_column, source_columns}).
// Only SQL ops expose field-level provenance, so a trace honestly stops at the
// first SAS/Python hop rather than guessing.
// ---------------------------------------------------------------------------
function dsLabel(id) { return ((lastResult.datasets || {})[id] || {}).name || id; }

function producerOps(dsId) {
  return (lastResult.operations || []).filter((o) => o.target === dsId);
}
function colParents(dsId, col) {
  const lc = (col || "").toLowerCase();
  const out = [];
  for (const o of (lastResult.operations || [])) {
    if (o.target !== dsId) continue;
    for (const ce of (o.column_map || [])) {
      if ((ce.target_column || "").toLowerCase() !== lc) continue;
      for (const sc of (ce.source_columns || [])) {
        const i = sc.lastIndexOf(".");
        if (i < 0) continue;
        out.push({ dsId: sc.slice(0, i), col: sc.slice(i + 1) });
      }
    }
  }
  return dedupeCols(out);
}
function colChildren(dsId, col) {
  const needle = (dsId + "." + col).toLowerCase();
  const out = [];
  for (const o of (lastResult.operations || [])) {
    for (const ce of (o.column_map || [])) {
      if ((ce.source_columns || []).some((s) => s.toLowerCase() === needle))
        out.push({ dsId: o.target, col: ce.target_column });
    }
  }
  return dedupeCols(out);
}
function dedupeCols(arr) {
  const seen = new Set(); const out = [];
  for (const x of arr) {
    const k = (x.dsId + "." + x.col).toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(x); }
  }
  return out;
}
function traceColUp(dsId, col) {
  const rows = []; const seen = new Set();
  (function walk(id, c, depth) {
    const key = (id + "." + c).toLowerCase();
    const parents = colParents(id, c);
    const kind = parents.length ? "node" : (producerOps(id).length ? "opaque" : "origin");
    const cycle = seen.has(key);
    rows.push({ dsId: id, col: c, depth, kind, cycle });
    if (cycle || depth > 30) return;
    seen.add(key);
    for (const p of parents) walk(p.dsId, p.col, depth + 1);
  })(dsId, col, 0);
  return rows;
}
function traceColDown(dsId, col) {
  const rows = []; const seen = new Set();
  (function walk(id, c, depth) {
    const key = (id + "." + c).toLowerCase();
    const children = colChildren(id, c);
    const cycle = seen.has(key);
    rows.push({ dsId: id, col: c, depth, leaf: !children.length, cycle });
    if (cycle || depth > 30) return;
    seen.add(key);
    for (const ch of children) walk(ch.dsId, ch.col, depth + 1);
  })(dsId, col, 0);
  return rows;
}
function opaqueLang(dsId) {
  const m = { sql: "SQL", sas: "SAS", python: "Python" };
  const langs = [...new Set(producerOps(dsId).map((o) => o.language))].map((l) => m[l] || l);
  return langs.join(" / ") || "upstream code";
}
function colNodeRow(r, dir, isFocus) {
  let badge = "";
  if (r.cycle) badge = `<span class="ct-badge cycle">cycle</span>`;
  else if (dir === "up" && r.kind === "origin") badge = `<span class="ct-badge origin">source field</span>`;
  else if (dir === "up" && r.kind === "opaque") badge = `<span class="ct-badge opaque">trace ends · ${esc(opaqueLang(r.dsId))}</span>`;
  const arm = r.depth > 0 ? `<span class="ct-arm">↳</span>` : "";
  return `<div class="ct-row" style="--d:${r.depth}">
    ${arm}
    <button class="ct-node${isFocus ? " focus" : ""}" data-ds="${esc(r.dsId)}" data-col="${esc(r.col)}">
      <span class="ct-ds">${esc(dsLabel(r.dsId))}</span><span class="ct-sep">.</span><span class="ct-col">${esc(r.col)}</span>
    </button>${badge}</div>`;
}
function renderColTree(rows, dir) {
  if (rows.length <= 1) {
    const only = rows[0] || {};
    if (dir === "up") {
      return `<div class="ct-note">${only.kind === "opaque"
        ? `Upstream of this field is built by ${esc(opaqueLang(only.dsId))} code, which doesn't expose field-level lineage — the column trace stops here.`
        : "This is an original field — it is not derived from any upstream column."}</div>`;
    }
    return `<div class="ct-note">No downstream field consumes this column (at field level).</div>`;
  }
  return `<div class="coltree">${rows.map((r, i) => colNodeRow(r, dir, i === 0)).join("")}</div>`;
}
function centerNode(id) {
  if (!cy) return;
  const n = cy.getElementById(id);
  if (n && n.nonempty()) {
    highlightNeighbourhood(n);
    cy.animate({ center: { eles: n }, zoom: 1.2 }, { duration: 260 });
  }
}

// ---------------------------------------------------------------------------
// Field-level lineage FLOW — a dedicated Cytoscape chart that renders a single
// column's provenance + impact as a left-to-right graph (sources → selected
// field → downstream), so the flow is readable instead of being buried in the
// table graph. It replaces the table canvas while a column is being inspected.
// ---------------------------------------------------------------------------
let colCy = null;
let colFocus = { dsId: null, col: null };
const COL_ROLE = {
  focus:  { bg: "#2a1113", border: "#ec0000" },
  origin: { bg: "#0f2619", border: "#2fd196" },
  opaque: { bg: "#241d10", border: "#f6ad3c" },
  up:     { bg: "#111a28", border: "#5a93ff" },
  down:   { bg: "#0f2019", border: "#2fd196" },
};
const colFieldId = (dsId, col) => dsId + "::@@::" + col;

function buildColElements(dsId, colName) {
  const nodes = new Map();
  const edges = new Map();
  const focusId = colFieldId(dsId, colName);
  const ROLE_PRI = { up: 0, down: 0, opaque: 2, origin: 2, focus: 3 };
  const addNode = (d, c, role) => {
    const id = colFieldId(d, c);
    const ex = nodes.get(id);
    if (!ex) {
      const ds = dsLabel(d);
      const w = Math.max(96, Math.min(234, Math.max(c.length, ds.length + 3) * 7 + 22));
      nodes.set(id, { id, dsId: d, col: c, role, w });
    } else if ((ROLE_PRI[role] || 0) > (ROLE_PRI[ex.role] || 0)) {
      ex.role = role;
    }
  };
  const addEdge = (sid, tid, side) => {
    const k = sid + ">" + tid;
    if (!edges.has(k)) edges.set(k, { source: sid, target: tid, side });
  };
  const seenU = new Set();
  (function up(d, c, depth) {
    const id = colFieldId(d, c);
    if (seenU.has(id) || depth > 30) return;
    seenU.add(id);
    const parents = colParents(d, c);
    const kind = parents.length ? "up" : (producerOps(d).length ? "opaque" : "origin");
    addNode(d, c, id === focusId ? "focus" : kind);
    for (const p of parents) {
      addNode(p.dsId, p.col, "up");
      addEdge(colFieldId(p.dsId, p.col), id, "up");
      up(p.dsId, p.col, depth + 1);
    }
  })(dsId, colName, 0);
  const seenD = new Set();
  (function down(d, c, depth) {
    const id = colFieldId(d, c);
    if (seenD.has(id) || depth > 30) return;
    seenD.add(id);
    const children = colChildren(d, c);
    addNode(d, c, id === focusId ? "focus" : "down");
    for (const ch of children) {
      addNode(ch.dsId, ch.col, "down");
      addEdge(id, colFieldId(ch.dsId, ch.col), "down");
      down(ch.dsId, ch.col, depth + 1);
    }
  })(dsId, colName, 0);
  addNode(dsId, colName, "focus");

  const els = [];
  for (const n of nodes.values())
    els.push({ data: { id: n.id, label: n.col + "\n" + dsLabel(n.dsId), col: n.col, dsId: n.dsId, role: n.role, w: n.w } });
  let i = 0;
  for (const e of edges.values())
    els.push({ data: { id: "ce" + (i++), source: e.source, target: e.target, side: e.side } });
  return els;
}

function colCyStyle() {
  return [
    { selector: "node", style: {
        "background-color": (n) => (COL_ROLE[n.data("role")] || COL_ROLE.up).bg,
        "border-color": (n) => (COL_ROLE[n.data("role")] || COL_ROLE.up).border,
        "border-width": (n) => (n.data("role") === "focus" ? 3 : 2),
        "shape": "round-rectangle", "label": "data(label)", "color": "#eef2f8",
        "font-size": 11.5, "font-weight": 600, "text-wrap": "wrap",
        "text-max-width": (n) => n.data("w") - 16, "line-height": 1.3,
        "text-valign": "center", "text-halign": "center",
        "width": "data(w)", "height": 48, "padding": 6 } },
    { selector: "edge", style: {
        "width": 2.2,
        "line-color": (e) => (e.data("side") === "down" ? "#2fd196" : "#5a93ff"),
        "target-arrow-color": (e) => (e.data("side") === "down" ? "#2fd196" : "#5a93ff"),
        "target-arrow-shape": "triangle", "curve-style": "bezier",
        "arrow-scale": 1.05, "opacity": 0.92 } },
  ];
}

function renderColGraph(dsId, colName) {
  const ds = (lastResult.datasets || {})[dsId] || { name: dsId };
  $("cgCol").textContent = colName;
  $("cgDs").textContent = "field in " + (ds.name || dsId);
  const els = buildColElements(dsId, colName);
  if (colCy) colCy.destroy();
  colCy = cytoscape({
    container: $("colGraph"), elements: els, style: colCyStyle(),
    layout: { name: "dagre", rankDir: "LR", nodeSep: 22, rankSep: 74, edgeSep: 10, padding: 30 },
    wheelSensitivity: 0.25, minZoom: 0.25, maxZoom: 2.5,
  });
  colCy.on("tap", "node", (e) => {
    const d = e.target.data();
    selectColumn(d.dsId, d.col);
  });
  colCy.ready(() => colCy.fit(undefined, 46));
}

function openColGraph(dsId, colName) {
  const overlay = $("colOverlay");
  if (!overlay) return;
  colFocus = { dsId, col: colName };
  overlay.hidden = false;
  const legend = $("wsLegend"); if (legend) legend.hidden = true;
  renderColGraph(dsId, colName);
}

function closeColGraph() {
  const overlay = $("colOverlay");
  if (overlay && !overlay.hidden) {
    overlay.hidden = true;
    const legend = $("wsLegend"); if (legend) legend.hidden = false;
  }
  if (colCy) { colCy.destroy(); colCy = null; }
}

// ---------------------------------------------------------------------------
// In-table column highlight — the "combined" view: rather than a separate
// chart, dim every unrelated route in the main graph and light up just the
// datasets this field flows through, writing the field name onto each card.
// ---------------------------------------------------------------------------
function columnFootprint(dsId, col) {
  const fields = new Map();   // dsId -> Set(column)
  const edges = new Set();    // "src>dst" dataset-level hops that carry the field
  const addF = (d, c) => { if (!fields.has(d)) fields.set(d, new Set()); fields.get(d).add(c); };
  const seenU = new Set();
  (function up(d, c) {
    const k = d + "::" + c;
    if (seenU.has(k)) return; seenU.add(k);
    addF(d, c);
    for (const p of colParents(d, c)) { if (p.dsId !== d) edges.add(p.dsId + ">" + d); up(p.dsId, p.col); }
  })(dsId, col);
  const seenD = new Set();
  (function down(d, c) {
    const k = d + "::" + c;
    if (seenD.has(k)) return; seenD.add(k);
    addF(d, c);
    for (const ch of colChildren(d, c)) { if (ch.dsId !== d) edges.add(d + ">" + ch.dsId); down(ch.dsId, ch.col); }
  })(dsId, col);
  return { fields, edges };
}
function clearColMode() {
  if (!cy) return;
  cy.nodes("[colBadge]").forEach((n) => n.removeData("colBadge"));
  cy.elements().removeClass("colmode colfocus");
}
function highlightColumnInGraph(dsId, colName) {
  if (!cy) return;
  const fp = columnFootprint(dsId, colName);
  clearColMode();
  cy.elements().removeClass("hl faded");
  cy.elements().addClass("faded");
  fp.fields.forEach((cols, id) => {
    const n = cy.getElementById(id);
    if (n.empty()) return;
    const name = ((lastResult.datasets || {})[id] || {}).name || id;
    n.data("colBadge", name + "\n◦ " + [...cols].join(", "));
    n.removeClass("faded").addClass("colmode");
  });
  const fn = cy.getElementById(dsId);
  if (fn.nonempty()) fn.addClass("colfocus");
  cy.edges().forEach((e) => {
    if (fp.edges.has(e.data("source") + ">" + e.data("target")))
      e.removeClass("faded").addClass("hl");
  });
  const hlNodes = cy.nodes(".colmode");
  if (hlNodes.nonempty()) cy.animate({ fit: { eles: hlNodes, padding: 70 } }, { duration: 320 });
}

function selectColumn(dsId, colName) {
  colFocus = { dsId, col: colName };
  const ds = (lastResult.datasets || {})[dsId] || { name: dsId };
  const meta = (ds.columns || []).find((c) => (c.name || "").toLowerCase() === (colName || "").toLowerCase()) || {};
  const up = traceColUp(dsId, colName);
  const down = traceColDown(dsId, colName);
  highlightColumnInGraph(dsId, colName);
  if (!$("colOverlay").hidden) renderColGraph(dsId, colName);
  $("paneDetails").innerHTML = `
    <div class="d-head colhead">
      <button class="col-back" id="colBack" title="Back to ${esc(ds.name)}">←</button>
      <span class="bubble" style="background:var(--sql)">⛓</span>
      <div><h3 class="mono">${esc(colName)}</h3>
        <span class="role">Field in ${esc(ds.name)} · ${esc(meta.source || "derived")}</span></div>
    </div>
    <p class="ct-legend muted">This field is lit up <b>in the table graph</b> — source columns → this field → everything it feeds, with the other routes dimmed and each card tagged with its field. It can be <b>narrower than table lineage</b>.</p>
    <button class="btn trace-btn focuschart" id="openColChart">
      <span class="tb-ico">⤢</span>
      <span class="tb-txt"><b>Open focus chart</b><small>See just this field's flow as a clean diagram</small></span>
    </button>
    <div class="sec-title">↞ Trace to source</div>
    ${renderColTree(up, "up")}
    <div class="sec-title">↠ Trace impact</div>
    ${renderColTree(down, "down")}`;
  $("colBack").onclick = () => focusNode(dsId);
  $("openColChart").onclick = () => openColGraph(dsId, colName);
  $("paneDetails").querySelectorAll(".ct-node[data-ds]").forEach((el) =>
    el.onclick = () => selectColumn(el.dataset.ds, el.dataset.col));
  switchView("details");
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
  clearColMode();
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
function clearHighlight() { if (cy) { clearColMode(); cy.elements().removeClass("hl faded"); } }

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
function gotoView(view, group) {
  switchView(view);
  if (!group) return;
  const label = $("paneDatasets").querySelector(`.grouplabel[data-role="${group}"]`);
  if (label) label.scrollIntoView({ behavior: "smooth", block: "start" });
}
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
  cy.layout(dagreLayout()).run();
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

  document.querySelectorAll(".rail-item").forEach((t) => t.onclick = () => { closeColGraph(); switchView(t.dataset.view); });
  $("cgBack") && ($("cgBack").onclick = () => closeColGraph());
  $("cgFit") && ($("cgFit").onclick = () => colCy && colCy.animate({ fit: { padding: 46 } }, { duration: 250 }));
  document.querySelectorAll(".chip-toggle").forEach((c) => c.onclick = () => {
    const lang = c.dataset.lang;
    if (activeLangs.has(lang)) activeLangs.delete(lang); else activeLangs.add(lang);
    c.classList.toggle("active");
    applyLangFilter();
  });

  $("search").oninput = (e) => runSearch(e.target.value);
  $("layoutBtn").onclick = () => {
    rankDir = rankDir === "LR" ? "TB" : "LR";
    if (cy) cy.layout(dagreLayout()).run();
  };
  $("fitBtn").onclick = () => cy && cy.animate({ fit: { padding: 40 } }, { duration: 250 });
  $("resetHl").onclick = clearHighlight;
  $("graphHintClose") && ($("graphHintClose").onclick = () => hideGraphHint(true));
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
