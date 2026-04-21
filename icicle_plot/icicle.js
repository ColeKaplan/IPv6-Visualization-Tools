// ─── Constants ────────────────────────────────────────────────────────────────
const ROW_H   = 48;
const ROW_GAP = 6;
const ML      = 60; // left margin for axis labels

const color = d3.scaleSequential(d3.interpolateYlOrRd).domain([0, 1]);

// ─── State ────────────────────────────────────────────────────────────────────
let fullRoot       = null;
let focusNode      = null;
let rawData        = null;
let _loadingDetail = false;
let _statusBase    = '';
let _lastDensity   = null;
let hoveredNode    = null;
let breadcrumbPath = []; // array of {name, node} for clickable nav

// Hit-test state
let nodeRows     = null;
let hitXOffset   = 0;
let hitXScale    = 1;
let hitBaseDepth = 0;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const canvas        = document.getElementById('chart');
const overlayCanvas = document.getElementById('overlay');
const ctx           = canvas.getContext('2d');
const octx          = overlayCanvas.getContext('2d');
const tooltip       = document.getElementById('tooltip');
const emptyState    = document.getElementById('empty-state');

// ─── Status ───────────────────────────────────────────────────────────────────
function _refreshStatus() {
  if (!_statusBase) return;
  const el = document.getElementById('status');
  el.textContent = _statusBase;

  const badge = document.getElementById('density-badge');
  if (_lastDensity !== null) {
    badge.textContent = `density ${_lastDensity.toFixed(2)}%`;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

// ─── Breadcrumb ───────────────────────────────────────────────────────────────
function renderBreadcrumb() {
  const inner = document.getElementById('breadcrumb-inner');
  inner.innerHTML = '';

  const path = [];
  let n = focusNode;
  while (n) { path.unshift(n); n = n.parent; }

  path.forEach((node, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'bc-sep';
      sep.textContent = '›';
      inner.appendChild(sep);
    }

    const seg = document.createElement('span');
    seg.className = 'bc-segment' + (i === path.length - 1 ? ' active' : '');
    seg.textContent = i === 0 ? 'Root' : node.data.name;

    if (i < path.length - 1) {
      seg.addEventListener('click', () => {
        focusNode = node;
        renderView();
      });
    }

    inner.appendChild(seg);
  });
}

// ─── Overlay: hover glow ──────────────────────────────────────────────────────
function renderHover() {
  const dpr = window.devicePixelRatio || 1;
  octx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  if (!hoveredNode || hoveredNode.data.gap) return;

  const xOffset   = focusNode.x0;
  const xScale    = (canvas.style.width ? parseInt(canvas.style.width) - ML : 800) /
                    (focusNode.x1 - focusNode.x0);
  const baseDepth = focusNode.depth;

  const x = (ML + (hoveredNode.x0 - xOffset) * xScale) * dpr;
  const y = (hoveredNode.depth - baseDepth) * (ROW_H + ROW_GAP) * dpr;
  const w = Math.max(0, (hoveredNode.x1 - hoveredNode.x0) * xScale - 1) * dpr;
  const h = ROW_H * dpr;

  if (w < 1) return;

  octx.save();
  // Glow shadow
  octx.shadowBlur  = 18 * dpr;
  octx.shadowColor = 'rgba(255,120,30,0.55)';
  octx.strokeStyle = 'rgba(255,255,255,0.95)';
  octx.lineWidth   = 2 * dpr;
  octx.strokeRect(x + dpr, y + dpr, w - 2 * dpr, h - 2 * dpr);

  // Bright top highlight stripe
  octx.shadowBlur  = 0;
  octx.fillStyle   = 'rgba(255,255,255,0.22)';
  octx.fillRect(x, y, w, h * 0.35);

  octx.restore();
}

// ─── Main render ──────────────────────────────────────────────────────────────
function renderView() {
  const resetBtn = document.getElementById('btn-reset');

  emptyState.classList.add('hidden');

  const W         = Math.max(window.innerWidth - ML - 96, 800);
  const remaining = fullRoot.height - focusNode.depth;
  const H         = (remaining + 1) * (ROW_H + ROW_GAP);

  const dpr = window.devicePixelRatio || 1;
  canvas.width        = (W + ML) * dpr;
  canvas.height       = H * dpr;
  canvas.style.width  = (W + ML) + 'px';
  canvas.style.height = H + 'px';

  overlayCanvas.width        = (W + ML) * dpr;
  overlayCanvas.height       = H * dpr;
  overlayCanvas.style.width  = (W + ML) + 'px';
  overlayCanvas.style.height = H + 'px';

  ctx.scale(dpr, dpr);

  const xOffset   = focusNode.x0;
  const xScale    = W / (focusNode.x1 - focusNode.x0);
  const baseDepth = focusNode.depth;

  resetBtn.style.display = (focusNode === fullRoot) ? 'none' : '';

  renderBreadcrumb();

  const descendants = focusNode.descendants();

  // Build hit-test index
  nodeRows     = new Map();
  hitXOffset   = xOffset;
  hitXScale    = xScale;
  hitBaseDepth = baseDepth;
  for (const d of descendants) {
    const rd = d.depth - baseDepth;
    if (!nodeRows.has(rd)) nodeRows.set(rd, []);
    nodeRows.get(rd).push(d);
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Subtle row background stripes
  const seen2 = new Set();
  for (const d of descendants) {
    const relDepth = d.depth - baseDepth;
    if (seen2.has(relDepth)) continue;
    seen2.add(relDepth);
    if (relDepth % 2 === 1) {
      ctx.fillStyle = 'rgba(0,0,0,0.018)';
      ctx.fillRect(0, relDepth * (ROW_H + ROW_GAP) - ROW_GAP / 2, W + ML, ROW_H + ROW_GAP);
    }
  }

  // Draw cells
  let filledPx = 0;
  let skippedSubpixel = 0;

  for (const d of descendants) {
    const x = ML + (d.x0 - xOffset) * xScale;
    const y = (d.depth - baseDepth) * (ROW_H + ROW_GAP);

    if (d.data.gap) {
      const gapW = Math.min(20, Math.max(4, Math.log2(d.data.gap_size + 1)));
      // Draw gap as subtle hatched bar
      ctx.fillStyle = '#d8d5cf';
      ctx.fillRect(x, y + 2, gapW, ROW_H - 4);
      // Diagonal hatch pattern
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y + 2, gapW, ROW_H - 4);
      ctx.clip();
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 1;
      for (let hx = x - ROW_H; hx < x + gapW + ROW_H; hx += 4) {
        ctx.beginPath();
        ctx.moveTo(hx, y + 2);
        ctx.lineTo(hx + ROW_H, y + ROW_H - 2);
        ctx.stroke();
      }
      ctx.restore();
      continue;
    }

    const w = Math.max(0, (d.x1 - d.x0) * xScale - 1);
    if (w < 0.5) { skippedSubpixel++; continue; }

    if (d.data.count > 0) filledPx += w * ROW_H;

    const ratio = d.parent && d.parent._sibMax > 0
      ? d.data.count / d.parent._sibMax
      : 0;

    if (d === focusNode) {
      ctx.fillStyle = '#e8e6e1';
    } else {
      ctx.fillStyle = color(ratio);
    }
    ctx.fillRect(x, y, w, ROW_H);

    // Subtle top-highlight sheen
    if (d !== focusNode && ratio > 0) {
      const grad = ctx.createLinearGradient(0, y, 0, y + ROW_H);
      grad.addColorStop(0, 'rgba(255,255,255,0.18)');
      grad.addColorStop(0.4, 'rgba(255,255,255,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, w, ROW_H);
    }

    // 1px border — use white for colored cells, soft gray for root cell
    ctx.strokeStyle = d === focusNode ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, ROW_H - 1);

    // Text label
    if (d !== focusNode && w > 72) {
      const brightness = ratio > 0.55 ? 1 : 0;
      ctx.fillStyle = brightness === 1
        ? 'rgba(255,255,255,0.92)'
        : 'rgba(26,25,22,0.75)';
      ctx.font = `500 10.5px 'JetBrains Mono', monospace`;
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'middle';
      const maxChars = Math.floor((w - 12) / 7.5);
      const raw = d.data.name || '';
      const label = raw.length > maxChars
        ? raw.slice(0, Math.max(maxChars - 1, 3)) + '…'
        : raw;
      ctx.fillText(label, x + 6, y + ROW_H / 2);
    }
  }

  // Axis labels
  const seenDepths = new Set();
  for (const d of descendants) {
    const relDepth = d.depth - baseDepth;
    if (seenDepths.has(relDepth)) continue;
    seenDepths.add(relDepth);
    const label = relDepth === 0
      ? (focusNode === fullRoot ? 'Root' : `/${focusNode.data.level}`)
      : `/${d.data.level}`;

    const yMid = relDepth * (ROW_H + ROW_GAP) + ROW_H / 2;

    // Light rule line extending from axis
    ctx.strokeStyle = 'rgba(0,0,0,0.06)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(ML, relDepth * (ROW_H + ROW_GAP));
    ctx.lineTo(ML, relDepth * (ROW_H + ROW_GAP));
    ctx.stroke();

    ctx.fillStyle    = '#9d9a94';
    ctx.font         = `400 11px 'JetBrains Mono', monospace`;
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, ML - 8, yMid);
  }

  _lastDensity = (filledPx / ((W + ML) * H)) * 100;
  _refreshStatus();

  // Re-render hover on top
  renderHover();
}

