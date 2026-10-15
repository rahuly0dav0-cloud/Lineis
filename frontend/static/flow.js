/* =========================================================================
   Banking Data Lineage Platform — guided, evidence-first flow (flow.js)

   Screens:
     1  Reports catalog (landing)
     2  Report view + CDE field details
     3  Resolve the starting point (candidate sources + evidence)
     4  Interactive upstream lineage (typed graph + table / formula / impact)
     5  Node inspection (side panel)
     6  Code, formula & evidence

   Self-contained. Reuses the backend parse (/api/parse-batch) + report packs.
   Themeable (light default / dark). The legacy dark workspace is reachable as
   the "Lineage Explorer" technical layer.
   ========================================================================= */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Node-type palette (fixed hues that read on both themes)
  const NTYPE = {
    report: { c: "#e11d48", label: "Report Field" },
    calc: { c: "#7c3aed", label: "Calculated Field" },
    table: { c: "#2563eb", label: "Table / Dataset" },
    code: { c: "#d97706", label: "Code / Process" },
    source: { c: "#0f9d6a", label: "Source Field" },
  };
  const CDE_TYPE = {
    aggregation: { label: "Aggregation", c: "#7c3aed" },
    calculation: { label: "Calculation", c: "#2563eb" },
    direct: { label: "Direct mapping", c: "#0f9d6a" },
    "cross-language": { label: "Cross-language", c: "#d97706" },
  };
  const LANG_LABEL = { sql: "SQL", sas: "SAS", py: "Python", python: "Python" };

  // ------------------------------------------------------------------ State
  const PF = {
    reports: [],        // catalogue from /api/reports
    report: null,       // selected catalogue entry
    pack: null,         // report_pack.json
    result: null,       // analyze() output for the batch
    cde: null,          // selected CDE object
    source: null,       // confirmed starting point { dataset, column }
    lineage: null,      // built lineage { nodes, edges, order }
    aiProposals: null,  // cached /api/agent/review proposals
    agent: false,
    step: "reports",
    reportTab: "report",
    lineageTab: "graph",
    filters: { domain: "", type: "", freq: "" },
  };
  let pfCy = null;

  // ------------------------------------------------------------------ Theme
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem("pf-theme", t); } catch (e) { /* ignore */ }
    const btn = $("pfTheme");
    if (btn) btn.textContent = t === "dark" ? "☀" : "☾";
    if (PF.step === "lineage" && pfCy) renderLineage(); // re-skin graph bg context
  }
  function initTheme() {
    let t = "light";
    try { t = localStorage.getItem("pf-theme") || "light"; } catch (e) { /* ignore */ }
    applyTheme(t);
  }

  // --------------------------------------------------------------- Screens
  function pfShow() {
    $("home").hidden = true;
    $("workspace").hidden = true;
    $("platform").hidden = false;
  }
  window.pfShow = pfShow;

  function setStep(step) {
    PF.step = step;
    renderStepbar();
  }

  // --------------------------------------------------------- Trace helpers
  function opFor(dsId) {
    return (PF.result.operations || []).find((o) => o.target === dsId) || null;
  }
  function dsName(dsId) {
    const d = (PF.result.datasets || {})[dsId];
    return d ? d.name : dsId;
  }
  function colEdge(op, col) {
    if (!op) return null;
    const lc = String(col).toLowerCase();
    return (op.column_map || []).find((e) => String(e.target_column).toLowerCase() === lc) || null;
  }
  function splitCol(s) {
    const parts = String(s).split(".");
    const col = parts.pop();
    const ds = parts.pop() || null;
    return { ds, col };
  }

  // Build the upstream lineage of (dsId, col) as a node/edge set.
  function buildLineage(dsId, col) {
    const nodes = new Map();
    const edges = [];
    const order = [];
    const visit = (dsId, col, depth) => {
      const key = dsId + "." + col;
      if (nodes.has(key)) return key;
      const op = opFor(dsId);
      const edge = colEdge(op, col);
      let role;
      if (depth === 0) role = "report";
      else if (!op) role = "source";
      else if (!edge) role = "boundary";
      else role = "calc";
      const n = {
        key, dsId, col, role, op, depth,
        sources: edge ? (edge.source_columns || []) : [],
        resolved: role !== "boundary",
        aiInferred: false,
      };
      nodes.set(key, n);
      order.push(key);
      if (edge && edge.source_columns && depth < 16) {
        edge.source_columns.forEach((s) => {
          const { ds: sd, col: sc } = splitCol(s);
          if (!sd) return;
          const ck = visit(sd, sc, depth + 1);
          edges.push({ from: key, to: ck });  // derived -> its input (LR: report left)
        });
      }
      return key;
    };
    visit(dsId, col, 0);
    return { nodes, edges, order };
  }

  // Downstream trace of (dsId,col): which fields it feeds, breadth-first.
  function buildDownstream(dsId, col) {
    const seen = new Set();
    const chain = [];
    let frontier = [{ ds: dsId, col }];
    let guard = 0;
    while (frontier.length && guard++ < 40) {
      const next = [];
      for (const cur of frontier) {
        for (const op of PF.result.operations || []) {
          for (const e of op.column_map || []) {
            const hit = (e.source_columns || []).some((s) => {
              const sp = splitCol(s);
              return sp.ds === cur.ds && sp.col.toLowerCase() === cur.col.toLowerCase();
            });
            if (hit) {
              const key = op.target + "." + e.target_column;
              if (!seen.has(key)) {
                seen.add(key);
                chain.push({ ds: op.target, col: e.target_column, op });
                next.push({ ds: op.target, col: e.target_column });
              }
            }
          }
        }
      }
      frontier = next;
    }
    return chain;
  }

  // =====================================================================
  //  Screen 1 · Reports catalog
  // =====================================================================
  async function loadReports() {
    try {
      const res = await fetch("/api/reports");
      const data = await res.json();
      PF.reports = data.reports || [];
    } catch (e) { PF.reports = []; }
    renderReports();
  }

  function domainClass(d) {
    const s = String(d || "").toLowerCase();
    if (s.includes("liquid")) return "liquidity";
    if (s.includes("credit")) return "credit";
    return "";
  }

  function renderReports() {
    setStep("reports");
    $("pfTopTitle").innerHTML = "Report Catalog<span>Prove where every reported number comes from</span>";
    const main = $("pfMain");
    main.className = "pf-main";

    const domains = [...new Set(PF.reports.map((r) => r.domain).filter(Boolean))];
    const types = [...new Set(PF.reports.map((r) => r.report_type).filter(Boolean))];
    const freqs = [...new Set(PF.reports.map((r) => r.frequency).filter(Boolean))];
    const f = PF.filters;
    const shown = PF.reports.filter((r) =>
      (!f.domain || r.domain === f.domain) &&
      (!f.type || r.report_type === f.type) &&
      (!f.freq || r.frequency === f.freq));

    const opt = (arr, sel, all) =>
      `<option value="">${all}</option>` + arr.map((v) =>
        `<option value="${esc(v)}" ${v === sel ? "selected" : ""}>${esc(v)}</option>`).join("");

    main.innerHTML = `
      <div class="pf-page-head">
        <h1>Regulatory &amp; risk reports</h1>
        <p>Select a report to trace a reported figure back to its source code, confirm how it was
           calculated, and check whether the lineage can be trusted.</p>
      </div>
      <div class="pf-reports-bar">
        <div class="pf-filter"><label>Domain</label>
          <select class="pf-select" id="pffDomain">${opt(domains, f.domain, "All domains")}</select></div>
        <div class="pf-filter"><label>Type</label>
          <select class="pf-select" id="pffType">${opt(types, f.type, "All types")}</select></div>
        <div class="pf-filter"><label>Frequency</label>
          <select class="pf-select" id="pffFreq">${opt(freqs, f.freq, "All")}</select></div>
        <button class="pf-btn sm" id="pffReset">Reset</button>
        <div class="pf-top-spacer"></div>
        <button class="pf-btn primary sm" id="pfUpload">＋ Upload Report Assets</button>
      </div>
      <div class="pf-rlist" id="pfReportGrid"></div>`;

    const grid = $("pfReportGrid");
    if (!shown.length) {
      grid.innerHTML = `<div class="pf-empty"><div class="big">▣</div>No reports match these filters.</div>`;
    } else {
      grid.innerHTML = shown.map((r) => `
        <div class="pf-rrow" data-batch="${esc(r.batch)}">
          <div class="pf-rrow-main">
            <div class="pf-rrow-head">
              <span class="pf-domain-tag ${domainClass(r.domain)}">${esc(r.domain || "Report")}</span>
              <h3>${esc(r.name)}</h3>
              <span class="pf-rrow-fw">${esc(r.framework || "")}</span>
            </div>
            <p>${esc(r.description || "")}</p>
            <div class="pf-rrow-sub">
              <span>Owner <b>${esc(r.owner || "—")}</b></span>
              <span>Frequency <b>${esc(r.frequency || "—")}</b></span>
              <span>Version <b>${esc(r.version || "—")}</b></span>
              <span>Updated <b>${esc(r.last_updated || "—")}</b></span>
            </div>
          </div>
          <div class="pf-rrow-side">
            <div class="pf-rrow-cdes"><b>${r.cde_count}</b><span>CDEs</span></div>
            <div class="pf-rrow-langs">${(r.languages || []).map((l) => `<span class="pf-lg ${l}">${esc(l)}</span>`).join("")}</div>
            <div class="pf-rrow-files">${r.files} files · ${r.lines} lines</div>
            <span class="pf-rrow-go">Trace lineage →</span>
          </div>
        </div>`).join("");
      grid.querySelectorAll(".pf-rrow").forEach((c) =>
        c.onclick = () => openReport(c.dataset.batch));
    }

    $("pffDomain").onchange = (e) => { f.domain = e.target.value; renderReports(); };
    $("pffType").onchange = (e) => { f.type = e.target.value; renderReports(); };
    $("pffFreq").onchange = (e) => { f.freq = e.target.value; renderReports(); };
    $("pffReset").onclick = () => { PF.filters = { domain: "", type: "", freq: "" }; renderReports(); };
    $("pfUpload").onclick = () => { $("platform").hidden = true; if (window.showHomeUpload) window.showHomeUpload(); else { $("home").hidden = false; } };
  }

  // =====================================================================
  //  Open a report → parse its batch, then show the report view
  // =====================================================================
  async function openReport(batch) {
    const main = $("pfMain");
    main.className = "pf-main";
    main.innerHTML = `<div class="pf-empty"><div class="pf-spin" style="margin:0 auto 14px"></div>Parsing lineage &amp; loading report pack…</div>`;
    try {
      const fd = new FormData(); fd.append("name", batch);
      const res = await fetch("/api/parse-batch", { method: "POST", body: fd });
      const data = await res.json();
      PF.result = data;
      PF.pack = data.report_pack || null;
      PF.report = PF.reports.find((r) => r.batch === batch) || null;
      PF.batch = batch;
      PF.cde = null; PF.source = null; PF.lineage = null; PF.aiProposals = null;
    } catch (e) {
      main.innerHTML = `<div class="pf-empty">Could not load this report.<br><button class="pf-btn" onclick="location.reload()">Reload</button></div>`;
      return;
    }
    // pick the hero CDE by default
    const cdes = (PF.pack && PF.pack.cdes) || [];
    PF.cde = cdes.find((c) => c.hero) || cdes[0] || null;
    PF.reportTab = "report";
    renderReport();
  }

  // =====================================================================
  //  Screen 2 · Report view + field details
  // =====================================================================
  function renderReport() {
    setStep("report");
    const meta = (PF.pack && PF.pack.report) || {};
    $("pfTopTitle").innerHTML = `${esc(meta.name || "Report")}<span>${esc(meta.framework || "")}</span>`;
    const main = $("pfMain");
    main.className = "pf-main";

    const tabs = [
      ["report", "Report View"],
      ["dict", "CDE Dictionary"],
      ["tech", "Technical Mapping"],
      ["related", "Related Assets"],
      ["jobs", "Job Metadata"],
    ];
    main.innerHTML = `
      <div class="pf-page-head">
        <h1>${esc(meta.name || "Report")}</h1>
        <p>${esc(meta.description || "")}</p>
      </div>
      <div class="pf-tabs" id="pfReportTabs">
        ${tabs.map(([k, l]) => `<button class="pf-tab ${k === PF.reportTab ? "active" : ""}" data-t="${k}">${l}</button>`).join("")}
      </div>
      <div style="height:16px"></div>
      <div id="pfReportTabBody"></div>`;

    main.querySelectorAll("#pfReportTabs .pf-tab").forEach((t) =>
      t.onclick = () => { PF.reportTab = t.dataset.t; renderReport(); });
    renderReportTab();
  }

  function renderReportTab() {
    const body = $("pfReportTabBody");
    if (PF.reportTab === "report") return renderReportViewTab(body);
    if (PF.reportTab === "dict") return renderDictTab(body);
    if (PF.reportTab === "tech") return renderTechTab(body);
    if (PF.reportTab === "related") return renderRelatedTab(body);
    if (PF.reportTab === "jobs") return renderJobsTab(body);
  }

  function fmtNum(v) {
    if (v == null || v === "") return "—";
    if (typeof v !== "number") return esc(v);
    return Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2);
  }
  function lineRange(op) {
    return op && op.line_start ? op.line_start + "–" + op.line_end : "—";
  }
  function fileLoc(op) {
    if (!op) return "—";
    return esc(op.file) + (op.line_start ? ":" + op.line_start : "");
  }

  function renderReportViewTab(body) {
    const pack = PF.pack || {};
    const table = pack.table;
    const cdes = pack.cdes || [];
    const cdeById = Object.fromEntries(cdes.map((c) => [c.id, c]));

    let tableHtml = `<div class="pf-empty">No report table for this pack.</div>`;
    if (table) {
      const cols = table.columns || [];
      tableHtml = `
        <div class="pf-table-wrap">
          <table class="pf-rtable">
            <thead><tr>${cols.map((c) =>
              `<th class="${c.num ? "num" : ""} ${c.cde ? "cde" : ""} ${c.cde && PF.cde && c.cde === PF.cde.id ? "sel" : ""}" data-cde="${esc(c.cde || "")}">${esc(c.label)}</th>`).join("")}</tr></thead>
            <tbody>${(table.rows || []).map((row) => `<tr>${cols.map((c) => {
              const sel = c.cde && PF.cde && c.cde === PF.cde.id;
              return `<td class="${c.num ? "num" : ""} ${c.cde ? "cde" : ""} ${sel ? "sel" : ""}" data-cde="${esc(c.cde || "")}">${fmtNum(row[c.key])}</td>`;
            }).join("")}</tr>`).join("")}</tbody>
          </table>
          ${table.caption ? `<div class="pf-table-cap">${esc(table.caption)} · <b>${esc((pack.report || {}).unit || "")}</b></div>` : ""}
        </div>`;
    }

    // CDEs not represented as a report-table column — selectable chips
    const colCdeIds = new Set((table ? table.columns : []).map((c) => c.cde).filter(Boolean));
    const extraCdes = cdes.filter((c) => !colCdeIds.has(c.id));

    body.innerHTML = `
      <div class="pf-report-layout">
        <div>
          <div class="pf-card">
            <div class="pf-card-head">
              <div><h3>Report output</h3><div class="sub">Click a highlighted figure (●) to inspect its Critical Data Element</div></div>
            </div>
            ${tableHtml}
          </div>
          ${extraCdes.length ? `
          <div style="height:16px"></div>
          <div class="pf-card">
            <div class="pf-card-head"><div><h3>Other critical data elements</h3><div class="sub">Also governed in this report but not shown on the face of the table</div></div></div>
            <div style="padding:14px 18px; display:flex; flex-wrap:wrap; gap:8px">
              ${extraCdes.map((c) => `<button class="pf-chip" style="cursor:pointer; font-size:12.5px; padding:7px 12px" data-cde="${esc(c.id)}">${esc(c.business_name)}</button>`).join("")}
            </div>
          </div>` : ""}
        </div>
        <div class="pf-card pf-field" id="pfFieldPanel">${fieldPanelHtml()}</div>
      </div>`;

    // wire CDE selection
    body.querySelectorAll("[data-cde]").forEach((el) => {
      const id = el.getAttribute("data-cde");
      if (!id) return;
      el.onclick = () => { PF.cde = (PF.pack.cdes || []).find((c) => c.id === id) || PF.cde; renderReportViewTab(body); };
    });
    wireFieldPanel();
  }

  function fieldPanelHtml() {
    const c = PF.cde;
    if (!c) return `<div class="pf-field-empty"><div class="big">◎</div>Select a highlighted figure to see its business definition and lineage entry point.</div>`;
    const t = CDE_TYPE[c.type] || { label: c.type, c: "#2563eb" };
    return `
      <div class="pf-field-body">
        <span class="pf-field-kicker">◎ Critical Data Element</span>
        <h3>${esc(c.business_name)}</h3>
        <div class="pf-field-code">${esc(c.cde_code || "")} · ${esc(c.report_location || "")}</div>
        <div class="pf-field-def">${esc(c.definition || "")}</div>
        <div class="pf-kv">
          <div class="pf-kv-row"><span class="k">Type</span><span class="v"><span class="pf-type-badge" style="background:${t.c}22;color:${t.c}">${t.label}</span></span></div>
          <div class="pf-kv-row"><span class="k">Technical name</span><span class="v"><span class="mono">${esc(dsName(c.dataset))}.${esc(c.column)}</span></span></div>
          <div class="pf-kv-row"><span class="k">Data type</span><span class="v">${esc(c.data_type || "—")}</span></div>
          <div class="pf-kv-row"><span class="k">Aggregation</span><span class="v">${esc(c.aggregation_level || "—")}</span></div>
          <div class="pf-kv-row"><span class="k">Appears in</span><span class="v"><div class="pf-chiplist">${(c.appears_in || []).map((a) => `<span class="pf-chip">${esc(a)}</span>`).join("") || "—"}</div></span></div>
        </div>
        <button class="pf-btn primary" id="pfTrace" style="width:100%">Trace Lineage →</button>
      </div>`;
  }

  function wireFieldPanel() {
    const t = $("pfTrace");
    if (t) t.onclick = () => startLineage();
  }

  function renderDictTab(body) {
    const cdes = (PF.pack && PF.pack.cdes) || [];
    body.innerHTML = `<div class="pf-card"><div class="pf-table-wrap"><table class="pf-rtable">
      <thead><tr><th>CDE</th><th>Code</th><th>Type</th><th>Report location</th><th>Technical field</th></tr></thead>
      <tbody>${cdes.map((c) => {
        const t = CDE_TYPE[c.type] || { label: c.type, c: "#2563eb" };
        return `<tr data-cde="${esc(c.id)}" style="cursor:pointer">
          <td style="font-weight:600;color:var(--pf-text)">${esc(c.business_name)}${c.hero ? ` <span class="pf-rec-pill">hero</span>` : ""}</td>
          <td class="pf-mono">${esc(c.cde_code || "")}</td>
          <td><span class="pf-type-badge" style="background:${t.c}22;color:${t.c}">${t.label}</span></td>
          <td>${esc(c.report_location || "")}</td>
          <td class="pf-mono">${esc(dsName(c.dataset))}.${esc(c.column)}</td></tr>`;
      }).join("")}</tbody></table></div></div>`;
    body.querySelectorAll("[data-cde]").forEach((r) => r.onclick = () => {
      PF.cde = (PF.pack.cdes || []).find((c) => c.id === r.dataset.cde); PF.reportTab = "report"; renderReport();
    });
  }

  function renderTechTab(body) {
    const cdes = (PF.pack && PF.pack.cdes) || [];
    body.innerHTML = `<div class="pf-card"><div class="pf-table-wrap"><table class="pf-rtable">
      <thead><tr><th>CDE</th><th>Output dataset</th><th>Column</th><th>Produced by</th><th>Evidence</th></tr></thead>
      <tbody>${cdes.map((c) => {
        const op = opFor(c.dataset);
        return `<tr><td style="font-weight:600;color:var(--pf-text)">${esc(c.business_name)}</td>
          <td class="pf-mono">${esc(dsName(c.dataset))}</td>
          <td class="pf-mono">${esc(c.column)}</td>
          <td>${op ? `${LANG_LABEL[op.language] || op.language} · ${esc(op.kind)}` : "—"}</td>
          <td class="pf-mono" style="font-size:11.5px">${op ? fileLoc(op) : "source dataset"}</td></tr>`;
      }).join("")}</tbody></table></div></div>`;
  }

  function renderRelatedTab(body) {
    const cdes = (PF.pack && PF.pack.cdes) || [];
    body.innerHTML = cdes.map((c) => `
      <div class="pf-card" style="margin-bottom:12px"><div class="pf-card-head">
        <div><h3>${esc(c.business_name)}</h3><div class="sub">${esc(c.cde_code || "")}</div></div></div>
      <div style="padding:14px 18px"><div class="pf-section-label">Also governed in</div>
        <div class="pf-chiplist">${(c.appears_in || []).map((a) => `<span class="pf-chip">${esc(a)}</span>`).join("") || "—"}</div></div></div>`).join("");
  }

  function renderJobsTab(body) {
    const cdes = (PF.pack && PF.pack.cdes) || [];
    const rows = [];
    cdes.forEach((c) => (c.candidates || []).forEach((cand) => {
      if (cand.recommended || cand.dataset === c.dataset) rows.push({ cde: c.business_name, cand });
    }));
    body.innerHTML = `<div class="pf-card"><div class="pf-table-wrap"><table class="pf-rtable">
      <thead><tr><th>CDE</th><th>Job / process</th><th>Output</th><th>Last run</th><th class="num">Confidence</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td style="font-weight:600;color:var(--pf-text)">${esc(r.cde)}</td>
        <td class="pf-mono">${esc(r.cand.job || "—")}</td>
        <td class="pf-mono">${esc(dsName(r.cand.dataset))}</td>
        <td>${esc(r.cand.last_updated || "—")}</td>
        <td class="num">${Math.round((r.cand.confidence || 0) * 100)}%</td></tr>`).join("")}</tbody></table></div></div>`;
  }

  // =====================================================================
  //  LINEAGE · Collibra-style field + table graph (data from pack.lineage)
  // =====================================================================
  const KIND = {
    source:   { c: "#0f9d6a", label: "Source table" },
    stage:    { c: "#2563eb", label: "Staging" },
    boundary: { c: "#d97706", label: "Grey zone · AI + manual" },
    mart:     { c: "#7c3aed", label: "Mart / aggregate" },
    report:   { c: "#e11d48", label: "Regulatory report" },
  };

  function keyTable(key) { return String(key).split(".")[0]; }
  function keyCol(key) { const i = String(key).indexOf("."); return i < 0 ? key : key.slice(i + 1); }
  function tableName(id) { const t = PF.model && PF.model.byId[id]; return t ? t.name : id; }

  function startLineage() {
    const lin = PF.pack && PF.pack.lineage;
    if (!lin || !(lin.tables || []).length) {
      setStep("lineage");
      const m = $("pfMain"); m.className = "pf-main";
      m.innerHTML = `<div class="pf-empty"><div class="big">⎔</div>No lineage graph is configured for this report yet.</div>`;
      return;
    }
    PF.model = buildGraphModel(lin);
    PF.focusKey = (lin.focus && lin.focus[PF.cde.id]) || defaultFocusKey();
    PF.showFullTable = false;
    PF.inspect = null;
    PF.hl = computeHighlight(PF.focusKey);
    renderLineage();
  }

  function defaultFocusKey() {
    const m = PF.model;
    const rep = m.tables.slice().sort((a, b) => b.stage - a.stage)[0];
    const col = rep.columns.find((c) => !/_id$|_row$/.test(c)) || rep.columns[0];
    return rep.id + "." + col;
  }

  function buildGraphModel(lin) {
    const tables = (lin.tables || []).map((t) => ({ ...t, columns: t.columns || [] }));
    const byId = Object.fromEntries(tables.map((t) => [t.id, t]));
    const columnEdges = (lin.columnEdges || []).filter((e) => e.from && e.to);
    const tableEdges = (lin.tableEdges || []);
    const inAdj = new Map();
    const outAdj = new Map();
    columnEdges.forEach((e) => {
      if (!inAdj.has(e.to)) inAdj.set(e.to, []);
      inAdj.get(e.to).push(e.from);
      if (!outAdj.has(e.from)) outAdj.set(e.from, []);
      outAdj.get(e.from).push(e.to);
    });
    return { tables, byId, columnEdges, tableEdges, inAdj, outAdj };
  }

  // Upstream closure of the focus column + grey-zone boundary detection.
  function computeHighlight(focusKey) {
    const m = PF.model;
    const cols = new Set(), edges = new Set(), boundaryEdges = new Set();
    const contextTables = new Set(), pathTables = new Set();
    const boundaries = [], origins = [], depth = new Map();
    if (!focusKey) return { cols, edges, boundaryEdges, contextTables, pathTables, boundaries, origins, maxDepth: 0 };
    depth.set(focusKey, 0);
    const queue = [focusKey], seen = new Set();
    while (queue.length) {
      const cur = queue.shift();
      if (seen.has(cur)) continue;
      seen.add(cur);
      cols.add(cur);
      pathTables.add(keyTable(cur));
      const ins = m.inAdj.get(cur) || [];
      if (!ins.length) {
        const tid = keyTable(cur);
        const bEdges = m.tableEdges.filter((e) => e.to === tid && e.boundary);
        if (bEdges.length) {
          bEdges.forEach((be) => { boundaryEdges.add(be.from + ">" + be.to); contextTables.add(be.from); });
          boundaries.push({ table: tid, column: keyCol(cur), reason: bEdges[0].reason || "", sources: bEdges.map((b) => b.from) });
        } else {
          origins.push(cur);
        }
      }
      ins.forEach((f) => {
        edges.add(f + ">" + cur);
        if (!depth.has(f)) { depth.set(f, (depth.get(cur) || 0) + 1); queue.push(f); }
      });
    }
    let maxDepth = 0; depth.forEach((d) => { if (d > maxDepth) maxDepth = d; });
    return { cols, edges, boundaryEdges, contextTables, pathTables, boundaries, origins, maxDepth };
  }

  function renderLineage() {
    setStep("lineage");
    const cde = PF.cde;
    const meta = (PF.pack && PF.pack.report) || {};
    $("pfTopTitle").innerHTML = `Lineage · ${esc(cde.business_name)}<span>${esc(meta.name || "")}</span>`;
    const main = $("pfMain");
    main.className = "pf-main flush";
    const hl = PF.hl;
    const legend = Object.keys(KIND).map((k) => `<span><i style="background:${KIND[k].c}"></i>${KIND[k].label}</span>`).join("")
      + `<span><i class="pf-lg-path"></i>Highlighted field path</span>`;
    main.innerHTML = `
      <div class="pf-lin-head">
        <div class="pf-lin-title">
          <span class="pf-lin-kicker">◎ Field lineage</span>
          <h2>${esc(cde.business_name)}</h2>
          <div class="pf-lin-sub"><span class="mono">${esc(tableName(keyTable(PF.focusKey)))}.${esc(keyCol(PF.focusKey))}</span> · ${esc(meta.name || "")}</div>
        </div>
        <div class="pf-lin-actions">
          <label class="pf-switch"><input type="checkbox" id="pfFullToggle" ${PF.showFullTable ? "checked" : ""}><span class="pf-switch-ui"></span><span class="pf-switch-tx">Show full table lineage</span></label>
          <button class="pf-btn sm" id="pfFit">⤢ Fit</button>
          <button class="pf-btn sm" id="pfExport">Export CSV</button>
          <button class="pf-btn sm" id="pfBackReport">← Report</button>
        </div>
      </div>
      ${traceSummaryHtml(hl)}
      <div class="pf-lineage-main">
        <div class="pf-graph-wrap" id="pfGraphWrap">
          <div id="pfGraph"></div>
          <div class="pf-legend">${legend}</div>
        </div>
        <aside class="pf-inspect-host" id="pfInspectHost">${panelEmptyHtml()}</aside>
      </div>`;
    $("pfFullToggle").onchange = (e) => { PF.showFullTable = e.target.checked; applyFade(); };
    $("pfFit").onclick = () => pfCy && pfCy.fit(undefined, 44);
    $("pfExport").onclick = () => exportLineage();
    $("pfBackReport").onclick = () => { PF.reportTab = "report"; renderReport(); };
    const tai = $("pfTraceAi");
    if (tai) tai.onclick = () => boundaryResolveAi(hl.boundaries[0] ? { to: hl.boundaries[0].table } : null, "pfTraceAiOut");
    requestAnimationFrame(drawGraph);
  }

  function traceSummaryHtml(hl) {
    const depth = hl.maxDepth;
    if (hl.boundaries && hl.boundaries.length) {
      const b = hl.boundaries[0];
      const tname = tableName(b.table);
      const grp = (PF.model.byId[b.table] || {}).group || "code";
      return `<div class="pf-trace warn">
        <div class="pf-trace-ic">◐</div>
        <div class="pf-trace-tx"><b>Traced ${depth} hop${depth === 1 ? "" : "s"} upstream</b> to <span class="mono">${esc(tname)}.${esc(b.column)}</span> — then the trail enters a <b>grey zone</b>.
          <span class="pf-trace-dim">Beyond this point the value is computed inside ${esc(tname)} (${esc(grp)}); the per-field formula isn't statically visible. This is where we bring in <b>AI plus a manual review of run logs and the data catalogue</b> to close the connection.</span>
          <div id="pfTraceAiOut"></div></div>
        <button class="pf-btn ai sm" id="pfTraceAi">✦ Close the gap with AI</button>
      </div>`;
    }
    const origins = (hl.origins || []).map((k) => `${tableName(keyTable(k))}.${keyCol(k)}`);
    return `<div class="pf-trace ok">
      <div class="pf-trace-ic">✓</div>
      <div class="pf-trace-tx"><b>Fully traced — ${depth} hop${depth === 1 ? "" : "s"} back to source.</b>
        <span class="pf-trace-dim">Every hop is backed by code. Origin field${origins.length === 1 ? "" : "s"}: <span class="mono">${esc(origins.join(", ") || "—")}</span>.</span></div>
    </div>`;
  }

  // --------------------------------------------------------------- graph
  function drawGraph() {
    if (pfCy) { pfCy.destroy(); pfCy = null; }
    const m = PF.model;
    const cs = getComputedStyle($("platform"));
    const V = (n, d) => (cs.getPropertyValue(n).trim() || d);
    const P = {
      surf: V("--pf-surface", "#ffffff"),
      surf2: V("--pf-surface-2", "#f3f6fb"),
      border: V("--pf-border", "#dde3ee"),
      text: V("--pf-text", "#10203a"),
      dim: V("--pf-text-dim", "#55647e"),
      accent: V("--pf-accent", "#2f6bff"),
    };
    const charW = 7.3, HDR = 30, ROW = 22, GY = 48, GX = 140, PADB = 12;
    const tW = (t) => {
      const maxLen = Math.max(t.name.length, ...t.columns.map((c) => c.length), 9);
      return Math.min(266, Math.max(172, maxLen * charW + 30));
    };
    const stages = [...new Set(m.tables.map((t) => t.stage))].sort((a, b) => a - b);
    const byStage = {}; stages.forEach((s) => byStage[s] = m.tables.filter((t) => t.stage === s));
    const stageX = {}; let x = 0;
    stages.forEach((s) => { const w = Math.max(...byStage[s].map(tW)); stageX[s] = x; x += w + GX; });
    const pos = {}, box = {};
    stages.forEach((s) => {
      const list = byStage[s];
      const heights = list.map((t) => HDR + t.columns.length * ROW + PADB);
      const total = heights.reduce((a, b) => a + b, 0) + GY * Math.max(0, list.length - 1);
      let y = -total / 2;
      list.forEach((t, ti) => {
        const w = tW(t), cx = stageX[s] + w / 2, topY = y;
        pos[t.id + "__hdr"] = { x: cx, y: topY + HDR / 2 };
        t.columns.forEach((c, ci) => { pos[t.id + "." + c] = { x: cx, y: topY + HDR + ci * ROW + ROW / 2 }; });
        box[t.id] = { w, cx, topY, h: heights[ti] };
        y += heights[ti] + GY;
      });
    });

    const els = [];
    m.tables.forEach((t) => {
      els.push({ data: { id: t.id, ntype: "parent", kind: t.kind } });
      els.push({ data: { id: t.id + "__hdr", parent: t.id, label: t.name, kind: t.kind, tableId: t.id }, position: pos[t.id + "__hdr"], classes: "hdr" });
      t.columns.forEach((c) => {
        const key = t.id + "." + c;
        const cls = ["col"];
        if (PF.hl.cols.has(key)) cls.push("hot");
        if (key === PF.focusKey) cls.push("focus");
        els.push({ data: { id: key, parent: t.id, label: c, tableId: t.id, col: c }, position: pos[key], classes: cls.join(" ") });
      });
    });
    m.columnEdges.forEach((e, i) => {
      els.push({ data: { id: "ce" + i, source: e.from, target: e.to, ntype: "cedge" }, classes: PF.hl.edges.has(e.from + ">" + e.to) ? "hot" : "" });
    });
    m.tableEdges.forEach((e, i) => {
      els.push({ data: { id: "te" + i, source: e.from, target: e.to, ntype: "bedge", blabel: e.boundary ? "AI + manual" : "" }, classes: "bedge" + (PF.hl.boundaryEdges.has(e.from + ">" + e.to) ? " hot" : "") });
    });

    pfCy = cytoscape({
      container: $("pfGraph"),
      elements: els,
      style: [
        { selector: "node:parent", style: {
          "background-color": P.surf2, "background-opacity": 0.5,
          "border-width": 1, "border-color": P.border, "shape": "round-rectangle", "padding": 3, "label": "" } },
        { selector: "node.hdr", style: {
          "background-color": (n) => (KIND[n.data("kind")] || KIND.stage).c,
          "label": "data(label)", "color": "#fff", "font-size": 11.5, "font-weight": 700,
          "text-valign": "center", "text-halign": "center", "text-wrap": "wrap", "text-max-width": 240,
          "width": (n) => box[n.data("tableId")].w - 4, "height": HDR - 4, "shape": "round-rectangle" } },
        { selector: "node.col", style: {
          "background-color": P.surf, "border-width": 1, "border-color": P.border,
          "label": "data(label)", "color": P.dim, "font-size": 10.5, "font-family": "ui-monospace, Menlo, monospace",
          "text-valign": "center", "text-halign": "left", "text-margin-x": 9, "text-wrap": "none",
          "width": (n) => box[n.data("tableId")].w - 14, "height": ROW - 4, "shape": "round-rectangle" } },
        { selector: "node.col.hot", style: {
          "border-color": P.accent, "border-width": 1.6, "background-color": P.accent, "background-opacity": 0.14,
          "color": P.text, "font-weight": 700 } },
        { selector: "node.col.focus", style: {
          "background-color": P.accent, "background-opacity": 1, "color": "#fff", "border-color": P.accent, "border-width": 2 } },
        { selector: "node.faded", style: { "opacity": 0.13 } },
        { selector: "node.ghost", style: { "opacity": 0.5 } },
        { selector: "edge[ntype = 'cedge']", style: {
          "width": 1.4, "line-color": P.border, "target-arrow-color": P.border,
          "target-arrow-shape": "triangle", "arrow-scale": 0.8, "curve-style": "bezier", "opacity": 0.85 } },
        { selector: "edge[ntype = 'cedge'].hot", style: {
          "width": 2.6, "line-color": P.accent, "target-arrow-color": P.accent, "opacity": 1, "z-index": 20 } },
        { selector: "edge[ntype = 'bedge']", style: {
          "width": 2, "line-color": "#d97706", "target-arrow-color": "#d97706",
          "target-arrow-shape": "triangle", "arrow-scale": 0.9, "curve-style": "bezier", "line-style": "dashed",
          "label": "data(blabel)", "font-size": 9, "color": "#d97706",
          "text-background-color": P.surf, "text-background-opacity": 1, "text-background-padding": 2, "opacity": 0.9 } },
        { selector: "edge.faded", style: { "opacity": 0.1 } },
      ],
      layout: { name: "preset", fit: false },
      wheelSensitivity: 0.2,
    });
    pfCy.on("tap", "node.hdr", (ev) => openPanel(ev.target.data("tableId"), null, "table"));
    pfCy.on("tap", "node.col", (ev) => openPanel(ev.target.data("tableId"), ev.target.data("col"), "column"));
    applyFade();
    const fit = () => { if (pfCy) { pfCy.resize(); pfCy.fit(undefined, 48); } };
    requestAnimationFrame(() => requestAnimationFrame(fit));
    setTimeout(fit, 120);
  }

  function applyFade() {
    if (!pfCy) return;
    const hl = PF.hl;
    if (PF.showFullTable) { pfCy.elements().removeClass("faded ghost"); return; }
    pfCy.batch(() => {
      pfCy.nodes(".col").forEach((n) => n.toggleClass("faded", !hl.cols.has(n.id())));
      pfCy.nodes(".hdr").forEach((n) => {
        const t = n.data("tableId");
        n.removeClass("faded ghost");
        if (hl.pathTables.has(t)) { /* keep */ }
        else if (hl.contextTables.has(t)) n.addClass("ghost");
        else n.addClass("faded");
      });
      pfCy.nodes(":parent").forEach((n) => {
        const t = n.id();
        n.toggleClass("faded", !(hl.pathTables.has(t) || hl.contextTables.has(t)));
      });
      pfCy.edges("[ntype = 'cedge']").forEach((e) => e.toggleClass("faded", !hl.edges.has(e.data("source") + ">" + e.data("target"))));
      pfCy.edges("[ntype = 'bedge']").forEach((e) => e.toggleClass("faded", !hl.boundaryEdges.has(e.data("source") + ">" + e.data("target"))));
    });
  }

  function exportLineage() {
    const m = PF.model, hl = PF.hl;
    const rows = [["field", "table", "kind", "in_highlighted_path", "upstream_fields"]];
    m.tables.forEach((t) => t.columns.forEach((c) => {
      const key = t.id + "." + c;
      const ups = (m.inAdj.get(key) || []).map((k) => tableName(keyTable(k)) + "." + keyCol(k)).join(" | ");
      rows.push([c, t.name, t.kind, hl.cols.has(key) ? "yes" : "no", ups]);
    }));
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = "lineage_" + (PF.cde.id || "cde") + ".csv";
    a.click();
  }

  // ---------------------------------------------------------- node panel
  function panelEmptyHtml() {
    return `<div class="pf-inspect-empty">
      <div class="big">◉</div>
      <p>Select a <b>table header</b> or a <b>field</b> in the graph.</p>
      <p class="dim">You'll see the column lineage and the table details — each with the exact code that builds it.</p>
    </div>`;
  }

  function openPanel(tableId, col, tab) {
    const t = PF.model.byId[tableId];
    if (!t) return;
    if (!col) col = t.columns.find((c) => PF.hl.cols.has(tableId + "." + c)) || t.columns[0];
    PF.inspect = { tableId, col, tab: tab || "column" };
    renderPanel();
    if (pfCy) {
      pfCy.nodes().unselect();
      const el = pfCy.getElementById(tableId + "." + col);
      if (el && el.length) el.select();
    }
  }

  function renderPanel() {
    const host = $("pfInspectHost");
    const ins = PF.inspect;
    if (!ins) { host.innerHTML = panelEmptyHtml(); return; }
    const t = PF.model.byId[ins.tableId];
    const kind = KIND[t.kind] || KIND.stage;
    const tabs = [["column", "Column"], ["table", "Table"]];
    host.innerHTML = `
      <div class="pf-inspect-head">
        <button class="close" id="pfPanelClose">×</button>
        <span class="pf-inspect-type" style="background:${kind.c}">${kind.label}</span>
        <h3 class="mono">${esc(ins.tab === "table" ? t.name : ins.col)}</h3>
        <div class="ds mono">${esc(t.name)}</div>
      </div>
      <div class="pf-inspect-tabs">${tabs.map(([k, l]) => `<button class="pf-inspect-tab ${k === ins.tab ? "active" : ""}" data-t="${k}">${l}</button>`).join("")}</div>
      <div class="pf-inspect-body" id="pfPanelBody"></div>`;
    $("pfPanelClose").onclick = () => { PF.inspect = null; host.innerHTML = panelEmptyHtml(); if (pfCy) pfCy.nodes().unselect(); };
    host.querySelectorAll(".pf-inspect-tab").forEach((b) => b.onclick = () => { PF.inspect.tab = b.dataset.t; renderPanel(); });
    if (ins.tab === "table") renderPanelTable(t); else renderPanelColumn(t, ins.col);
  }

  function renderPanelColumn(t, col) {
    const body = $("pfPanelBody");
    const m = PF.model;
    const key = t.id + "." + col;
    const ups = m.inAdj.get(key) || [];
    const downs = m.outAdj.get(key) || [];
    const boundary = m.tableEdges.filter((e) => e.to === t.id && e.boundary);
    const isBoundaryCol = !ups.length && boundary.length > 0;
    const isSource = !ups.length && t.kind === "source";
    let state;
    if (isBoundaryCol) state = `<span class="pf-state unresolved">◐ Grey zone — needs AI + manual</span>`;
    else if (isSource) state = `<span class="pf-state verified">◆ Source field</span>`;
    else state = `<span class="pf-state verified">✓ Resolved from code</span>`;
    const chip = (k) => `<button class="pf-io clk" data-key="${esc(k)}"><span class="mono">${esc(keyCol(k))}</span><span class="ds">${esc(tableName(keyTable(k)))}</span></button>`;
    body.innerHTML = `
      <div class="pf-sec-row">${state}${key === PF.focusKey ? `<span class="pf-chip focus">reported figure</span>` : ""}</div>
      <div class="pf-section-label">Derived from ${ups.length ? `(${ups.length})` : ""}</div>
      ${ups.length ? `<div class="pf-io-list">${ups.map(chip).join("")}</div>`
        : isBoundaryCol
          ? `<div class="pf-greybox"><b>The upstream formula is inside ${esc(tableName(t.id))}.</b> ${esc((boundary[0] || {}).reason || "")}
             <div class="pf-greyfeeds">Known table-level inputs: ${boundary.map((b) => `<span class="pf-chip">${esc(tableName(b.from))}</span>`).join(" ")}</div>
             <button class="pf-btn ai sm" id="pfColAi">✦ Resolve with AI</button><div id="pfColAiOut"></div></div>`
          : `<div class="pf-empty sm">Raw source field — no upstream in scope.</div>`}
      <div class="pf-section-label">Feeds ${downs.length ? `(${downs.length})` : ""}</div>
      ${downs.length ? `<div class="pf-io-list">${downs.map(chip).join("")}</div>` : `<div class="pf-empty sm">Nothing downstream in scope.</div>`}
      <div class="pf-section-label">Code that builds this</div>
      ${codeBlock(t.code, col)}`;
    body.querySelectorAll(".pf-io.clk").forEach((b) => b.onclick = () => { const k = b.dataset.key; openPanel(keyTable(k), keyCol(k), "column"); });
    const ai = $("pfColAi");
    if (ai) ai.onclick = () => boundaryResolveAi(boundary[0], "pfColAiOut");
  }

  function renderPanelTable(t) {
    const body = $("pfPanelBody");
    const m = PF.model;
    const upTables = [...new Set([
      ...m.columnEdges.filter((e) => keyTable(e.to) === t.id).map((e) => keyTable(e.from)),
      ...m.tableEdges.filter((e) => e.to === t.id).map((e) => e.from),
    ])].filter((x) => x !== t.id);
    const downTables = [...new Set([
      ...m.columnEdges.filter((e) => keyTable(e.from) === t.id).map((e) => keyTable(e.to)),
      ...m.tableEdges.filter((e) => e.from === t.id).map((e) => e.to),
    ])].filter((x) => x !== t.id);
    const kind = KIND[t.kind] || KIND.stage;
    const tbtn = (id) => `<button class="pf-chip clk" data-tid="${esc(id)}">${esc(tableName(id))}</button>`;
    body.innerHTML = `
      <div class="pf-kv">
        <div class="pf-kv-row"><span class="k">Type</span><span class="v"><span class="pf-type-badge" style="background:${kind.c}22;color:${kind.c}">${kind.label}</span></span></div>
        <div class="pf-kv-row"><span class="k">Layer</span><span class="v">${esc(t.group || "—")}</span></div>
        <div class="pf-kv-row"><span class="k">Columns</span><span class="v">${t.columns.length}</span></div>
      </div>
      <div class="pf-section-label">Columns — click to trace</div>
      <div class="pf-collist">${t.columns.map((c) => `<button class="pf-colrow ${PF.hl.cols.has(t.id + "." + c) ? "hot" : ""}" data-col="${esc(c)}"><span class="mono">${esc(c)}</span>${PF.hl.cols.has(t.id + "." + c) ? `<span class="pf-colrow-tag">in path</span>` : ""}</button>`).join("")}</div>
      <div class="pf-io2">
        <div><div class="pf-section-label">Upstream tables</div>${upTables.length ? `<div class="pf-chipwrap">${upTables.map(tbtn).join("")}</div>` : `<div class="pf-empty sm">None</div>`}</div>
        <div><div class="pf-section-label">Downstream tables</div>${downTables.length ? `<div class="pf-chipwrap">${downTables.map(tbtn).join("")}</div>` : `<div class="pf-empty sm">None</div>`}</div>
      </div>
      <div class="pf-section-label">Code that builds ${esc(t.name)}</div>
      ${codeBlock(t.code, null)}
      <div style="height:10px"></div>
      <button class="pf-btn sm" id="pfDlCode">⤓ Download code</button>`;
    body.querySelectorAll(".pf-colrow").forEach((b) => b.onclick = () => openPanel(t.id, b.dataset.col, "column"));
    body.querySelectorAll(".pf-chip.clk").forEach((b) => b.onclick = () => openPanel(b.dataset.tid, null, "table"));
    const dl = $("pfDlCode");
    if (dl) dl.onclick = () => downloadCode(t.code);
  }

  // --------------------------------------------------------- code display
  function highlight(line, lang) {
    let s = esc(line);
    s = s.replace(/(--.*$|#.*$|\/\/.*$|\/\*.*?\*\/)/g, '<span class="pf-tok-com">$1</span>');
    s = s.replace(/(&#39;[^&]*?&#39;|&quot;[^&]*?&quot;)/g, '<span class="pf-tok-str">$1</span>');
    s = s.replace(/\b(\d+\.?\d*)\b/g, '<span class="pf-tok-num">$1</span>');
    const kw = /\b(CREATE|TABLE|VIEW|AS|SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|CROSS|FULL|OUTER|ON|GROUP|ORDER|BY|HAVING|SUM|COUNT|AVG|MIN|MAX|ROUND|COALESCE|NULLIF|CASE|WHEN|THEN|ELSE|END|DECIMAL|PRIMARY|KEY|data|set|run|proc|sql|quit|into|merge|if|then|else|def|import|return|groupby|agg|mean|size)\b/gi;
    s = s.replace(kw, '<span class="pf-tok-kw">$1</span>');
    s = s.replace(/(%\w+)/g, '<span class="pf-tok-mac">$1</span>');
    return s;
  }

  function codeBlock(code, hotCol) {
    if (!code || !code.text) return `<div class="pf-empty sm">No code captured for this node.</div>`;
    const lines = String(code.text).split("\n");
    const start = code.line_start || 1;
    const hot = hotCol ? String(hotCol).toLowerCase() : null;
    return `
      <div class="pf-code-wrap">
        <div class="pf-codehead"><span class="mono">${esc(code.file || "")}</span><span class="pf-lg">${esc(LANG_LABEL[code.lang] || code.lang || "")}</span></div>
        <pre class="pf-code">${lines.map((ln, i) => {
          const isHot = hot && ln.toLowerCase().includes(hot);
          return `<div class="ln ${isHot ? "hot" : ""}"><span class="no">${start + i}</span><span class="tx">${highlight(ln, code.lang)}</span></div>`;
        }).join("")}</pre>
      </div>`;
  }

  function downloadCode(code) {
    if (!code) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([code.text || ""], { type: "text/plain" }));
    a.download = (code.file || "code.txt").split(/[ ·]/)[0] || "code.txt";
    a.click();
  }

  // ------------------------------------------------- grey-zone AI resolve
  async function boundaryResolveAi(bEdge, outId) {
    const out = $(outId);
    if (out) out.innerHTML = `<div class="pf-ai-run"><span class="pf-spin"></span> Reading the code and reconstructing the field formula…</div>`;
    try {
      if (!PF.aiProposals) {
        const res = await fetch("/api/agent/review", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ result: PF.result }),
        });
        if (res.status === 401 || res.status === 403) { if (out) out.innerHTML = `<div class="pf-ai-warn">AI review needs the server <code>GROQ_API_KEY</code> to be configured.</div>`; return; }
        const data = await res.json();
        PF.aiProposals = data.proposals || [];
      }
      const tgt = bEdge ? String(tableName(bEdge.to)).toLowerCase() : "";
      const prop = (PF.aiProposals || []).find((p) => (p.proposed_target || "").toLowerCase().includes(tgt.split(".").pop()))
        || (PF.aiProposals || [])[0];
      if (!prop) { if (out) out.innerHTML = `<div class="pf-ai-warn">The AI reviewer did not return a confident reconstruction.</div>`; return; }
      if (out) out.innerHTML = aiResultHtml(prop);
    } catch (e) {
      if (out) out.innerHTML = `<div class="pf-ai-warn">AI resolve failed: ${esc(e.message || e)}</div>`;
    }
  }

  function aiResultHtml(p) {
    const ins = (p.proposed_inputs || []).join(", ");
    const cols = (p.columns || []).slice(0, 8).join(", ");
    return `<div class="pf-ai-result">
      <span class="pf-ai-badge">✦ AI-inferred · ${Math.round((p.confidence || 0) * 100)}%</span>
      <div class="pf-ai-flow">${esc(ins || "inputs")} &nbsp;→&nbsp; <b>${esc(p.proposed_target || "")}</b></div>
      ${cols ? `<div class="pf-ai-cols">Fields: <span class="mono">${esc(cols)}</span></div>` : ""}
      <div class="pf-ai-rat">${esc(p.rationale || "")}</div>
    </div>`;
  }

  // =====================================================================
  //  Step breadcrumb
  // =====================================================================
  function renderStepbar() {
    const bar = $("pfStepbar");
    if (PF.step === "reports") { bar.hidden = true; return; }
    bar.hidden = false;
    const steps = [
      { k: "reports", n: 1, label: "Reports" },
      { k: "report", n: 2, label: (PF.pack && PF.pack.report && PF.pack.report.name) || "Report" },
      { k: "lineage", n: 3, label: "Lineage" },
    ];
    const order = ["reports", "report", "lineage"];
    const cur = order.indexOf(PF.step);
    bar.innerHTML = steps.map((s, i) => {
      const idx = order.indexOf(s.k);
      const cls = idx < cur ? "done clickable" : idx === cur ? "active" : "";
      return `<span class="pf-crumb ${cls}" data-step="${s.k}"><b>${idx < cur ? "✓" : s.n}</b>${esc(s.label)}</span>${i < steps.length - 1 ? `<span class="pf-crumb-sep">›</span>` : ""}`;
    }).join("");
    bar.querySelectorAll(".pf-crumb.clickable").forEach((c) => c.onclick = () => goStep(c.dataset.step));
  }
  function goStep(step) {
    if (step === "reports") return renderReports();
    if (step === "report") return renderReport();
    if (step === "lineage") return renderLineage();
  }

  // =====================================================================
  //  Navigation / wiring
  // =====================================================================
  function openExplorer() {
    // Jump into the legacy dark workspace for the loaded batch (technical layer)
    if (PF.batch && window.loadBatch) {
      $("platform").hidden = true;
      window.loadBatch(PF.batch);
    } else {
      renderReports();
    }
  }

  function wire() {
    $("pfTheme").onclick = () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
    $("pfBrand").onclick = () => renderReports();
    document.querySelectorAll("#pfSideNav .pf-side-item[data-nav]").forEach((b) => b.onclick = () => {
      const nav = b.dataset.nav;
      document.querySelectorAll("#pfSideNav .pf-side-item").forEach((x) => x.classList.toggle("active", x === b));
      if (nav === "reports") renderReports();
      else if (nav === "explorer") openExplorer();
    });
    const search = $("pfSearch");
    if (search) search.onkeydown = (e) => {
      if (e.key === "Enter" && PF.step === "reports") {
        const q = e.target.value.toLowerCase().trim();
        const hit = (PF.reports || []).find((r) => (r.name + r.domain + r.framework).toLowerCase().includes(q));
        if (hit) openReport(hit.batch);
      }
    };

    // When the user reaches the legacy dark workspace via "Lineage Explorer",
    // let the brand take them back to the platform (the primary experience).
    const brandWs = $("brandWs");
    if (brandWs) brandWs.onclick = () => window.pfBackToPlatform();
  }

  // Expose a hook so the legacy "back to platform" works from the dark workspace.
  window.pfBackToPlatform = function () {
    $("home").hidden = true; $("workspace").hidden = true; $("platform").hidden = false;
    document.querySelectorAll("#pfSideNav .pf-side-item").forEach((x) => x.classList.toggle("active", x.dataset.nav === "reports"));
    renderReports();
  };

  // ------------------------------------------------------------------ Boot
  function boot() {
    initTheme();
    pfShow();
    wire();
    loadReports();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
