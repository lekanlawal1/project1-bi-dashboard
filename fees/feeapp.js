/* Card fees tab: read a processor statement PDF with pdf.js (in the browser), then show what
   statement.js read and what check.js found. Also runs the two tabs, the quick check and the
   comparison with the margins tab when both have a file. Nothing is uploaded anywhere. */

(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const K = FeeCheck, usd = K.usd;
  const usd0 = (c) => `$${Math.round(Math.abs(c) / 100).toLocaleString("en-US")}`;
  const pct = (x, d = 2) => (x == null ? "n/a" : `${(x * 100).toFixed(d)}%`);
  const rate = (p, f) => `${p.toFixed(2)}%${f ? ` + $${f.toFixed(2)}` : ""}`;
  const status = (msg, bad = false) => { $("fee-status").textContent = msg; $("fee-status").classList.toggle("bad", bad); };
  const monthName = (iso) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

  // ------------------------------------------------------------------ tabs
  const tabs = [["margin", $("tab-margin"), $("pane-margin")], ["fees", $("tab-fees"), $("pane-fees")]];
  function show(name, focus) {
    for (const [n, tab, pane] of tabs) {
      const on = n === name;
      tab.setAttribute("aria-selected", on); tab.tabIndex = on ? 0 : -1; pane.hidden = !on;
      if (on && focus) tab.focus();
    }
    history.replaceState(null, "", name === "fees" ? "#fees" : location.pathname + location.search);
    if (name === "fees" && analysis) draw();                 // widths are only known once visible
    if (name === "margin" && window.MarginBridge) dispatchEvent(new Event("resize"));
  }
  tabs.forEach(([n, tab], i) => {
    tab.addEventListener("click", () => show(n));
    tab.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      show(tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length][0], true);
    });
  });

  // ------------------------------------------------------------------ reading the PDF
  // pdf.js 4.10.38, served from this site (vendor/pdfjs) so the statement is read without a third party
  const PDFJS = new URL("vendor/pdfjs/pdf.min.mjs", document.baseURI).href;
  const WORKER = new URL("vendor/pdfjs/pdf.worker.min.mjs", document.baseURI).href;
  let lib = null;
  async function pdfjs() {
    if (lib) return lib;
    status("Loading the PDF reader...");
    lib = await import(PDFJS);
    lib.GlobalWorkerOptions.workerSrc = WORKER;
    return lib;
  }
  async function itemsFrom(buffer) {
    const pdf = await (await pdfjs()).getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }).promise;
    if (pdf.numPages > 60) throw new Error("That PDF has more than 60 pages, which is longer than any monthly statement.");
    const items = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const tc = await (await pdf.getPage(p)).getTextContent();
      for (const it of tc.items) if (it.str && it.str.trim()) items.push({ page: p, s: it.str, x: it.transform[4], y: it.transform[5], w: it.width });
    }
    pdf.destroy();
    return items;
  }

  let analysis = null, fileLabel = "";
  async function load(buffer, name) {
    try {
      status(`Reading ${name}...`);
      const items = await itemsFrom(buffer);
      const st = FeeStatement.parse(FeeStatement.linesFromItems(items));
      if (!st.ok) return fail(st.reason, st.totals);
      const a = K.analyze(st);
      if (!a.ok) return fail(a.reason);
      analysis = a; fileLabel = name; lineFilter = "all"; rateFilter = "all";
      whatIf = null;
      status("");
      $("fee-dash").hidden = false;
      draw();
      combined();
      $("fee-dash").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      if (err?.name === "PasswordException") return fail("That PDF is password-protected. Download it again without a password, or open it and save a copy.");
      fail(`Couldn't read that PDF: ${err.message}`);
    }
  }
  // an unsupported statement still gets its labelled totals put into the quick check, with the
  // line each came from, so the person can confirm them instead of trusting a guess
  function fail(msg, totals) {
    analysis = null;
    $("fee-dash").hidden = true;
    $("q-found").hidden = true;
    if (totals && (totals.sales || totals.fees)) {
      const put = (id, t) => { if (t) $(id).value = (t.cents / 100).toFixed(2); };
      put("q-sales", totals.sales); put("q-fees", totals.fees);
      const row = (what, t) => t ? `<li><b>${what}:</b> ${usd(t.cents)}, from the line "${esc(t.line)}" on page ${t.page}</li>` : `<li><b>${what}:</b> not found; type it in from your statement's summary</li>`;
      $("q-found").innerHTML = `<p><b>Filled in from your statement.</b> Check these against the PDF before trusting the result:</p><ul>${row("Card sales", totals.sales)}${row("Total fees", totals.fees)}</ul>`;
      $("q-found").hidden = false;
      quick();
      status(`${msg} I've filled in the quick check below from its totals; please check them.`, true);
      $("quick").scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    status(msg + " You can still use the quick check below with two numbers from your statement.", true);
  }
  $("fee-file").addEventListener("change", async (e) => { const f = e.target.files[0]; if (f) load(await f.arrayBuffer(), f.name); });
  const drop = $("fee-drop");
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", async (e) => { const f = e.dataTransfer.files[0]; if (f) load(await f.arrayBuffer(), f.name); });
  document.querySelectorAll("[data-fee-sample]").forEach((b) => b.addEventListener("click", async () => {
    try {
      status(`Loading the ${b.dataset.label} (a made-up business)...`);
      load(await (await fetch(b.dataset.feeSample)).arrayBuffer(), `the ${b.dataset.label}`);
    } catch (err) { fail(`Couldn't load the sample: ${err.message}`); }
  }));

  // ------------------------------------------------------------------ drawing
  const card = (id, title, sub, body) => {
    $(id).innerHTML = `<div class="card-head"><h3>${title}</h3>${sub ? `<p>${sub}</p>` : ""}</div>${body}`;
  };
  const widthOf = () => Math.max(280, ($("fee-dash").clientWidth || 800) - 40);
  const halfWidth = () => (innerWidth <= 760 ? widthOf() : Math.max(280, (widthOf() - 16) / 2 - 20));
  const COLORS = { interchange: "var(--c-bank)", network: "var(--c-net)", processor: "var(--accent)", unknown: "var(--axis)" };
  const LABEL = { interchange: "Card-issuing banks (interchange)", network: "Card networks (Visa, Mastercard, Amex, Discover)", processor: "Your processor", unknown: "Couldn't place" };

  function draw() {
    const a = analysis; if (!a) return;
    const st = a.st, b = a.buckets;
    const passThrough = b.interchange + b.network;
    const okChecks = a.checks.filter((c) => c.ok).length;
    const above = a.rateSummary.above, checked = a.rateSummary.match + a.rateSummary.above + a.rateSummary.below + a.rateSummary.differs;
    const who = st.processor ? ` (${esc(st.processor)})` : "";

    // the summary: plain sentences, then the four numbers
    $("fee-summary").innerHTML = `
      <p class="kicker">${esc(fileLabel)} · ${st.period ? monthName(st.period.from) : "statement"} · ${esc(st.layout)} layout${st.currency === "CAD" ? " · amounts in Canadian dollars" : ""}</p>
      <p class="headline">You took <b>${usd(a.sales)}</b> in card payments and paid <b>${usd(a.fees)}</b> in fees:
        <b>${pct(a.effectiveRate)}</b> of every sale, about <b>${usd(Math.round(a.fees / Math.max(1, a.txns)))}</b> per sale.</p>
      <p>${usd(passThrough)} of that went to the banks that issued your customers' cards and to the card networks. That part is the same at any processor.
        <b>${usd(b.processor)}</b> (${pct(b.processor / a.sales)} of sales) went to your processor${who}, and that's the part you can negotiate.</p>
      <p class="verdict ${a.allChecksOk && !above ? "good" : "warn"}">${a.allChecksOk ? `The statement adds up to the cent (${okChecks} of ${a.checks.length} checks passed).` : `${a.checks.length - okChecks} of ${a.checks.length} checks found a problem; see "Does it add up?" below.`}
        ${checked ? `${a.rateSummary.match} of ${checked} interchange lines match the published rate${above ? `; <b>${above} ${above > 1 ? "were" : "was"} charged above it</b>` : ""}.` : ""}
        ${a.findings.length ? `<a href="#f-findings">${a.findings.length} thing${a.findings.length > 1 ? "s" : ""} worth asking about</a>.` : ""}</p>
      <div class="kpis fee-kpis">
        <div class="tile"><div class="l">Card sales</div><div class="v">${usd0(a.sales)}</div><div class="dl">${a.txns.toLocaleString("en-US")} sales and refunds</div></div>
        <div class="tile"><div class="l">Total fees</div><div class="v">${usd0(a.fees)}</div><div class="dl">${usd(a.fees)}</div></div>
        <div class="tile"><div class="l">Effective rate</div><div class="v">${pct(a.effectiveRate)}</div><div class="dl">fees ÷ card sales</div></div>
        <div class="tile hot"><div class="l">Your processor kept</div><div class="v">${usd0(b.processor)}</div><div class="dl">${pct(b.processor / a.sales)} of sales · negotiable</div></div>
      </div>`;

    // where the fees went: one bar, three parts
    const parts = ["interchange", "network", "processor", "unknown"].filter((k) => b[k] > 0);
    card("f-split", "Where the fees went", "Sorted by who gets the money, using the rules shown in the fee list below. The statement's own labels mix these up.",
      `<div class="split" role="img" aria-label="Fees by who gets them">${parts.map((k) => `<i style="flex:${b[k]};background:${COLORS[k]}" data-tip="${encodeURIComponent(`<b>${LABEL[k]}</b><br>${usd(b[k])}, ${pct(b[k] / a.fees, 0)} of fees`)}" tabindex="0"></i>`).join("")}</div>
      <div class="legend">${parts.map((k) => `<div><span class="sw" style="background:${COLORS[k]}"></span><b>${LABEL[k]}</b>
        <span class="amt">${usd(b[k])}</span><small>${pct(b[k] / a.sales)} of sales · ${k === "processor" ? "negotiable" : k === "unknown" ? "not sorted" : "same at any processor"}</small></div>`).join("")}</div>`);

    // findings, biggest first
    card("f-findings", "Worth asking about", a.findings.length ? "Biggest first. Each one is a fixed rule over the statement's numbers, not AI text." : "",
      a.findings.length ? `<ol class="flist">${a.findings.map((f) => `<li class="k-${f.kind}"><div class="ft"><b>${esc(f.title)}</b>${f.amount >= 100 ? `<span class="amt">${usd0(f.amount)}<small>/month</small></span>` : f.amount > 0 ? `<span class="amt">${usd(Math.round(f.amount))}</span>` : ""}</div><p>${esc(f.text)}</p></li>`).join("")}</ol>`
        : `<p class="empty">Nothing stood out: every line matched its published rate and nothing looked unusual.</p>`);

    // the checks
    card("f-checks", "Does it add up?", `${okChecks} of ${a.checks.length} checks passed. The first two must pass or no results are shown.`,
      `<ul class="checks">${a.checks.map((c) => `<li class="${c.ok ? "ok" : "bad"}"><span class="mark" aria-label="${c.ok ? "passed" : "failed"}">${c.ok ? "✓" : "✗"}</span><div><b>${esc(c.label)}</b><small>${esc(c.detail)}</small></div></li>`).join("")}</ul>`);

    // by card brand
    const brands = a.byBrand.filter((x) => x.sales > 0).sort((p, q) => q.rate - p.rate);
    card("f-brands", "Cost by card brand", "Fees on each brand's sales, as a share of those sales. Amex and premium rewards cards usually cost the most.",
      Charts.hbars(brands.map((x) => ({ name: x.brand, label: x.brand === "AMEX ACQ" ? "AMEX" : x.brand, value: x.rate,
        tip: `<b>${esc(x.brand)}</b><br>${usd(x.sales)} of sales, ${x.count} sales<br>${usd(x.fees)} in fees, ${pct(x.rate)}` })),
        { fmt: (v) => pct(v), label: "Effective rate by card brand", polarity: false }) +
      (a.unbranded ? `<p class="fine">Plus ${usd(a.unbranded)} in fees not tied to one brand (monthly and account fees).</p>` : ""));

    drawRates();
    drawLines();
    drawWhatIf();

    // daily sales
    const pts = st.days.map((d) => ({ label: new Date(d.date + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }), y: d.submitted / 100,
      tip: `<b>${new Date(d.date + "T00:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })}</b><br>${usd(d.submitted)} in card sales` }));
    card("f-days", "Card sales by day", `${st.days.length} days with card sales. Fees were taken once, at the end of the month.`,
      Charts.columns(pts, { fmt: (v) => (Math.abs(v) >= 1000 ? `$${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : `$${Math.round(v)}`), label: "Card sales by day", width: halfWidth(), height: 180, polarity: true }));

    wire();
  }

  let rateFilter = "all";
  function drawRates() {
    const a = analysis, s = a.rateSummary;
    const rows = a.ic.filter((r) => rateFilter === "all" || (rateFilter === "flag" ? ["above", "below", "differs"].includes(r.verdict) : r.verdict === rateFilter));
    const verdict = { match: ["Matches", "ok"], above: ["Above published", "bad"], below: ["Below published", "info"], differs: ["Differs", "info"], unchecked: ["Not checked", "none"], refund: ["Refund", "none"] };
    // the rate it matched, or every rate the program allows
    const published = (r) => r.matched ? rate(r.matched.pct, r.matched.fix) : r.ref ? [...new Set(r.ref.rates.map((x) => rate(x.pct, x.fix)))].join("<br>") : "n/a";
    const btn = (k, label, n) => `<button type="button" class="chip${rateFilter === k ? " on" : ""}" data-rf="${k}">${label} <span>${n}</span></button>`;
    const srcs = [...new Set(a.ic.filter((r) => r.ref).map((r) => r.ref.source))].map((k) => FeeRates.SOURCES[k]);
    card("f-rates", "Interchange, line by line, against the published rates",
      `Interchange is set by the card networks, so the same program should cost the same at any processor. ${s.match} match, ${s.above} above, ${s.below + s.differs} different, ${s.unchecked} not checked.`,
      `<div class="chipbar">${btn("all", "All", a.ic.length)}${btn("flag", "Not matching", s.above + s.below + s.differs)}${btn("unchecked", "Not checked", s.unchecked)}</div>
      <div class="tablewrap"><table class="data fees-t"><thead><tr><th>Program on your statement</th><th class="n">Sales</th><th class="n">Count</th><th class="n">Charged</th><th class="n">Published</th><th>Result</th></tr></thead><tbody>
      ${rows.map((r) => `<tr tabindex="0" data-tip="${encodeURIComponent(`<b>${esc(r.description)}</b><br>${esc(r.ref ? r.ref.name : "")}${r.ref ? "<br>" : ""}${esc(r.note)}${r.inPerson != null ? `<br>In person it would have cost ${usd(r.inPerson)} instead of ${usd(-r.total)}.` : ""}`)}">
        <td>${esc(r.description)}<small class="sub2">${esc(r.brand === "AMEX ACQ" ? "AMEX" : r.brand)}${r.ref ? ` · ${esc(r.ref.name)}` : ""}</small></td>
        <td class="n">${usd(r.sales)}</td><td class="n">${r.count}</td><td class="n">${rate(r.rate * 100, r.perItem / 100)}<small class="sub2">${usd(-r.total)}</small></td>
        <td class="n pub">${published(r)}</td><td><span class="badge ${verdict[r.verdict][1]}">${verdict[r.verdict][0]}</span>${r.over ? `<small class="sub2">${usd(r.over)} over</small>` : ""}</td></tr>`).join("") || `<tr><td colspan="6" class="empty">Nothing here.</td></tr>`}
      </tbody></table></div>
      <p class="fine">Rates from: ${srcs.map((x) => `<a href="${x.url}" target="_blank" rel="noopener">${esc(x.name)}</a>${x.official ? "" : " (not the network's own document)"}`).join("; ")}.
        A line matches when its percentage and per-sale fee both equal a published rate for that program. Card names on statements are abbreviated, so when a name could mean more than one card type, every possible rate is allowed.</p>`);
  }

  let lineFilter = "all";
  function drawLines() {
    const a = analysis;
    const rows = a.lines.filter((l) => lineFilter === "all" || l.cls === lineFilter).sort((p, q) => p.amount - q.amount);
    const total = (k) => -a.lines.filter((l) => k === "all" || l.cls === k).reduce((s, l) => s + l.amount, 0);
    const kinds = ["all", "processor", "network", "interchange", "unknown"].filter((k) => k === "all" || a.lines.some((l) => l.cls === k));
    const name = { all: "All", processor: "Your processor", network: "Card networks", interchange: "Interchange", unknown: "Couldn't place" };
    card("f-lines", "Every fee on the statement", `All ${a.lines.length} lines, biggest first. "Statement label" is how the statement files it; "Who gets it" is this checker's reading. Hover a line for the reason.`,
      `<div class="chipbar">${kinds.map((k) => `<button type="button" class="chip${lineFilter === k ? " on" : ""}" data-lf="${k}">${name[k]} <span>${usd(total(k))}</span></button>`).join("")}</div>
      <div class="tablewrap"><table class="data fees-t"><thead><tr><th>Description</th><th>Statement label</th><th>Who gets it</th><th class="n">Amount</th></tr></thead><tbody>
      ${rows.map((l) => `<tr tabindex="0" data-tip="${encodeURIComponent(`<b>${esc(l.description)}</b><br>${esc(l.why)}${l.math ? `<br>Recalculated: ${usd(l.mathExpected)}${l.mathOk ? " ✓" : " ✗ doesn't match"}` : ""}`)}">
        <td>${esc(l.description)}${l.mathOk === false ? ` <span class="badge bad">doesn't add up</span>` : ""}</td><td>${esc(l.type)}</td>
        <td><span class="sw" style="background:${COLORS[l.cls]}"></span>${esc(name[l.cls] === "Interchange" ? "Card-issuing bank" : name[l.cls])}</td><td class="n">${usd(-l.amount)}</td></tr>`).join("")}
      </tbody></table></div>`);
  }

  let whatIf = null;
  function drawWhatIf() {
    const a = analysis;
    const cur = K.whatIf(a, { pct: 0, perTxn: 0 });
    if (!cur.vol) { card("f-whatif", "Compare a quote", "", `<p class="empty">No percentage markup lines were found on this statement, so there's nothing to compare.</p>`); return; }
    if (!whatIf) {
      const authPart = a.authRates[0] ?? 0;
      whatIf = { pct: +(((cur.now - Math.round(cur.count * authPart * 100)) / cur.vol) * 100).toFixed(2), perTxn: authPart };
    }
    card("f-whatif", "Compare a quote", `Your processor's percentage and per-check fee came to ${usd(cur.now)} on ${usd(cur.vol)} of card sales and ${cur.count.toLocaleString("en-US")} card checks. Type in another processor's interchange-plus quote to compare.`,
      `<div class="wi">
        <label>Their percentage <span class="money-in"><input id="wi-pct" inputmode="decimal" value="${whatIf.pct}"><i>%</i></span></label>
        <label>Per card check <span class="money-in"><i>$</i><input id="wi-fix" inputmode="decimal" value="${whatIf.perTxn.toFixed(2)}"></span></label>
      </div><p class="wi-out" id="wi-out" aria-live="polite"></p>
      <p class="fine">Interchange and card-network fees don't change between processors, so only this part is compared. Monthly fees are left out; add them yourself.</p>`);
    const update = () => {
      const p = parseFloat($("wi-pct").value), f = parseFloat($("wi-fix").value.replace(/[$,]/g, ""));
      if (!Number.isFinite(p) || !Number.isFinite(f) || p < 0 || f < 0) { $("wi-out").textContent = "Enter a percentage and a per-check fee."; return; }
      whatIf = { pct: p, perTxn: f };
      const r = K.whatIf(a, whatIf);
      $("wi-out").innerHTML = Math.abs(r.saving) < Math.max(50, r.now * 0.01) ? `About the same as now: ${usd(r.then)} a month.`
        : r.saving > 0 ? `<b>${usd(r.saving)} less a month</b>, about ${usd0(r.saving * 12)} a year (${usd(r.then)} instead of ${usd(r.now)}).`
          : `${usd(-r.saving)} more a month than you pay now (${usd(r.then)} instead of ${usd(r.now)}).`;
    };
    $("wi-pct").addEventListener("input", update); $("wi-fix").addEventListener("input", update);
    update();
  }

  // ------------------------------------------------------------------ tooltips and filter chips
  const tip = $("tip");
  function wire() {
    document.querySelectorAll("#fee-dash [data-tip]").forEach((el) => {
      const showTip = () => {
        tip.innerHTML = decodeURIComponent(el.dataset.tip); tip.hidden = false;
        const r = el.getBoundingClientRect();
        tip.style.left = `${Math.min(innerWidth - tip.offsetWidth - 10, Math.max(10, r.left + r.width / 2 - tip.offsetWidth / 2))}px`;
        tip.style.top = `${r.top + scrollY - tip.offsetHeight - 8}px`;
      };
      el.addEventListener("mouseenter", showTip); el.addEventListener("focus", showTip);
      el.addEventListener("mouseleave", () => { tip.hidden = true; }); el.addEventListener("blur", () => { tip.hidden = true; });
    });
    document.querySelectorAll("[data-rf]").forEach((b) => b.addEventListener("click", () => { rateFilter = b.dataset.rf; drawRates(); wire(); }));
    document.querySelectorAll("[data-lf]").forEach((b) => b.addEventListener("click", () => { lineFilter = b.dataset.lf; drawLines(); wire(); }));
  }
  let resizeTimer;
  addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (analysis && !$("pane-fees").hidden) draw(); }, 250); });

  // ------------------------------------------------------------------ both tabs together
  async function combined() {
    const a = analysis, m = window.MarginBridge;
    const boxes = [$("both-fees"), $("both-margin")];
    if (!a || !m || !a.st.period) { boxes.forEach((b) => { b.hidden = true; }); return; }
    const ym = a.st.period.from.slice(0, 7), label = monthName(a.st.period.from);
    let html;
    if (!m.months.includes(ym)) {
      html = `<b>Both checks loaded.</b> Your sales file covers ${esc(m.months[0])} to ${esc(m.months[m.months.length - 1])}, and the card statement is for ${label}, so they aren't compared. Load a sales file that includes ${label} to see card fees against your profit.`;
    } else {
      const r = await m.month(ym);
      const share = r.sales ? a.sales / (r.sales * 100) : null;
      html = `<b>${label}, both files together.</b> Your sales file shows ${usd(Math.round(r.sales * 100))} in sales${m.hasProfit && r.profit != null ? ` and ${usd(Math.round(r.profit * 100))} in profit` : ""}.
        Card fees of ${usd(a.fees)} were ${pct(a.fees / (r.sales * 100))} of those sales${m.hasProfit && r.profit > 0 ? `, or <b>${pct(a.fees / (r.profit * 100), 1)} of your profit</b>` : ""}.
        ${share != null ? `Card payments were ${pct(share, 0)} of the sales in your file${share > 1.02 ? " (more than 100%: the files may not cover the same sales)" : ""}.` : ""}`;
    }
    boxes.forEach((b) => { b.innerHTML = html; b.hidden = false; });
  }
  addEventListener("margin:ready", combined);

  // ------------------------------------------------------------------ the quick check
  const num = (id) => { const v = parseFloat($(id).value.replace(/[$,\s]/g, "")); return Number.isFinite(v) ? v : null; };
  function quick() {
    const s = num("q-sales"), f = num("q-fees"), p = num("q-pass");
    if (s == null || f == null) { $("q-out").innerHTML = ""; return; }
    if (s <= 0 || f < 0) { $("q-out").textContent = "Card sales must be more than zero."; return; }
    const r = Math.abs(f) / s;
    let out = `Your effective rate is <b>${pct(r)}</b>: ${usd(Math.round(Math.abs(f) * 100))} in fees on ${usd(Math.round(s * 100))} of card sales.`;
    if (p != null && Math.abs(p) <= Math.abs(f)) {
      const proc = Math.abs(f) - Math.abs(p);
      out += ` Of that, <b>${usd(Math.round(proc * 100))}</b> (${pct(proc / s)} of sales) is your processor's share, the negotiable part.`;
    } else if (p != null) out += " (The interchange figure is bigger than the total fees; check the numbers.)";
    if (r > 0.08) out += ` <b>That's far higher than usual</b> (most businesses pay roughly 1.5% to 4%), so check the card sales figure: it may be one day's or one card type's sales rather than the month's.`;
    out += ` <span class="fine">Without the line-by-line statement, this can't say whether any single fee is wrong.</span>`;
    $("q-out").innerHTML = out;
  }
  ["q-sales", "q-fees", "q-pass"].forEach((id) => $(id).addEventListener("input", quick));

  if (location.hash === "#fees") show("fees");
})();
