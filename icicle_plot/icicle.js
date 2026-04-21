// Constants

const ROW_H   = 48;
const ROW_GAP = 4;
const ML      = 56; // left margin for axis labels

const color = d3.scaleSequential(d3.interpolateYlOrRd).domain([0, 1]);

// Zoom state

let fullRoot  = null;   // d3 hierarchy root, built once per data load
let focusNode = null;   // currently zoomed node (fullRoot = no zoom)
let rawData   = null;   // raw JSON from load(); mutated when /64 detail arrives
let _loadingDetail = false; // guard against concurrent /64 fetches

// Status line state — base text set by load(), density set by renderView()
let _statusBase    = '';
let _lastDensity   = null;

function _refreshStatus() {
  if (!_statusBase) return;
  const el = document.getElementById('status');
  const suffix = _lastDensity !== null
    ? `  |  Data density: ${_lastDensity.toFixed(2)}%`
    : '';
  el.textContent = _statusBase + suffix;
}

// Hit-test state (updated every renderView call)
// nodeRows: Map<relDepth, node[]> with each row sorted by x0.
// Binary-search within a row gives O(log n) hover/click lookup.

let nodeRows     = null;
let hitXOffset   = 0;
let hitXScale    = 1;
let hitBaseDepth = 0;

// renderView

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

  const dpr = window.devicePixelRatio || 1;
  canvas.width        = (W + ML) * dpr;
  canvas.height       = H * dpr;
  canvas.style.width  = (W + ML) + 'px';
  canvas.style.height = H + 'px';
  ctx.scale(dpr, dpr);

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

  // Draw cells; accumulate filled area for density computation.
  let filledPx = 0;
  let skippedSubpixel = 0;
  for (const d of descendants) {
    const x = ML + (d.x0 - xOffset) * xScale;
    const y = (d.depth - baseDepth) * (ROW_H + ROW_GAP);

    // Gap nodes: thin gray bar with log-scaled width; no children are rendered.
    if (d.data.gap) {
      // Width: clamp log2(gap_size + 1) to [4, 20] px.
      const gapW = Math.min(20, Math.max(4, Math.log2(d.data.gap_size + 1)));
      ctx.fillStyle = '#bbb';
      ctx.fillRect(x, y, gapW, ROW_H);
      continue;
    }

    const w = Math.max(0, (d.x1 - d.x0) * xScale - 1);
    if (w < 0.5) { skippedSubpixel++; continue; } // skip sub-pixel cells

    if (d.data.count > 0) filledPx += w * ROW_H;

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

  console.log(`renderView: ${descendants.length} nodes total, ${skippedSubpixel} skipped (sub-pixel)`);

  // Axis labels
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

  // Data density: fraction of canvas area covered by active (non-gap, count>0) cells.
  _lastDensity = (filledPx / (canvas.width * canvas.height)) * 100;
  _refreshStatus();
}

// _buildAndPartition
// Re-builds the d3 hierarchy from rawData and re-runs the partition layout.
// Called by render() on initial load and by loadDetail64() after splicing in
// /64 children so that new nodes receive valid x0/x1 coordinates.

function _buildAndPartition() {
  fullRoot = d3.hierarchy(rawData.tree)
    // Gap nodes get sentinel value 1 so partition allocates a minimal slice.
    .sum(d => d.gap ? 1 : d.count)
    .sort((a, b) => {
      // Nodes with a sort_key (active /32s and gap nodes) compare numerically;
      // all other siblings (e.g. /48 nodes) fall back to name order.
      if (a.data.sort_key !== undefined && b.data.sort_key !== undefined) {
        return a.data.sort_key - b.data.sort_key;
      }
      return a.data.name < b.data.name ? -1 : 1;
    });

  // Precompute sibMax on each parent to avoid O(n²) per-cell recomputation.
  // Gap nodes have count 0, so they never inflate the max; explicit guard for clarity.
  fullRoot.each(d => {
    if (d.children) {
      let m = 0;
      for (const c of d.children) if (!c.data.gap && c.data.count > m) m = c.data.count;
      d._sibMax = m;
    }
  });

  // Run partition over full width; y-coords are ignored (we place rows by depth).
  const W = Math.max(window.innerWidth - ML - 60, 800);
  d3.partition().size([W, 1])(fullRoot);
}

// render
// Stores the fetched JSON, builds hierarchy, and calls renderView().
// Called once per data load.

function render(data) {
  rawData = data;
  _buildAndPartition();
  focusNode = fullRoot;
  renderView();
}

// Canvas hit testing

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

// nameToHex48
// Reverses hex_key_to_label: "2603:a000::/48" → "2603a0000000" (12 hex chars).

function nameToHex48(name) {
  const addr = name.replace(/\/\d+$/, ''); // strip CIDR suffix
  let groups;
  if (addr.includes('::')) {
    const [left, right] = addr.split('::');
    const leftGroups  = left  ? left.split(':')  : [];
    const rightGroups = right ? right.split(':') : [];
    const fill = Array(8 - leftGroups.length - rightGroups.length).fill('0');
    groups = [...leftGroups, ...fill, ...rightGroups];
  } else {
    groups = addr.split(':');
  }
  return groups.map(g => g.padStart(4, '0')).join('').slice(0, 12);
}