// ─── Hit testing ──────────────────────────────────────────────────────────────
function nodeAtPoint(cx, cy) {
  if (!nodeRows) return null;
  const relDepth = Math.floor(cy / (ROW_H + ROW_GAP));
  if (cy - relDepth * (ROW_H + ROW_GAP) >= ROW_H) return null;
  const row = nodeRows.get(relDepth);
  if (!row) return null;
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

// ─── nameToHex48 ──────────────────────────────────────────────────────────────
function nameToHex48(name) {
  const addr = name.replace(/\/\d+$/, '');
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

// ─── loadDetail64 ─────────────────────────────────────────────────────────────
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
      d.data.children = detail.children;
      _buildAndPartition();
      focusNode = fullRoot.descendants().find(n => n.data.name === nodeName) || fullRoot;
    } else {
      focusNode = d;
    }
  } catch (_) {
    focusNode = d;
  }

  _statusBase = prevBase;
  _loadingDetail = false;
  renderView();
}

// ─── Build + partition ────────────────────────────────────────────────────────
function _buildAndPartition() {
  fullRoot = d3.hierarchy(rawData.tree)
    .sum(d => d.gap ? 1 : d.count)
    .sort((a, b) => {
      if (a.data.sort_key !== undefined && b.data.sort_key !== undefined)
        return a.data.sort_key - b.data.sort_key;
      return a.data.name < b.data.name ? -1 : 1;
    });

  fullRoot.each(d => {
    if (d.children) {
      let m = 0;
      for (const c of d.children) if (!c.data.gap && c.data.count > m) m = c.data.count;
      d._sibMax = m;
    }
  });

  const W = Math.max(window.innerWidth - ML - 96, 800);
  d3.partition().size([W, 1])(fullRoot);
}

