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
      <div class="pf-report-grid" id="pfReportGrid"></div>`;

    const grid = $("pfReportGrid");
    if (!shown.length) {
      grid.innerHTML = `<div class="pf-empty"><div class="big">▣</div>No reports match these filters.</div>`;
    } else {
      grid.innerHTML = shown.map((r) => `
        <div class="pf-rcard" data-batch="${esc(r.batch)}">
          <div class="pf-rcard-top">
            <span class="pf-domain-tag ${domainClass(r.domain)}">${esc(r.domain || "Report")}</span>
            <span class="pf-rcard-cdes"><b>${r.cde_count}</b> CDEs</span>
          </div>
          <h3>${esc(r.name)}</h3>
          <div class="fw">${esc(r.framework || "")}</div>
          <p>${esc(r.description || "")}</p>
          <div class="pf-rcard-meta">
            <div><span class="k">Owner</span><span class="v">${esc(r.owner || "—")}</span></div>
            <div><span class="k">Frequency</span><span class="v">${esc(r.frequency || "—")}</span></div>
            <div><span class="k">Version</span><span class="v">${esc(r.version || "—")}</span></div>
            <div><span class="k">Last updated</span><span class="v">${esc(r.last_updated || "—")}</span></div>
          </div>
          <div class="pf-rcard-foot">
            <div class="pf-rcard-langs">${(r.languages || []).map((l) => `<span class="pf-lg ${l}">${esc(l)}</span>`).join("")}</div>
            <span class="pf-rcard-cdes">${r.files} files · ${r.lines} lines</span>
          </div>
        </div>`).join("");
      grid.querySelectorAll(".pf-rcard").forEach((c) =>
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
    if (t) t.onclick = () => startResolve();
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
  //  Screen 3 · Resolve the starting point
  // =====================================================================
  function startResolve() {
    const c = PF.cde;
    const cands = (c && c.candidates) || [];
    PF.resolvePick = cands.findIndex((x) => x.recommended);
    if (PF.resolvePick < 0) PF.resolvePick = 0;
    renderResolve();
  }

  function renderResolve() {
    setStep("resolve");
    const c = PF.cde;
    const cands = (c && c.candidates) || [];
    const main = $("pfMain");
    main.className = "pf-main";
    main.innerHTML = `
      <div class="pf-resolve-head">
        <h2>Resolve the starting point</h2>
        <p>The code produces several datasets that could be the source of
           <b>${esc(c.business_name)}</b>. Confirm which output is the published figure so the
           upstream trace starts from the right place. Each option carries the code evidence that supports it.</p>
      </div>
      <div class="pf-card"><div class="pf-table-wrap"><table class="pf-cand-table" id="pfCandTable">
        <thead><tr><th></th><th>Dataset / Table</th><th>Column</th><th>Job / Process</th><th>Last updated</th><th>Confidence</th><th></th></tr></thead>
        <tbody>${cands.map((cd, i) => {
          const pct = Math.round((cd.confidence || 0) * 100);
          const lvl = pct >= 80 ? "high" : pct >= 55 ? "medium" : "low";
          return `<tr data-i="${i}" class="${i === PF.resolvePick ? "sel" : ""}">
            <td><span class="pf-radio"></span></td>
            <td class="pf-mono">${esc(dsName(cd.dataset))}${cd.recommended ? `<span class="pf-rec-pill">recommended</span>` : ""}</td>
            <td class="pf-mono">${esc(cd.column)}</td>
            <td class="pf-mono" style="font-size:11.5px">${esc(cd.job || "—")}</td>
            <td>${esc(cd.last_updated || "—")}</td>
            <td><div class="pf-conf"><div class="pf-conf-bar"><div class="pf-conf-fill ${lvl}" style="width:${pct}%"></div></div><span class="pf-conf-val">${pct}%</span></div></td>
            <td><button class="pf-eye" data-eye="${i}" title="Show evidence">👁</button></td></tr>`;
        }).join("")}</tbody>
      </table></div></div>
      <div id="pfEvidence"></div>
      <div class="pf-resolve-foot">
        <button class="pf-btn" id="pfResolveBack">← Back to report</button>
        <button class="pf-btn primary" id="pfConfirm">Confirm &amp; Trace Upstream →</button>
      </div>`;

    main.querySelectorAll("#pfCandTable tbody tr").forEach((tr) =>
      tr.onclick = () => { PF.resolvePick = +tr.dataset.i; renderResolve(); });
    main.querySelectorAll("[data-eye]").forEach((b) =>
      b.onclick = (e) => { e.stopPropagation(); PF.resolvePick = +b.dataset.eye; renderResolve(); });
    $("pfResolveBack").onclick = () => renderReport();
    $("pfConfirm").onclick = () => {
      const cd = cands[PF.resolvePick];
      PF.source = { dataset: cd.dataset, column: cd.column };
      PF.lineageTab = "graph";
      renderLineage();
    };
    renderEvidence();
  }

  function renderEvidence() {
    const c = PF.cde;
    const cd = (c.candidates || [])[PF.resolvePick];
    const box = $("pfEvidence");
    if (!cd) { box.innerHTML = ""; return; }
    const op = opFor(cd.dataset);
    box.innerHTML = `
      <div class="pf-evidence">
        <div class="pf-evidence-head">
          <h4>Evidence for ${esc(dsName(cd.dataset))}.${esc(cd.column)}</h4>
          <div class="pf-ev-meta">${op ? `<span>File <b>${esc(op.file)}</b></span><span>Lines <b>${lineRange(op)}</b></span><span>Language <b>${LANG_LABEL[op.language] || op.language}</b></span>` : `<span>Source dataset — no producing code in scope</span>`}</div>
        </div>
        <div style="padding:12px 16px; font-size:12.5px; color:var(--pf-text-dim)">${esc(cd.why || "")}</div>
        ${op ? codeBlock(op, cd.column) : ""}
      </div>`;
  }

  // =====================================================================
  //  Shared · code block with line numbers + light syntax highlight
  // =====================================================================
  function highlight(line, lang) {
    let s = esc(line);
    // comments
    s = s.replace(/(--.*$|\/\*.*?\*\/|#.*$)/g, '<span class="pf-tok-com">$1</span>');
    // strings (single quotes are already HTML-escaped to &#39; by esc())
    s = s.replace(/(&#39;[^&]*&#39;)/g, '<span class="pf-tok-str">$1</span>');
    // numbers
    s = s.replace(/\b(\d+\.?\d*)\b/g, '<span class="pf-tok-num">$1</span>');
    // keywords
    const kw = /\b(CREATE|TABLE|AS|SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|CROSS|GROUP|BY|ORDER|SUM|COUNT|AVG|COALESCE|NULLIF|CASE|WHEN|THEN|ELSE|END|data|set|run|proc|sql|quit|into|if|def|import|return|groupby|agg)\b/gi;
    s = s.replace(kw, '<span class="pf-tok-kw">$1</span>');
    return s;
  }
  function codeBlock(op, hotCol) {
    const lines = String(op.snippet || "").split("\n");
    const start = op.line_start || 1;
    const hot = hotCol ? String(hotCol).toLowerCase() : null;
    return `<pre class="pf-code">${lines.map((ln, i) => {
      const isHot = hot && ln.toLowerCase().includes(hot);
      return `<div class="ln ${isHot ? "hot" : ""}"><span class="no">${start + i}</span><span class="tx">${highlight(ln, op.language)}</span></div>`;
    }).join("")}</pre>`;
  }

  // =====================================================================
  //  Screen 4 · Interactive upstream lineage
  // =====================================================================
  function renderLineage() {
    setStep("lineage");
    PF.lineage = buildLineage(PF.source.dataset, PF.source.column);
    const meta = (PF.pack && PF.pack.report) || {};
    $("pfTopTitle").innerHTML = `Lineage · ${esc(PF.cde.business_name)}<span>${esc(meta.name || "")}</span>`;
    const main = $("pfMain");
    main.className = "pf-main flush";

    const stats = coverageStats(PF.lineage);
    const tabs = [["graph", "Graph View"], ["table", "Table View"], ["formula", "Formula View"], ["impact", "Impact View"]];
    main.innerHTML = `
      <div class="pf-lineage-bar">
        <h2>Upstream lineage — <span class="mono">${esc(PF.cde.business_name)}</span></h2>
        <div class="pf-tabs" id="pfLineageTabs" style="background:var(--pf-surface-2)">
          ${tabs.map(([k, l]) => `<button class="pf-tab ${k === PF.lineageTab ? "active" : ""}" data-t="${k}">${l}</button>`).join("")}
        </div>
        <div class="pf-top-spacer"></div>
        <span class="pf-state ${stats.unresolved ? "unresolved" : "verified"}">${stats.verified} verified · ${stats.unresolved} unresolved</span>
        <button class="pf-btn sm" id="pfExpandAll">Expand All</button>
        <button class="pf-btn sm" id="pfExport">Export</button>
      </div>
      <div class="pf-lineage-main">
        <div class="pf-graph-wrap" id="pfGraphWrap"><div id="pfGraph"></div></div>
        <div class="pf-view" id="pfLineageView" hidden></div>
        <div id="pfInspectHost"></div>
      </div>
      <div class="pf-legend">
        <span><i class="report"></i>Report Field</span>
        <span><i class="calc"></i>Calculated Field</span>
        <span><i class="table"></i>Table / Dataset</span>
        <span><i class="code"></i>Code / Process</span>
        <span><i class="source"></i>Source Field</span>
      </div>`;

    main.querySelectorAll("#pfLineageTabs .pf-tab").forEach((t) =>
      t.onclick = () => { PF.lineageTab = t.dataset.t; renderLineage(); });
    $("pfExpandAll").onclick = () => pfCy && pfCy.fit(undefined, 40);
    $("pfExport").onclick = () => exportLineage();

    const graphWrap = $("pfGraphWrap");
    const view = $("pfLineageView");
    if (PF.lineageTab === "graph") {
      graphWrap.hidden = false; view.hidden = true;
      requestAnimationFrame(drawGraph);
    } else {
      graphWrap.hidden = true; view.hidden = false;
      if (pfCy) { pfCy.destroy(); pfCy = null; }
      if (PF.lineageTab === "table") renderTableView(view);
      if (PF.lineageTab === "formula") renderFormulaView(view);
      if (PF.lineageTab === "impact") renderImpactView(view);
    }
  }

  function coverageStats(lin) {
    let verified = 0, unresolved = 0;
    lin.nodes.forEach((n) => { if (n.role === "boundary" && !n.aiInferred) unresolved++; else verified++; });
    return { verified, unresolved };
  }

  function nodeType(n) {
    if (n.role === "report") return "report";
    if (n.role === "boundary") return "code";
    if (n.role === "source") return "source";
    return "calc";
  }

  function drawGraph() {
    const lin = PF.lineage;
    if (pfCy) { pfCy.destroy(); pfCy = null; }
    const els = [];
    lin.nodes.forEach((n) => {
      const ty = nodeType(n);
      els.push({ data: {
        id: n.key, label: n.col, ds: dsName(n.dsId), ty,
        unresolved: n.role === "boundary" && !n.aiInferred ? 1 : 0,
      } });
    });
    lin.edges.forEach((e, i) => els.push({ data: { id: "e" + i, source: e.from, target: e.to } }));

    const nodeW = (lbl) => {
      const longest = String(lbl).split("\n").reduce((m, l) => Math.max(m, l.length), 0);
      return Math.max(96, Math.min(188, longest * 7 + 30));
    };
    const nodeH = (lbl) => 26 + String(lbl).split("\n").length * 16;

    pfCy = cytoscape({
      container: $("pfGraph"),
      elements: els,
      style: [
        { selector: "node", style: {
          "shape": "round-rectangle",
          "background-color": (n) => NTYPE[n.data("ty")].c,
          "border-width": 0,
          "label": (n) => n.data("label") + "\n" + n.data("ds"),
          "color": "#fff", "font-size": 11, "font-weight": 600, "line-height": 1.3,
          "text-valign": "center", "text-halign": "center", "text-wrap": "wrap",
          "text-max-width": 168,
          "width": (n) => nodeW(n.data("label") + "\n" + n.data("ds")),
          "height": (n) => nodeH(n.data("label") + "\n" + n.data("ds")),
          "padding": 6,
        } },
        { selector: "node[unresolved = 1]", style: {
          "border-width": 3, "border-color": "#ffffff", "border-style": "dashed" } },
        { selector: "node:selected", style: { "border-width": 3, "border-color": "#0f1b2d" } },
        { selector: "edge", style: {
          "width": 2, "line-color": "#9aa7b8", "target-arrow-color": "#9aa7b8",
          "target-arrow-shape": "triangle", "curve-style": "bezier", "arrow-scale": 1, "opacity": 0.85 } },
      ],
      layout: { name: "dagre", rankDir: "LR", nodeSep: 26, rankSep: 90, padding: 36 },
      wheelSensitivity: 0.2,
    });
    pfCy.on("tap", "node", (evt) => openInspector(evt.target.data("id")));
    pfCy.ready(() => pfCy.fit(undefined, 40));
  }

  function exportLineage() {
    const rows = [["field", "dataset", "role", "produced_by", "file", "lines", "state"]];
    PF.lineage.nodes.forEach((n) => rows.push([
      n.col, dsName(n.dsId), nodeType(n),
      n.op ? (n.op.language + ":" + n.op.kind) : "source",
      n.op ? n.op.file : "", n.op ? n.op.line_start + "-" + n.op.line_end : "",
      n.role === "boundary" ? (n.aiInferred ? "inferred" : "unresolved") : "verified",
    ]));
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = "lineage_" + (PF.cde.id || "cde") + ".csv";
    a.click();
  }

  function stateTag(n) {
    if (n.role === "boundary") return n.aiInferred
      ? `<span class="pf-state inferred">◆ AI-inferred</span>`
      : `<span class="pf-state unresolved">✕ Unresolved</span>`;
    if (n.role === "report" || n.role === "source") return `<span class="pf-state verified">✓ Verified</span>`;
    return `<span class="pf-state verified">✓ Verified</span>`;
  }

  function renderTableView(view) {
    const lin = PF.lineage;
    view.innerHTML = `<div class="pf-card"><div class="pf-table-wrap"><table class="pf-hop-table">
      <thead><tr><th>Field</th><th>Dataset</th><th>Node type</th><th>Transformation</th><th>Evidence</th><th>Coverage</th></tr></thead>
      <tbody>${lin.order.map((k) => {
        const n = lin.nodes.get(k);
        const ty = nodeType(n);
        return `<tr data-key="${esc(k)}" style="cursor:pointer">
          <td class="pf-mono" style="color:var(--pf-text);font-weight:600">${esc(n.col)}</td>
          <td class="pf-mono">${esc(dsName(n.dsId))}</td>
          <td><span class="pf-dot" style="background:${NTYPE[ty].c}"></span>${NTYPE[ty].label}</td>
          <td>${n.op ? `${LANG_LABEL[n.op.language] || n.op.language} · ${esc(n.op.kind)}` : "raw source"}</td>
          <td class="pf-mono" style="font-size:11.5px">${n.op ? fileLoc(n.op) : "—"}</td>
          <td>${stateTag(n)}</td></tr>`;
      }).join("")}</tbody></table></div></div>`;
    view.querySelectorAll("[data-key]").forEach((r) => r.onclick = () => openInspector(r.dataset.key));
  }

  function renderFormulaView(view) {
    const lin = PF.lineage;
    const derived = lin.order.map((k) => lin.nodes.get(k)).filter((n) => n.role === "report" || n.role === "calc" || n.role === "boundary");
    view.innerHTML = `<div class="pf-formula">${derived.map((n) => {
      if (n.role === "boundary") {
        return `<div class="pf-fcard"><div class="pf-fcard-head"><span class="pf-dot" style="background:${NTYPE.code.c}"></span><span class="mono">${esc(n.col)}</span>${stateTag(n)}</div>
          <div class="pf-fexpr" style="color:var(--pf-muted)">Computed inside ${LANG_LABEL[n.op ? n.op.language : ""] || "code"} — the static parser cannot read this formula. Open the node and resolve it with AI to recover the expression.</div></div>`;
      }
      const srcs = (n.sources || []).map((s) => { const sp = splitCol(s); return sp.col; });
      return `<div class="pf-fcard"><div class="pf-fcard-head"><span class="pf-dot" style="background:${NTYPE[nodeType(n)].c}"></span><span class="mono">${esc(n.col)}</span>${n.op ? `<span class="pf-chip">${LANG_LABEL[n.op.language] || n.op.language}</span>` : ""}</div>
        <div class="pf-fexpr"><span class="op">${esc(n.col)}</span> = ${srcs.map((s) => `<span class="src">${esc(s)}</span>`).join(" <span class='op'>·</span> ") || "—"}</div>
        ${n.op ? codeBlock(n.op, n.col) : ""}
      </div>`;
    }).join("")}</div>`;
  }

  function renderImpactView(view) {
    // Downstream of the deepest resolvable source field feeding this CDE.
    const lin = PF.lineage;
    // Upstream-most fields = nodes that never feed anything further upstream.
    const fromSet = new Set(lin.edges.map((e) => e.from));
    const leaves = lin.order.map((k) => lin.nodes.get(k)).filter((n) => !fromSet.has(n.key));
    const seed = leaves[0] || lin.nodes.get(lin.order[lin.order.length - 1]);
    const chooser = leaves.map((n) => `<button class="pf-chip" style="cursor:pointer;padding:6px 11px" data-k="${esc(n.key)}">${esc(n.col)} <span style="color:var(--pf-muted-2)">· ${esc(dsName(n.dsId))}</span></button>`).join("");
    const chain = buildDownstream(seed.dsId, seed.col);
    const reports = PF.reports || [];
    view.innerHTML = `
      <div class="pf-resolve-head"><h2>Downstream impact</h2>
        <p>If this source field changes, everything below is affected — up to the reported CDE and the regulatory submission it feeds.</p></div>
      <div style="margin-bottom:14px"><div class="pf-section-label">Pick a source field</div><div style="display:flex;flex-wrap:wrap;gap:8px">${chooser}</div></div>
      <div class="pf-card"><div class="pf-card-head"><div><h3>${esc(seed.col)}</h3><div class="sub">${esc(dsName(seed.dsId))} — feeds ${chain.length} downstream field(s)</div></div></div>
      <div class="pf-table-wrap"><table class="pf-hop-table"><thead><tr><th>Affected field</th><th>Dataset</th><th>Produced by</th></tr></thead>
      <tbody>${chain.map((h) => `<tr><td class="pf-mono" style="color:var(--pf-text);font-weight:600">${esc(h.col)}</td><td class="pf-mono">${esc(dsName(h.ds))}</td><td>${h.op ? (LANG_LABEL[h.op.language] || h.op.language) + " · " + esc(h.op.kind) : "—"}</td></tr>`).join("") || `<tr><td colspan="3" style="color:var(--pf-muted)">No downstream fields in scope.</td></tr>`}</tbody></table></div>
      <div style="padding:14px 18px;border-top:1px solid var(--pf-border);font-size:12.5px;color:var(--pf-text-dim)">
        <span class="pf-state verified">Reported CDE</span> &nbsp; <b>${esc(PF.cde.business_name)}</b> in <b>${esc((PF.pack.report || {}).name || "")}</b>
      </div></div>`;
    view.querySelectorAll("[data-k]").forEach((b) => b.onclick = () => {
      const n = lin.nodes.get(b.dataset.k);
      const chain2 = buildDownstream(n.dsId, n.col);
      renderImpactFor(view, n, chain2);
    });
  }

  function renderImpactFor(view, n, chain) {
    const card = view.querySelector(".pf-card");
    card.querySelector(".pf-card-head h3").textContent = n.col;
    card.querySelector(".pf-card-head .sub").textContent = dsName(n.dsId) + " — feeds " + chain.length + " downstream field(s)";
    card.querySelector("tbody").innerHTML = chain.map((h) => `<tr><td class="pf-mono" style="color:var(--pf-text);font-weight:600">${esc(h.col)}</td><td class="pf-mono">${esc(dsName(h.ds))}</td><td>${h.op ? (LANG_LABEL[h.op.language] || h.op.language) + " · " + esc(h.op.kind) : "—"}</td></tr>`).join("") || `<tr><td colspan="3" style="color:var(--pf-muted)">No downstream fields in scope.</td></tr>`;
  }

  // =====================================================================
  //  Screens 5 & 6 · Node inspector (overview / code / inputs / outputs)
  // =====================================================================
  function openInspector(key, tab) {
    const n = PF.lineage.nodes.get(key);
    if (!n) return;
    PF.inspectKey = key;
    PF.inspectTab = tab || "overview";
    renderInspector();
    if (pfCy) { pfCy.nodes().unselect(); const el = pfCy.getElementById(key); if (el) el.select(); }
  }

  function renderInspector() {
    const host = $("pfInspectHost");
    const n = PF.lineage.nodes.get(PF.inspectKey);
    if (!n) { host.innerHTML = ""; return; }
    const ty = nodeType(n);
    const tabs = [["overview", "Overview"], ["code", "Code"], ["inputs", "Inputs"], ["outputs", "Outputs"]];
    host.innerHTML = `
      <aside class="pf-inspect">
        <div class="pf-inspect-head">
          <button class="close" id="pfInspectClose">×</button>
          <span class="pf-inspect-type" style="background:${NTYPE[ty].c}">${NTYPE[ty].label}</span>
          <h3>${esc(n.col)}</h3>
          <div class="ds">${esc(dsName(n.dsId))}</div>
        </div>
        <div class="pf-inspect-tabs">${tabs.map(([k, l]) => `<button class="pf-inspect-tab ${k === PF.inspectTab ? "active" : ""}" data-t="${k}">${l}</button>`).join("")}</div>
        <div class="pf-inspect-body" id="pfInspectBody"></div>
      </aside>`;
    $("pfInspectClose").onclick = () => { host.innerHTML = ""; if (pfCy) pfCy.nodes().unselect(); };
    host.querySelectorAll(".pf-inspect-tab").forEach((t) => t.onclick = () => { PF.inspectTab = t.dataset.t; renderInspector(); });
    renderInspectBody(n);
  }

  function renderInspectBody(n) {
    const body = $("pfInspectBody");
    const op = n.op;
    if (PF.inspectTab === "code") {
      if (!op) { body.innerHTML = `<div class="pf-empty">This is a raw source field — no producing code in scope.</div>`; return; }
      body.innerHTML = `
        <div class="pf-section-label">Code details</div>
        <div class="pf-kv" style="margin-bottom:16px">
          <div class="pf-kv-row"><span class="k">File</span><span class="v mono">${esc(op.file)}</span></div>
          <div class="pf-kv-row"><span class="k">Lines</span><span class="v">${lineRange(op)}</span></div>
          <div class="pf-kv-row"><span class="k">Language</span><span class="v">${LANG_LABEL[op.language] || op.language}</span></div>
          <div class="pf-kv-row"><span class="k">Operation</span><span class="v">${esc(op.kind)}</span></div>
          <div class="pf-kv-row"><span class="k">Confidence</span><span class="v">${esc(op.confidence)}</span></div>
        </div>
        ${codeBlock(op, n.col)}
        <div style="height:12px"></div>
        <button class="pf-btn sm" id="pfDownload">⤓ Download file</button>`;
      const d = $("pfDownload");
      if (d) d.onclick = () => downloadSource(op);
      return;
    }
    if (PF.inspectTab === "inputs") {
      const srcs = n.sources || [];
      body.innerHTML = `<div class="pf-section-label">Input fields (${srcs.length})</div><div class="pf-io-list">${srcs.map((s) => { const sp = splitCol(s); return `<div class="pf-io"><span class="mono">${esc(sp.col)}</span><span class="ds">${esc(sp.ds ? dsName(sp.ds) : "")}</span></div>`; }).join("") || `<div class="pf-empty" style="padding:24px">No resolved inputs — this is a boundary or a raw source.</div>`}</div>`;
      return;
    }
    if (PF.inspectTab === "outputs") {
      const outs = op ? (op.columns || []) : [];
      body.innerHTML = `<div class="pf-section-label">Output columns of ${esc(dsName(n.dsId))} (${outs.length})</div><div class="pf-io-list">${outs.map((o) => `<div class="pf-io"><span class="mono">${esc(o)}</span></div>`).join("") || `<div class="pf-empty" style="padding:24px">No output projection captured.</div>`}</div>`;
      return;
    }
    // overview
    let logic = "";
    if (n.role === "report") logic = "The reported figure published to the regulatory template.";
    else if (n.role === "source") logic = "A raw source field read directly from the system of record.";
    else if (n.role === "boundary") logic = "Produced inside a " + (LANG_LABEL[op ? op.language : ""] || "code") + " step the static parser can only resolve at table level.";
    else logic = "A derived field calculated from upstream inputs.";
    body.innerHTML = `
      <div class="pf-section-label">Business logic</div>
      <p style="font-size:13px;line-height:1.55;color:var(--pf-text-dim);margin:0 0 16px">${esc(logic)}</p>
      <div class="pf-section-label">Transformation</div>
      <div class="pf-kv" style="margin-bottom:16px">
        <div class="pf-kv-row"><span class="k">Type</span><span class="v">${NTYPE[nodeType(n)].label}</span></div>
        <div class="pf-kv-row"><span class="k">Implemented in</span><span class="v mono">${op ? esc(op.file) : "—"}</span></div>
        <div class="pf-kv-row"><span class="k">Coverage</span><span class="v">${stateTag(n)}</span></div>
      </div>
      ${n.sources && n.sources.length ? `<div class="pf-section-label">Derived from</div><div class="pf-io-list">${n.sources.map((s) => { const sp = splitCol(s); return `<div class="pf-io"><span class="mono">${esc(sp.col)}</span><span class="ds">${esc(sp.ds ? dsName(sp.ds) : "")}</span></div>`; }).join("")}</div>` : ""}
      ${n.role === "boundary" ? aiBoxHtml(n) : ""}`;
    if (n.role === "boundary") wireAiBox(n);
  }

  function downloadSource(op) {
    // We only have the op snippet client-side; download that as the evidence slice.
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([op.snippet || ""], { type: "text/plain" }));
    a.download = op.file || "evidence.txt";
    a.click();
  }

  // =====================================================================
  //  AI resolve for an unresolved (boundary) node
  // =====================================================================
  function aiBoxHtml(n) {
    if (n.aiInferred && n.aiProposal) return aiResultHtml(n.aiProposal);
    return `
      <div class="pf-ai-box" id="pfAiBox">
        <h4>✦ Unresolved cross-language boundary</h4>
        <p>The field-level trace stops here because this value is computed in ${LANG_LABEL[n.op ? n.op.language : ""] || "code"}.
           Let the AI reviewer read the code and recover the formula and its contributing fields.</p>
        <button class="pf-btn ai" id="pfAiRun">✦ Resolve with AI</button>
        <div id="pfAiOut"></div>
      </div>`;
  }
  function wireAiBox(n) {
    const run = $("pfAiRun");
    if (run) run.onclick = () => resolveWithAi(n);
  }
  async function resolveWithAi(n) {
    const out = $("pfAiOut");
    out.innerHTML = `<div style="margin-top:12px;color:var(--pf-text-dim);font-size:12.5px"><span class="pf-spin"></span> Reading the code and reconstructing lineage…</div>`;
    try {
      if (!PF.aiProposals) {
        const res = await fetch("/api/agent/review", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ result: PF.result }),
        });
        if (res.status === 401 || res.status === 403) { out.innerHTML = `<div class="pf-ai-warn">AI review needs the server GROQ_API_KEY to be configured.</div>`; return; }
        const data = await res.json();
        PF.aiProposals = data.proposals || [];
      }
      // match a proposal to the op that produces this boundary dataset
      const op = opFor(n.dsId);
      const prop = (PF.aiProposals || []).find((p) => p.op_id === (op && op.id)) ||
        (PF.aiProposals || []).find((p) => (p.proposed_target || "").includes(n.dsId));
      if (!prop) { out.innerHTML = `<div class="pf-ai-warn">The AI reviewer did not return a confident reconstruction for this step.</div>`; return; }
      n.aiInferred = true; n.aiProposal = prop;
      out.innerHTML = aiResultHtml(prop);
      if (pfCy) { const el = pfCy.getElementById(n.key); if (el) el.data("unresolved", 0); }
      const s = coverageStats(PF.lineage);
      const badge = document.querySelector(".pf-lineage-bar .pf-state");
      if (badge) { badge.textContent = s.verified + " verified · " + s.unresolved + " unresolved"; badge.className = "pf-state " + (s.unresolved ? "unresolved" : "verified"); }
    } catch (e) {
      out.innerHTML = `<div class="pf-ai-warn">AI resolve failed: ${esc(e.message || e)}</div>`;
    }
  }
  function aiResultHtml(p) {
    const ins = (p.proposed_inputs || []).join(", ");
    const cols = (p.columns || []).slice(0, 8).join(", ");
    return `
      <div class="pf-ai-result">
        <span class="pf-ai-badge">✦ AI-inferred · ${Math.round((p.confidence || 0) * 100)}% confidence</span>
        <div class="pf-ai-flow">${esc(ins || "inputs")} &nbsp;→&nbsp; <b>${esc(p.proposed_target || "")}</b></div>
        ${cols ? `<div style="font-size:12px;color:var(--pf-muted);margin-bottom:8px">Fields: <span class="pf-mono">${esc(cols)}</span></div>` : ""}
        <div class="pf-ai-rat">${esc(p.rationale || "")}</div>
        ${(p.assumptions || []).length ? `<div style="font-size:11.5px;color:var(--pf-muted)">Assumptions: ${esc((p.assumptions || []).join("; "))}</div>` : ""}
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
      { k: "resolve", n: 3, label: "Resolve source" },
      { k: "lineage", n: 4, label: "Lineage" },
    ];
    const order = ["reports", "report", "resolve", "lineage"];
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
    if (step === "resolve") return renderResolve();
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
