// ── Constants ─────────────────────────────────────────────────────────────

const ROW_H   = 48;
const ROW_GAP = 4;
const ML      = 56; // left margin for axis labels

const color = d3.scaleSequential(d3.interpolateYlOrRd).domain([0, 1]);

// ── Zoom state ────────────────────────────────────────────────────────────

let fullRoot  = null;   // d3 hierarchy root, built once per data load
let focusNode = null;   // currently zoomed node (fullRoot = no zoom)

// ── Hit-test state (updated every renderView call) ────────────────────────
// nodeRows: Map<relDepth, node[]> with each row sorted by x0.
// Binary-search within a row gives O(log n) hover/click lookup.

let nodeRows     = null;
let hitXOffset   = 0;
let hitXScale    = 1;
let hitBaseDepth = 0;

// ── renderView ────────────────────────────────────────────────────────────

function renderView() {
  const canvas     = document.getElementById('chart');
  const ctx        = canvas.getContext('2d');
  const tooltip    = document.getElementById('tooltip');
  const breadcrumb = document.getElementById('breadcrumb');
  const resetBtn   = document.getElementById('btn-reset');
  tooltip.style.opacity = 0;

  const W         = Math.max(window.innerWidth - ML - 60, 800);
  const remaining = fullRoot.height - focusNode.depth;
  const H         = (remaining + 1) * (ROW_H + ROW_GAP);

  canvas.width  = W + ML;
  canvas.height = H;

  // x-coordinate transform: map focusNode's [x0, x1] → [ML, ML+W]
  const xOffset   = focusNode.x0;
  const xScale    = W / (focusNode.x1 - focusNode.x0);
  const baseDepth = focusNode.depth;

  // Breadcrumb: "Root › 2603:8000::/32"
  const path = [];
  let n = focusNode;
  while (n) { path.unshift(n.data.name); n = n.parent; }
  breadcrumb.textContent = path.join(' \u203a ');

  resetBtn.style.display = (focusNode === fullRoot) ? 'none' : '';

  const descendants = focusNode.descendants();

  // Build row index for hit testing
  nodeRows     = new Map();
  hitXOffset   = xOffset;
  hitXScale    = xScale;
  hitBaseDepth = baseDepth;
  for (const d of descendants) {
    const rd = d.depth - baseDepth;
    if (!nodeRows.has(rd)) nodeRows.set(rd, []);
    nodeRows.get(rd).push(d);
  }
  // Each row is already sorted by x0 from d3.partition (siblings sorted earlier).

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // ── Draw cells ────────────────────────────────────────────────────────
  for (const d of descendants) {
    const x = ML + (d.x0 - xOffset) * xScale;
    const y = (d.depth - baseDepth) * (ROW_H + ROW_GAP);
    const w = Math.max(0, (d.x1 - d.x0) * xScale - 1);
    if (w < 0.5) continue; // skip sub-pixel cells

    // Fill
    if (d === focusNode) {
      ctx.fillStyle = '#ddd';
    } else {
      ctx.fillStyle = color(d.parent._sibMax > 0 ? d.data.count / d.parent._sibMax : 0);
    }
    ctx.fillRect(x, y, w, ROW_H);

    // 1px white inner border
    ctx.strokeStyle = '#fff';
    ctx.lineWidth   = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, ROW_H - 1);

    // Text label (only when cell is wide enough)
    if (d !== focusNode && w > 80) {
      ctx.fillStyle    = '#fff';
      ctx.font         = '10px sans-serif';
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'middle';
      const label = d.data.name.length > 20 ? d.data.name.slice(0, 18) + '…' : d.data.name;
      ctx.fillText(label, x + 5, y + ROW_H / 2);
    }
  }

  // ── Axis labels ───────────────────────────────────────────────────────
  ctx.fillStyle    = '#555';
  ctx.font         = '11px sans-serif';
  ctx.textAlign    = 'right';
  ctx.textBaseline = 'middle';
  const seen = new Set();
  for (const d of descendants) {
    const relDepth = d.depth - baseDepth;
    if (seen.has(relDepth)) continue;
    seen.add(relDepth);
    const label = relDepth === 0
      ? (focusNode === fullRoot ? 'Root' : `/${focusNode.data.level}`)
      : `/${d.data.level}`;
    ctx.fillText(label, ML - 6, relDepth * (ROW_H + ROW_GAP) + ROW_H / 2);
  }
}

