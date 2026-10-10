"use strict";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let cy = null;
let lastResult = null;
let rankDir = "LR";
const activeLangs = new Set(["sql", "sas", "python"]);

const LANG_COLOR = { sql: "#3b82f6", sas: "#f59e0b", python: "#22c55e", "": "#8a97a8" };
const ROLE_COLOR = { root: "#3b82f6", sink: "#22c55e", mid: "#a855f7" };
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
  postForm("/api/parse", fd);
}
function loadDemo() { postForm("/api/parse-samples", new FormData()); }
function loadBatch(id) {
  const fd = new FormData(); fd.append("name", id);
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
        "shape": (n) => n.data("type") === "file" ? "round-rectangle"
          : n.data("type") === "view" ? "diamond" : "ellipse" } },
    { selector: "node.hl", style: { "border-color": "#ec0000", "border-width": 3,
        "width": 30, "height": 30, "font-weight": 700, "color": "#fff" } },
    { selector: "edge", style: {
        "width": 2, "line-color": (e) => LANG_COLOR[e.data("language")] || "#8a97a8",
        "target-arrow-color": (e) => LANG_COLOR[e.data("language")] || "#8a97a8",
        "target-arrow-shape": "triangle", "curve-style": "bezier", "arrow-scale": 1,
        "line-style": (e) => e.data("confidence") === "low" ? "dashed" : "solid", "opacity": 0.8 } },
    { selector: "edge.hl", style: { "width": 3.5, "opacity": 1, "z-index": 99 } },
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
  switchTab("summary");
}

// ---------------------------------------------------------------------------
// Summary tab
// ---------------------------------------------------------------------------
function renderSummary(data) {
  const s = data.stats || {};
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
    <div class="sec-title">Lineage integrity</div>
    <div class="bar-row"><span class="lab">Evidence</span>
      <span class="bar-track"><span class="bar-fill" style="width:${pctHigh(data)}%;background:var(--sink)"></span></span>
      <span class="val">${pctHigh(data)}%</span></div>
    <p class="muted empty" style="margin-top:10px">${s.low_confidence || 0} mapping(s) flagged for human review. Every edge is backed by a file, line and code snippet.</p>`;
}
function pctHigh(data) {
  const ops = data.operations || [];
  if (!ops.length) return 100;
  const high = ops.filter((o) => o.confidence === "high").length;
  return Math.round((high / ops.length) * 100);
}

// ---------------------------------------------------------------------------
// Datasets tab
// ---------------------------------------------------------------------------
function renderDatasets(data) {
  const groups = [
    ["root", "Source", data.roots || []],
    ["mid", "Intermediate", data.intermediate || []],
    ["sink", "Output", data.sinks || []],
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
function iconFor(t) { return t === "file" ? "◰" : t === "view" ? "◇" : "▦"; }

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
  $("paneReview").innerHTML = warns.length
    ? warns.map((w) => `<div class="warn-item"><span>⚠</span><span>${esc(w)}</span></div>`).join("")
    : `<div class="ok-state"><div class="big">✓</div><p>No gaps or low-confidence mappings.<br/>All lineage is backed by code evidence.</p></div>`;
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
      <div><h3>${esc(d.label)}</h3><span class="role">${d.role === "root" ? "Source" : d.role === "sink" ? "Output" : "Intermediate"} · ${d.type}</span></div>
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
  switchTab("details");
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
  switchTab("details");
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
// Tabs
// ---------------------------------------------------------------------------
function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".tabpane").forEach((p) => p.classList.toggle("active", p.dataset.pane === name));
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

  $("demoBtn").onclick = loadDemo;
  $("newBtn").onclick = showHome;

  document.querySelectorAll(".tab").forEach((t) => t.onclick = () => switchTab(t.dataset.tab));
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
}

initEvents();
loadBatchCards();