function render(data) {
  rawData = data;
  _buildAndPartition();
  focusNode = fullRoot;
  renderView();
}

// ─── Tooltip helpers ──────────────────────────────────────────────────────────
function showTooltip(d, clientX, clientY) {
  if (d.data.gap) {
    tooltip.innerHTML = `
      <div class="tt-name">Gap region</div>
      <div class="tt-gap">~${d.data.gap_size.toLocaleString()} empty /32 blocks</div>`;
  } else {
    const share = ((d.data.count / fullRoot.value) * 100).toFixed(3);
    const level = d.data.level ? `/${d.data.level}` : '';
    tooltip.innerHTML = `
      <div class="tt-name">${d.data.name}</div>
      <div class="tt-row"><span>Level</span><span>${level}</span></div>
      <div class="tt-row"><span>Count</span><span>${d.data.count.toLocaleString()}</span></div>
      <div class="tt-row"><span>Share</span><span>${share}%</span></div>`;
  }
  tooltip.style.opacity = 1;
  tooltip.style.left    = (clientX + 14) + 'px';
  tooltip.style.top     = (clientY - 10) + 'px';
}

// ─── Canvas events ────────────────────────────────────────────────────────────
canvas.addEventListener('click', event => {
  if (!fullRoot || _loadingDetail) return;
  const rect = canvas.getBoundingClientRect();
  const d = nodeAtPoint(event.clientX - rect.left, event.clientY - rect.top);
  if (!d || d.data.gap) return;

  if (d.data.level === 48) {
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
    const clickable = !d.data.gap && (d.children || d.data.level === 48);
    canvas.style.cursor = clickable ? 'pointer' : 'default';
    showTooltip(d, event.clientX, event.clientY);

    if (d !== hoveredNode) {
      hoveredNode = d;
      renderHover();
    }
  } else {
    canvas.style.cursor = 'default';
    tooltip.style.opacity = 0;
    if (hoveredNode !== null) {
      hoveredNode = null;
      renderHover();
    }
  }
});

