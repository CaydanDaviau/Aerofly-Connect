// Taxiway graph (OSM via Overpass) + routing + spoken route text for the auto-ATC. Pure functions, no Worker APIs except fetchGraph.
const R = 6371000, rad = Math.PI / 180;
export const dist = (a, b, c, d) => { const x = (d - b) * rad * Math.cos((a + c) / 2 * rad), y = (c - a) * rad; return Math.hypot(x, y) * R; };
const bearing = (a, b, c, d) => { const y = Math.sin((d - b) * rad) * Math.cos(c * rad), x = Math.cos(a * rad) * Math.sin(c * rad) - Math.sin(a * rad) * Math.cos(c * rad) * Math.cos((d - b) * rad); return (Math.atan2(y, x) / rad + 360) % 360; };
const angDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
// distance (m) from a point to the segment a-b
export function distSeg(la, lo, a, b) {
  const k = Math.cos(la * rad) * R * rad, m = R * rad;
  const px = (lo - a.lon) * k, py = (la - a.lat) * m, bx = (b.lon - a.lon) * k, by = (b.lat - a.lat) * m, l2 = bx * bx + by * by;
  const t = l2 ? Math.max(0, Math.min(1, (px * bx + py * by) / l2)) : 0;
  return Math.hypot(px - t * bx, py - t * by);
}