// ── render ────────────────────────────────────────────────────────────────
// Builds the d3 hierarchy + partition from the fetched JSON, then calls
// renderView(). Called once per data load.

function render(data) {
  fullRoot = d3.hierarchy(data.tree)
    .sum(d => d.count)
    .sort((a, b) => a.data.name < b.data.name ? -1 : 1);

  // Precompute sibMax on each parent to avoid O(n²) per-cell recomputation.
  fullRoot.each(d => {
    if (d.children) {
      let m = 0;
      for (const c of d.children) if (c.data.count > m) m = c.data.count;
      d._sibMax = m;
    }
  });

  // Run partition over full width; y-coords are ignored (we place rows by depth).
  const W = Math.max(window.innerWidth - ML - 60, 800);
  d3.partition().size([W, 1])(fullRoot);

  focusNode = fullRoot;
  renderView();
}

// ── Canvas hit testing ────────────────────────────────────────────────────

function nodeAtPoint(cx, cy) {
  if (!nodeRows) return null;
  const relDepth = Math.floor(cy / (ROW_H + ROW_GAP));
  if (cy - relDepth * (ROW_H + ROW_GAP) >= ROW_H) return null; // inside gap
  const row = nodeRows.get(relDepth);
  if (!row) return null;

  // Convert canvas x to partition x-space, then binary-search the sorted row.
  const rawX = (cx - ML) / hitXScale + hitXOffset;
  let lo = 0, hi = row.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if      (row[mid].x1 <= rawX) lo = mid + 1;
    else if (row[mid].x0 >  rawX) hi = mid - 1;
    else return row[mid] === focusNode ? null : row[mid];
  }
  return null;
}

// ── Canvas event listeners ────────────────────────────────────────────────

(function () {
  const canvas  = document.getElementById('chart');
  const tooltip = document.getElementById('tooltip');

  canvas.addEventListener('click', event => {
    if (!fullRoot) return;
    const rect = canvas.getBoundingClientRect();
    const d = nodeAtPoint(event.clientX - rect.left, event.clientY - rect.top);
    if (d && d.children) { focusNode = d; renderView(); }
  });

  canvas.addEventListener('mousemove', event => {
    if (!fullRoot) return;
    const rect = canvas.getBoundingClientRect();
    const d = nodeAtPoint(event.clientX - rect.left, event.clientY - rect.top);
    if (d) {
      canvas.style.cursor   = d.children ? 'pointer' : 'default';
      tooltip.style.opacity = 1;
      tooltip.style.left    = (event.clientX + 12) + 'px';
      tooltip.style.top     = (event.clientY - 8)  + 'px';
      tooltip.innerHTML     =
        `<strong>${d.data.name}</strong><br/>` +
        `Count: ${d.data.count}<br/>` +
        `Share: ${((d.data.count / fullRoot.value) * 100).toFixed(2)}%`;
    } else {
      canvas.style.cursor   = 'default';
      tooltip.style.opacity = 0;
    }
  });

  canvas.addEventListener('mouseleave', () => { tooltip.style.opacity = 0; });
})();

// ── Load & wire up buttons ────────────────────────────────────────────────

async function load(isIPv6) {
  const file     = isIPv6 ? 'data/ipv6-hierarchy.json' : 'data/ipv4-hierarchy.json';
  const label    = isIPv6 ? 'IPv6' : 'IPv4';
  const statusEl = document.getElementById('status');

  // Reset zoom state for new data load.
  fullRoot = null; focusNode = null; nodeRows = null;
  document.getElementById('breadcrumb').textContent = '';
  document.getElementById('btn-reset').style.display = 'none';

  statusEl.textContent = `Loading ${label}…`;

  try {
    const data = await fetch(file).then(r => r.json());
    render(data);
    document.getElementById('subtitle').textContent = isIPv6
      ? 'IPv6 prefix hierarchy: /32 → /48. Width = block size. Color = activity density.'
      : 'IPv4 prefix hierarchy: /8 → /16. Width = block size. Color = activity density.';
    statusEl.textContent =
      `${data.parsed} addresses loaded. Click a cell to zoom in. Hover for details.`;
  } catch (e) {
    statusEl.textContent = `Error: ${e.message}`;
  }
}

document.getElementById('btn-ipv6').addEventListener('click', () => load(true));
document.getElementById('btn-ipv4').addEventListener('click', () => load(false));

document.getElementById('btn-reset').addEventListener('click', () => {
  if (fullRoot) { focusNode = fullRoot; renderView(); }
});