canvas.addEventListener('mouseleave', () => {
  tooltip.style.opacity = 0;
  if (hoveredNode !== null) {
    hoveredNode = null;
    renderHover();
  }
});

// ─── Load & buttons ───────────────────────────────────────────────────────────
async function load(isIPv6) {
  const file  = isIPv6 ? 'data/ipv6-hierarchy.json' : 'data/ipv4-hierarchy.json';
  const label = isIPv6 ? 'IPv6' : 'IPv4';

  fullRoot = null; focusNode = null; nodeRows = null; rawData = null;
  _statusBase = ''; _lastDensity = null; _loadingDetail = false;
  hoveredNode = null;

  document.getElementById('breadcrumb-inner').innerHTML = '';
  document.getElementById('btn-reset').style.display = 'none';
  document.getElementById('protocol-badge').textContent = label;
  document.getElementById('density-badge').style.display = 'none';

  const statusEl = document.getElementById('status');
  statusEl.textContent = `Loading ${label} data…`;

  // Show loading shimmer
  emptyState.classList.add('hidden');
  canvas.style.display = 'block';

  try {
    const data = await fetch(file).then(r => r.json());
    render(data);
    document.getElementById('subtitle').textContent = isIPv6
      ? 'IPv6 prefix hierarchy: /32 → /48 → /64. Width encodes block size. Color encodes activity density.'
      : 'IPv4 prefix hierarchy: /8 → /16. Width encodes block size. Color encodes activity density.';
    _statusBase = `${Number(data.parsed).toLocaleString()} addresses loaded — click a cell to zoom, hover for details`;
    _refreshStatus();
  } catch (e) {
    statusEl.textContent = `Error loading data: ${e.message}`;
    emptyState.classList.remove('hidden');
  }
}

document.getElementById('btn-ipv6').addEventListener('click', () => load(true));
document.getElementById('btn-ipv4').addEventListener('click', () => load(false));
document.getElementById('btn-reset').addEventListener('click', () => {
  if (fullRoot) { focusNode = fullRoot; renderView(); }
});

window.addEventListener('resize', () => {
  if (fullRoot) {
    _buildAndPartition();
    renderView();
  }
});