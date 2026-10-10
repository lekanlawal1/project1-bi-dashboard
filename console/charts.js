/* Hand-built SVG charts for Money Snitch (margins tab). Each function returns markup; marks carry
   data-tip (tooltip HTML, URI-encoded) and data-filter (JSON of the filter a click applies), which
   app.js wires up once per render. One axis per chart; polarity (profit, margin) uses the two
   validated diverging tokens --pos and --neg, magnitude (sales) a single neutral hue. */

const Charts = (() => {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const enc = (s) => encodeURIComponent(s);
  const attrs = (tip, filter) => `tabindex="0" data-tip="${enc(tip)}"${filter ? ` data-filter="${esc(JSON.stringify(filter))}" role="button"` : ""}`;

  function niceStep(span, target = 4) {
    const raw = span / target, mag = 10 ** Math.floor(Math.log10(raw || 1));
    return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10;
  }
  function ticks(min, max) {
    const step = niceStep(max - min || 1);
    const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
    const out = [];
    for (let t = lo; t <= hi + step / 2; t += step) out.push(Math.round(t * 1e6) / 1e6);
    return out;
  }

  // ---------------------------------------------------------------- vertical columns over time
  // width: the card's real width in pixels, so text stays at its true size on a phone
  function columns(points, { fmt, label, height = 170, polarity = false, width = 760 }) {
    if (!points.length) return `<p class="empty">No data in this selection.</p>`;
    const W = width, P = { l: 52, r: 8, t: 10, b: 24 }, iw = W - P.l - P.r, ih = height - P.t - P.b;
    const vals = points.map((p) => p.y ?? 0), tk = ticks(Math.min(0, ...vals), Math.max(0, ...vals));
    const lo = tk[0], hi = tk[tk.length - 1], y = (v) => P.t + ih - ((v - lo) / (hi - lo || 1)) * ih;
    const slot = iw / points.length, bw = Math.max(2, Math.min(30, slot - 2));
    const x = (i) => P.l + (i + 0.5) * slot;
    const grid = tk.map((t) => `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${P.l - 6}" y="${y(t) + 4}" text-anchor="end">${fmt(t, true)}</text>`).join("");
    const every = Math.max(1, Math.ceil(points.length / Math.max(3, Math.floor(iw / 95))));
    const xl = points.map((p, i) => (i % every === 0 ? `<text class="tick" x="${x(i)}" y="${height - 6}" text-anchor="middle">${esc(p.label)}</text>` : "")).join("");
    const bars = points.map((p, i) => {
      if (p.y == null) return "";
      const top = Math.min(y(p.y), y(0)), h = Math.max(1, Math.abs(y(p.y) - y(0)));
      const cls = polarity ? (p.y < 0 ? "neg" : "pos") : "mag";
      return `<rect class="bar ${cls}" x="${x(i) - bw / 2}" y="${top}" width="${bw}" height="${h}" rx="3" ${attrs(p.tip, p.filter)}/>`;
    }).join("");
    return `<svg class="chart" viewBox="0 0 ${W} ${height}" role="img" aria-label="${esc(label)}">${grid}
      <line class="axis" x1="${P.l}" x2="${W - P.r}" y1="${y(0)}" y2="${y(0)}"/>${bars}${xl}</svg>`;
  }

  // ---------------------------------------------------------------- a line over time (margin %)
  function line(points, { fmt, label, height = 150, width = 760 }) {
    const real = points.filter((p) => p.y != null);
    if (!real.length) return `<p class="empty">No data in this selection.</p>`;
    const W = width, P = { l: 52, r: 8, t: 10, b: 24 }, iw = W - P.l - P.r, ih = height - P.t - P.b;
    const tk = ticks(Math.min(0, ...real.map((p) => p.y)), Math.max(0, ...real.map((p) => p.y)));
    const lo = tk[0], hi = tk[tk.length - 1], y = (v) => P.t + ih - ((v - lo) / (hi - lo || 1)) * ih;
    const x = (i) => P.l + (i + 0.5) * (iw / points.length);
    const grid = tk.map((t) => `<line class="grid${t === 0 ? " zero" : ""}" x1="${P.l}" x2="${W - P.r}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${P.l - 6}" y="${y(t) + 4}" text-anchor="end">${fmt(t, true)}</text>`).join("");
    let d = "", pen = false;
    points.forEach((p, i) => { if (p.y == null) { pen = false; return; } d += `${pen ? "L" : "M"}${x(i)},${y(p.y)}`; pen = true; });
    const every = Math.max(1, Math.ceil(points.length / Math.max(3, Math.floor(iw / 95))));
    const xl = points.map((p, i) => (i % every === 0 ? `<text class="tick" x="${x(i)}" y="${height - 6}" text-anchor="middle">${esc(p.label)}</text>` : "")).join("");
    const r = iw / points.length < 9 ? 2.5 : 4;          // smaller markers when months are packed tight
    const dots = points.map((p, i) => p.y == null ? "" : `<g class="pt" ${attrs(p.tip, p.filter)}><circle class="hit" cx="${x(i)}" cy="${y(p.y)}" r="10"/><circle class="mk ${p.y < 0 ? "neg" : "pos"}" cx="${x(i)}" cy="${y(p.y)}" r="${r}"/></g>`).join("");
    return `<svg class="chart" viewBox="0 0 ${W} ${height}" role="img" aria-label="${esc(label)}">${grid}<path class="line" d="${d}"/>${dots}${xl}</svg>`;
  }

  // ---------------------------------------------------------------- horizontal bars around zero
  function hbars(rows, { fmt, label, polarity = true, selected }) {
    if (!rows.length) return `<p class="empty">No data in this selection.</p>`;
    const maxAbs = Math.max(...rows.map((r) => Math.abs(r.value ?? 0)), 1e-9);
    const hasNeg = polarity && rows.some((r) => r.value < 0);
    return `<div class="hbars" role="list" aria-label="${esc(label)}">${rows.map((r) => {
      const w = (Math.abs(r.value ?? 0) / maxAbs) * (hasNeg ? 50 : 100);
      const left = hasNeg ? (r.value < 0 ? 50 - w : 50) : 0;
      const cls = polarity ? (r.value < 0 ? "neg" : "pos") : "mag";
      return `<div class="hrow${selected === r.name ? " on" : ""}" role="listitem" ${attrs(r.tip, r.filter)}>
        <span class="hl">${esc(r.label ?? r.name)}</span>
        <span class="track">${hasNeg ? `<i class="zero"></i>` : ""}<i class="fill ${cls}" style="left:${left}%;width:${Math.max(w, 0.6)}%"></i></span>
        <span class="hv">${fmt(r.value)}</span></div>`;
    }).join("")}</div>`;
  }

  // ---------------------------------------------------------------- heatmap (diverging, neutral at 0)
  function heatmap(cells, rowsKeys, colKeys, { fmt, cap = 0.4, label, metric = "margin" }) {
    if (!cells.length) return `<p class="empty">No data in this selection.</p>`;
    const get = (r, c) => cells.find((x) => x.row === r && x.col === c);
    const maxSales = Math.max(...cells.map((c) => c.value ?? 0), 1);
    const style = (v) => {
      if (v == null) return "";
      if (metric !== "margin") {
        const t = Math.min(1, v / maxSales);
        return `background: color-mix(in oklab, var(--mag) ${Math.round(12 + t * 78)}%, var(--cell));${t > 0.55 ? "color:#fff" : ""}`;
      }
      const t = Math.min(1, Math.abs(v) / cap);
      return `background: color-mix(in oklab, var(${v < 0 ? "--neg" : "--pos"}) ${Math.round(10 + t * 80)}%, var(--cell));${t > 0.55 ? "color:#fff" : ""}`;
    };
    return `<div class="heat-wrap"><table class="heat" aria-label="${esc(label)}"><thead><tr><th></th>${colKeys.map((c) => `<th scope="col">${esc(c)}</th>`).join("")}</tr></thead>
      <tbody>${rowsKeys.map((r) => `<tr><th scope="row">${esc(r)}</th>${colKeys.map((c) => {
        const x = get(r, c);
        return x ? `<td style="${style(x.value)}" ${attrs(x.tip, x.filter)}>${fmt(x.value)}</td>` : `<td class="none">n/a</td>`;
      }).join("")}</tr>`).join("")}</tbody></table></div>`;
  }

  // ---------------------------------------------------------------- Pareto: running share of profit by product rank
  function pareto(rows, { label, money, width = 760 }) {
    if (!rows.length) return `<p class="empty">No data in this selection.</p>`;
    const W = width, H = 210, P = { l: 52, r: 12, t: 12, b: 28 }, iw = W - P.l - P.r, ih = H - P.t - P.b;
    const total = rows[0].positive_total || 1, n = rows.length;
    const shares = rows.map((r) => r.running / total);
    const lo = Math.min(0, ...shares), hi = Math.max(1, ...shares);
    const x = (i) => P.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw), y = (v) => P.t + ih - ((v - lo) / (hi - lo)) * ih;
    const k80 = shares.findIndex((s) => s >= 0.8);
    const firstLoss = rows.findIndex((r) => r.profit < 0);
    const tk = ticks(lo, hi).filter((t) => t >= lo - 1e-9 && t <= hi + 1e-9);
    const grid = tk.map((t) => `<line class="grid${t === 0 ? " zero" : ""}" x1="${P.l}" x2="${W - P.r}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${P.l - 6}" y="${y(t) + 4}" text-anchor="end">${Math.round(t * 100)}%</text>`).join("");
    const d = shares.map((s, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(s).toFixed(1)}`).join("");
    const loss = firstLoss >= 0 ? `<rect class="loss-zone" x="${x(firstLoss)}" y="${P.t}" width="${x(n - 1) - x(firstLoss)}" height="${ih}"/>
      <text class="note" x="${(x(firstLoss) + x(n - 1)) / 2}" y="${y(lo) - 8}" text-anchor="middle">products that lose money</text>` : "";
    const mark = k80 >= 0 ? `<line class="mark" x1="${x(k80)}" x2="${x(k80)}" y1="${y(0.8)}" y2="${y(lo)}"/><circle class="mk pos" cx="${x(k80)}" cy="${y(shares[k80])}" r="5"/>
      <text class="note" x="${x(k80) + 8}" y="${y(0.8) + 22}">${k80 + 1} products make 80% of the profit</text>` : "";
    // hover targets: one invisible band per 1% of products, so long product lists stay light
    const step = Math.max(1, Math.floor(n / 120));
    const hits = rows.map((r, i) => (i % step ? "" : `<rect class="hitband" x="${x(i) - (iw / n) * step / 2}" y="${P.t}" width="${Math.max(2, (iw / n) * step)}" height="${ih}" ${attrs(
      `<b>Top ${i + 1} product${i ? "s" : ""}</b><br>${Math.round(shares[i] * 100)}% of all profit<br>#${i + 1}: ${esc(r.product)}, ${money(r.profit)}`, { product: r.product })}/>`)).join("");
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${loss}${grid}
      <path class="line" d="${d}"/>${mark}${hits}
      <text class="tick" x="${P.l}" y="${H - 8}">best product</text><text class="tick" x="${W - P.r}" y="${H - 8}" text-anchor="end">worst (${n.toLocaleString("en-CA")} products)</text></svg>`;
  }

  return { columns, line, hbars, heatmap, pareto };
})();