// loadDetail64
// Fetches the /48→/64 detail file for node d, splices its children into the
// raw data tree, rebuilds the partition, then zooms into d.  If the fetch
// fails (file absent = empty or unobserved block) we silently zoom to d as-is.

async function loadDetail64(d) {
  if (_loadingDetail) return;
  _loadingDetail = true;

  const nodeName  = d.data.name;
  const hexPrefix = nameToHex48(nodeName);
  const prevBase  = _statusBase;

  _statusBase = `Loading /64 detail for ${nodeName}…`;
  _refreshStatus();

  try {
    const resp = await fetch(`data/ipv6-64/${hexPrefix}.json`);
    if (resp.ok) {
      const detail = await resp.json();
      // d.data is the raw tree object; mutating .children updates rawData in place.
      d.data.children = detail.children;
      _buildAndPartition();
      // Find the same /48 node in the freshly built hierarchy by name.
      focusNode = fullRoot.descendants().find(n => n.data.name === nodeName) || fullRoot;
    } else {
      // No detail file — zoom into the /48 leaf as-is.
      focusNode = d;
    }
  } catch (_) {
    focusNode = d;
  }

  _statusBase = prevBase;
  _loadingDetail = false;
  renderView();
}

// Canvas event listeners

(function () {
  const canvas  = document.getElementById('chart');
  const tooltip = document.getElementById('tooltip');

  canvas.addEventListener('click', event => {
    if (!fullRoot || _loadingDetail) return;
    const rect = canvas.getBoundingClientRect();
    const d = nodeAtPoint(event.clientX - rect.left, event.clientY - rect.top);
    if (!d || d.data.gap) return;

    if (d.data.level === 48) {
      // Only fetch /64 detail if it hasn't been loaded yet for this block.
      const hasDetail = d.children && d.children.length > 0
                        && d.children[0].data.level === 64;
      if (!hasDetail) { loadDetail64(d); return; }
    }

    if (d.children) { focusNode = d; renderView(); }
  });

  canvas.addEventListener('mousemove', event => {
    if (!fullRoot) return;
    const rect = canvas.getBoundingClientRect();
    const d = nodeAtPoint(event.clientX - rect.left, event.clientY - rect.top);
    if (d) {
      // /48 nodes are always clickable (will trigger a /64 detail fetch if needed).
      const clickable = !d.data.gap && (d.children || d.data.level === 48);
      canvas.style.cursor   = clickable ? 'pointer' : 'default';
      tooltip.style.opacity = 1;
      tooltip.style.left    = (event.clientX + 12) + 'px';
      tooltip.style.top     = (event.clientY - 8)  + 'px';
      if (d.data.gap) {
        tooltip.innerHTML = `<strong>Gap</strong><br/>~${d.data.gap_size} empty /32 blocks`;
      } else {
        tooltip.innerHTML =
          `<strong>${d.data.name}</strong><br/>` +
          `Count: ${d.data.count}<br/>` +
          `Share: ${((d.data.count / fullRoot.value) * 100).toFixed(2)}%`;
      }
    } else {
      canvas.style.cursor   = 'default';
      tooltip.style.opacity = 0;
    }
  });

  canvas.addEventListener('mouseleave', () => { tooltip.style.opacity = 0; });
})();

// Load & wire up buttons

async function load(isIPv6) {
  const file     = isIPv6 ? 'data/ipv6-hierarchy.json' : 'data/ipv4-hierarchy.json';
  const label    = isIPv6 ? 'IPv6' : 'IPv4';
  const statusEl = document.getElementById('status');

  // Reset all state for a new data load.
  fullRoot = null; focusNode = null; nodeRows = null; rawData = null;
  _statusBase = ''; _lastDensity = null; _loadingDetail = false;
  document.getElementById('breadcrumb').textContent = '';
  document.getElementById('btn-reset').style.display = 'none';

  statusEl.textContent = `Loading ${label}…`;

  try {
    const data = await fetch(file).then(r => r.json());
    render(data);
    document.getElementById('subtitle').textContent = isIPv6
      ? 'IPv6 prefix hierarchy: /32 → /48 → /64. Width = block size. Color = activity density.'
      : 'IPv4 prefix hierarchy: /8 → /16. Width = block size. Color = activity density.';
    _statusBase = `${data.parsed} addresses loaded. Click a cell to zoom in. Hover for details.`;
    _refreshStatus();
  } catch (e) {
    statusEl.textContent = `Error: ${e.message}`;
  }
}

document.getElementById('btn-ipv6').addEventListener('click', () => load(true));
document.getElementById('btn-ipv4').addEventListener('click', () => load(false));

document.getElementById('btn-reset').addEventListener('click', () => {
  if (fullRoot) { focusNode = fullRoot; renderView(); }
});