const SERVERS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
export const query = (lat, lon, r) => `[out:json][timeout:20];(way["aeroway"~"^(taxiway|taxilane|runway)$"](around:${r},${lat},${lon});nwr["aeroway"~"^(gate|parking_position)$"](around:${r},${lat},${lon}););out geom tags;`;
export async function fetchGraph(lat, lon, r = 5000) {
  for (const s of SERVERS) {
    try {
      const resp = await fetch(s, { method: "POST", body: "data=" + encodeURIComponent(query(lat, lon, r)), headers: { "content-type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(9000) });
      if (!resp.ok) continue;
      const g = buildGraph(await resp.json());
      if (g.edges.length) { g.center = { lat, lon }; return g; }
    } catch (e) {}
  }
  return null;
}

// ---- graph: nodes {id: {lat, lon, adj: [edgeIdx]}}, edges {a, b, len, name, kind: "twy"|"rwy"}, stands [{ref, node, lat, lon}], runways [{refs, a:{lat,lon}, b:{lat,lon}}]
export function buildGraph(j) {
  const nodes = new Map(), edges = [], stands = [], runways = [];
  const node = (id, lat, lon) => { let n = nodes.get(id); if (!n) nodes.set(id, n = { id, lat, lon, adj: [] }); return n; };
  for (const e of j.elements || []) {
    const tg = e.tags || {}, ae = tg.aeroway;
    if (e.type === "way" && (ae === "taxiway" || ae === "taxilane" || ae === "runway") && e.geometry && e.nodes && e.geometry.length === e.nodes.length) {
      const kind = ae === "runway" ? "rwy" : "twy", name = String(tg.ref || (kind === "twy" ? tg.name : "") || "").trim();
      for (let i = 0; i < e.nodes.length; i++) node(e.nodes[i], e.geometry[i].lat, e.geometry[i].lon);
      for (let i = 0; i + 1 < e.nodes.length; i++) {
        const a = nodes.get(e.nodes[i]), b = nodes.get(e.nodes[i + 1]);
        if (a === b) continue;
        const ed = { a: a.id, b: b.id, len: dist(a.lat, a.lon, b.lat, b.lon), name, kind, i: edges.length };
        edges.push(ed); a.adj.push(ed.i); b.adj.push(ed.i);
      }
      if (kind === "rwy") { const g = e.geometry; runways.push({ refs: name.split(/[\/;]/).map(s => s.trim().toUpperCase()).filter(Boolean), a: g[0], b: g[g.length - 1] }); }
    } else if ((ae === "gate" || ae === "parking_position") && (e.lat !== undefined || e.center || e.geometry)) {
      const p = e.lat !== undefined ? { lat: e.lat, lon: e.lon } : e.center || e.geometry[0];
      stands.push({ ref: String(tg.ref || tg.name || "").trim(), lat: p.lat, lon: p.lon, node: null });
    }
  }
  const g = { nodes, edges, stands, runways };
  for (const s of stands) { const n = nearest(g, s.lat, s.lon, 160, true); if (n) s.node = n.id; }
  g.stands = stands.filter(s => s.node !== null);
  return g;
}
// nearest graph node; twyOnly = skip nodes that only touch runways
export function nearest(g, lat, lon, maxM = 1e9, twyOnly = false) {
  let best = null, bd = maxM;
  for (const n of g.nodes.values()) {
    if (twyOnly && !n.adj.some(i => g.edges[i].kind === "twy")) continue;
    const d = dist(lat, lon, n.lat, n.lon);
    if (d < bd) { bd = d; best = n; }
  }
  return best;
}

// runway end data for an ident ("29L"): threshold + far end, from the way whose ref has that ident
export function runwayEnds(g, ident) {
  const rw = g.runways.find(r => r.refs.includes(ident));
  if (!rw) return null;
  const num = parseInt(ident, 10) * 10;
  const h = bearing(rw.a.lat, rw.a.lon, rw.b.lat, rw.b.lon);
  return angDiff(h, num) < 90 ? { thr: rw.a, far: rw.b } : { thr: rw.b, far: rw.a };
}
// taxiway node to hold short at: 25-110 m off the runway centre line, nearest the threshold
export function holdNode(g, ident) {
  const e = runwayEnds(g, ident);
  if (!e) return null;
  let best = null, bd = 1e9;
  for (const n of g.nodes.values()) {
    if (!n.adj.some(i => g.edges[i].kind === "twy") || n.adj.some(i => g.edges[i].kind === "rwy")) continue;
    const off = distSeg(n.lat, n.lon, e.thr, e.far);
    if (off < 25 || off > 110) continue;
    const d = dist(n.lat, n.lon, e.thr.lat, e.thr.lon);
    if (d < bd) { bd = d; best = n; }
  }
  return best;
}

// Dijkstra. opts.cost(edge, fromId) -> extra metres. Runway edges cost x15 (crossing only in practice).
export function route(g, fromId, toId, extra) {
  const dm = new Map([[fromId, 0]]), prev = new Map(), done = new Set();
  const heap = [[0, fromId]];
  const push = it => { heap.push(it); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const t = heap[0], l = heap.pop(); if (heap.length) { heap[0] = l; let i = 0; for (;;) { let m = i; const a = 2 * i + 1, b = a + 1; if (a < heap.length && heap[a][0] < heap[m][0]) m = a; if (b < heap.length && heap[b][0] < heap[m][0]) m = b; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return t; };
  while (heap.length) {
    const [d, id] = pop();
    if (done.has(id)) continue;
    done.add(id);
    if (id === toId) break;
    for (const ei of g.nodes.get(id).adj) {
      const e = g.edges[ei], nx = e.a === id ? e.b : e.a;
      if (done.has(nx)) continue;
      const c = d + e.len * (e.kind === "rwy" ? 15 : 1) + (extra ? extra(e, id) : 0);
      if (c < (dm.get(nx) ?? Infinity)) { dm.set(nx, c); prev.set(nx, [id, ei]); push([c, nx]); }
    }
  }
  if (!prev.has(toId) && fromId !== toId) return null;
  const path = [];
  for (let n = toId; n !== fromId;) { const [p, ei] = prev.get(n); path.push({ e: g.edges[ei], from: p, to: n }); n = p; }
  return path.reverse();
}

// ---- spoken text
const NATO = { A: "Alpha", B: "Bravo", C: "Charlie", D: "Delta", E: "Echo", F: "Foxtrot", G: "Golf", H: "Hotel", I: "India", J: "Juliet", K: "Kilo", L: "Lima", M: "Mike", N: "November", O: "Oscar", P: "Papa", Q: "Quebec", R: "Romeo", S: "Sierra", T: "Tango", U: "Uniform", V: "Victor", W: "Whiskey", X: "X-ray", Y: "Yankee", Z: "Zulu" };
export const spokenName = n => /^[A-Za-z]{1,2}\d{0,2}$/.test(n) ? n.toUpperCase().replace(/[A-Z]/g, c => NATO[c] + " ").replace(/(\d+)/g, "$1 ").trim().replace(/\s+/g, " ") : n;
const baseRwy = ref => String(ref || "").split(/[\/;]/)[0].trim();

// Compress a path into legs: {kind:"twy", name} | {kind:"rwy", refs, at:index of first edge}. Unnamed taxi edges join the previous leg.
export function legs(path, g) {
  const out = [];
  path.forEach((s, i) => {
    const e = s.e, last = out[out.length - 1];
    if (e.kind === "rwy") { if (last && last.kind === "rwy" && last.name === e.name) last.len += e.len; else out.push({ kind: "rwy", name: e.name, len: e.len, from: s.from }); return; }
    if (!e.name) { if (last) last.len += e.len; else out.push({ kind: "twy", name: "", len: e.len, from: s.from }); }
    else if (last && last.kind === "twy" && (!last.name || last.name === e.name)) { last.name = e.name; last.len += e.len; }
    else out.push({ kind: "twy", name: e.name, len: e.len, from: s.from });
    // a taxiway that runs on through a node shared with a runway crosses that runway
    const nx = path[i + 1];
    if (g && nx && nx.e.kind === "twy") {
      const re = g.nodes.get(s.to).adj.map(k => g.edges[k]).find(x => x.kind === "rwy");
      if (re) out.push({ kind: "rwy", name: re.name, len: 0, from: s.to, cross: true });
    }
  });
  return out;
}
