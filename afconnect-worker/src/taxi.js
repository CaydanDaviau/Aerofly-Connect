// Taxiway graph (OpenFreeMap vector tiles, Overpass as fallback) + routing + spoken route text for the auto-ATC. Pure functions, no Worker APIs except fetchGraph.
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

// ---- data source 1: OpenFreeMap vector tiles (OpenMapTiles `aeroway` layer): static files on a CDN, no query server.
// ---- data source 2 (fallback): OSM via Overpass.
export const diag = { tiles: "", overpass: "" };
const TILEJSON = "https://tiles.openfreemap.org/planet", TILE_Z = 14, TILE_R = 3200;
let tplCache = null, tplAt = 0;
async function tileTemplate() {
  if (tplCache && Date.now() - tplAt < 6 * 3600_000) return tplCache;
  const r = await fetch(TILEJSON, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error("tilejson HTTP " + r.status);
  const j = await r.json(), t = Array.isArray(j.tiles) && j.tiles[0];
  if (!t) throw new Error("tilejson has no tiles");
  tplCache = t; tplAt = Date.now();
  return t;
}
async function tileBytes(resp) {
  let b = new Uint8Array(await resp.arrayBuffer());
  if (b.length > 2 && b[0] === 0x1f && b[1] === 0x8b) b = new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  return b;
}
async function tileGraph(lat, lon, r) {
  const tpl = await tileTemplate(), n = 2 ** TILE_Z;
  const tx = lo => Math.floor((lo + 180) / 360 * n), ty = la => { const s = Math.sin(la * rad); return Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n); };
  // shrink the radius until the tile count is small (tiles get narrower toward the poles: 25+ tiles at lat 55+ used to throw)
  let x0, x1, y0, y1;
  for (;;) {
    const dLat = r / 111320, dLon = r / (111320 * Math.cos(lat * rad));
    x0 = tx(lon - dLon); x1 = tx(lon + dLon); y0 = ty(lat + dLat); y1 = ty(lat - dLat);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 16 || r < 1200) break;
    r *= 0.85;
  }
  const jobs = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    jobs.push(fetch(tpl.replace("{z}", TILE_Z).replace("{x}", x).replace("{y}", y), { signal: AbortSignal.timeout(7000) }).then(async resp => {
      if (resp.status === 404 || resp.status === 204) return null;
      if (!resp.ok) throw new Error("tile HTTP " + resp.status);
      return { x, y, layers: decodeTile(await tileBytes(resp)) };
    }));
  }
  // one failed tile must not kill the whole graph: use what arrived, fail only if nothing did
  const res = await Promise.allSettled(jobs), ok = res.filter(s => s.status === "fulfilled" && s.value).map(s => s.value), bad = res.filter(s => s.status === "rejected");
  if (!ok.length && bad.length) throw new Error(`${bad.length}/${res.length} tiles failed: ${bad[0].reason && bad[0].reason.message || bad[0].reason}`);
  if (bad.length) diag.tiles = `${bad.length}/${res.length} tiles failed (partial graph)`;
  return graphFromTiles(ok, TILE_Z, lat, lon);
}

const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
export const query = (lat, lon, r) => `[out:json][timeout:20];(way["aeroway"~"^(taxiway|taxilane|runway)$"](around:${r},${lat},${lon});nwr["aeroway"~"^(gate|parking_position)$"](around:${r},${lat},${lon}););out geom tags;`;
export async function fetchGraph(lat, lon, r = 5000) {
  diag.tiles = diag.overpass = "";
  let g = null;
  try { g = await tileGraph(lat, lon, TILE_R); if (g) g.src = "tiles"; else diag.tiles = "no taxiway data in tiles"; } catch (e) { diag.tiles = String(e && e.message || e); }
  if (!g) for (const s of OVERPASS) {
    try {
      const resp = await fetch(s, { method: "POST", body: "data=" + encodeURIComponent(query(lat, lon, r)), headers: { "content-type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(9000) });
      if (!resp.ok) { diag.overpass = "HTTP " + resp.status; continue; }
      const gg = buildGraph(await resp.json());
      if (gg.edges.length) { g = gg; g.src = "overpass"; break; }
      diag.overpass = "no data";
    } catch (e) { diag.overpass = String(e && e.message || e); }
  }
  if (g) g.center = { lat, lon };
  return g;
}

// ---- minimal Mapbox Vector Tile reader (protobuf)
class Rd {
  constructor(b, p, e) { this.b = b; this.p = p || 0; this.e = e === undefined ? b.length : e; }
  varint() { let r = 0, m = 1, c; do { c = this.b[this.p++]; r += (c & 127) * m; m *= 128; } while (c & 128 && this.p < this.e + 1); return r; }
  tag() { const k = this.varint(); return [Math.floor(k / 8), k & 7]; }
  skip(w) { if (w === 0) this.varint(); else if (w === 1) this.p += 8; else if (w === 2) this.p += this.varint(); else if (w === 5) this.p += 4; else throw new Error("bad wire type " + w); }
  str(len) { let s = ""; for (let i = 0; i < len; i++) s += String.fromCharCode(this.b[this.p + i]); this.p += len; return decodeURIComponent(escape(s)); }
}
const zig = v => v % 2 ? -(v + 1) / 2 : v / 2;
function decodeGeom(b, p, e) {
  const rd = new Rd(b, p, e), parts = []; let cur = null, x = 0, y = 0;
  while (rd.p < e) {
    const c = rd.varint(), id = c & 7, cnt = Math.floor(c / 8);
    if (id === 7) { if (cur && cur.length) cur.push(cur[0]); continue; }
    for (let i = 0; i < cnt; i++) {
      x += zig(rd.varint()); y += zig(rd.varint());
      if (id === 1) { cur = []; parts.push(cur); }
      if (cur) cur.push([x, y]);
    }
  }
  return parts;
}
// -> { layerName: [{ extent, features: [{ type, props, parts }] }] }
export function decodeTile(buf) {
  const out = {}, top = new Rd(buf);
  while (top.p < top.e) {
    const [f, w] = top.tag();
    if (f !== 3 || w !== 2) { top.skip(w); continue; }
    const len = top.varint(), end = top.p + len, rd = new Rd(buf, top.p, end);
    let name = "", extent = 4096; const keys = [], vals = [], raw = [];
    while (rd.p < end) {
      const [lf, lw] = rd.tag();
      if (lf === 1 && lw === 2) name = rd.str(rd.varint());
      else if (lf === 2 && lw === 2) { const l = rd.varint(); raw.push([rd.p, rd.p + l]); rd.p += l; }
      else if (lf === 3 && lw === 2) keys.push(rd.str(rd.varint()));
      else if (lf === 4 && lw === 2) {
        const l = rd.varint(), ve = rd.p + l, vr = new Rd(buf, rd.p, ve); let v = null;
        while (vr.p < ve) {
          const [vf, vw] = vr.tag();
          if (vf === 1 && vw === 2) v = vr.str(vr.varint());
          else if (vf === 4 || vf === 5) v = vr.varint();
          else if (vf === 6) v = zig(vr.varint());
          else if (vf === 7) v = !!vr.varint();
          else vr.skip(vw);
        }
        vals.push(v); rd.p = ve;
      } else if (lf === 5 && lw === 0) extent = rd.varint();
      else rd.skip(lw);
    }
    const features = raw.map(([s, e]) => {
      const fr = new Rd(buf, s, e); let type = 0, tags = [], gp = -1, ge = 0;
      while (fr.p < e) {
        const [ff, fw] = fr.tag();
        if (ff === 2 && fw === 2) { const l = fr.varint(), te = fr.p + l; while (fr.p < te) tags.push(fr.varint()); }
        else if (ff === 3 && fw === 0) type = fr.varint();
        else if (ff === 4 && fw === 2) { const l = fr.varint(); gp = fr.p; ge = fr.p + l; fr.p = ge; }
        else fr.skip(fw);
      }
      const props = {}; for (let i = 0; i + 1 < tags.length; i += 2) props[keys[tags[i]]] = vals[tags[i + 1]];
      return { type, props, parts: gp >= 0 ? decodeGeom(buf, gp, ge) : [] };
    });
    (out[name] ||= []).push({ extent, features });
    top.p = end;
  }
  return out;
}

const normRef = s => { s = String(s).trim().toUpperCase(); return /^\d[LRC]?$/.test(s) ? "0" + s : s; };
// tiles [{x,y,layers}] -> same graph structure as buildGraph. Tile lines are simplified and clipped, so junctions and crossings are rebuilt geometrically.
export function graphFromTiles(tiles, z, lat0, lon0) {
  const world = 2 ** z, kx = Math.cos(lat0 * rad) * 111320, ky = 110574;
  const nodes = new Map(), segs = [], gates = [], aprons = [], rwRefs = new Map();
  let nid = 0; const grid = new Map(), CELL = 1.5;
  const mkNode = (lat, lon) => {
    const x = (lon - lon0) * kx, y = (lat - lat0) * ky, cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const n of grid.get((cx + i) + "," + (cy + j)) || []) if (Math.hypot(n.x - x, n.y - y) < 1.2) return n;
    const n = { id: "n" + (++nid), lat, lon, x, y, adj: [] };
    nodes.set(n.id, n);
    const k = cx + "," + cy; (grid.get(k) || grid.set(k, []).get(k)).push(n);
    return n;
  };
  let fi = 0;
  for (const t of tiles) for (const L of t.layers.aeroway || []) for (const f of L.features) {
    const cls = f.props.class, ext = L.extent || 4096, W = world * ext;
    const ll = ([px, py]) => { const gx = t.x * ext + px, gy = t.y * ext + py; return [Math.atan(Math.sinh(Math.PI * (1 - 2 * gy / W))) / rad, gx / W * 360 - 180]; };
    if (f.type === 2 && (cls === "taxiway" || cls === "runway")) {
      const kind = cls === "runway" ? "rwy" : "twy", ref = String(f.props.ref || "").trim();
      const name = kind === "rwy" ? ref.split(/[\/;]/).map(normRef).filter(Boolean).join("/") : ref;
      fi++;
      for (const part of f.parts) {
        const ns = part.map(pt => { const [la, lo] = ll(pt); return mkNode(la, lo); });
        for (let i = 0; i + 1 < ns.length; i++) if (ns[i] !== ns[i + 1]) segs.push({ a: ns[i], b: ns[i + 1], name, kind, f: fi, sp: [] });
        if (kind === "rwy" && name) { const a = rwRefs.get(name) || rwRefs.set(name, []).get(name); for (const n of ns) a.push(n); }
      }
    } else if (f.type === 1 && cls === "gate") {
      for (const part of f.parts) for (const pt of part) { const [la, lo] = ll(pt); if (!gates.some(s => s.ref === String(f.props.ref || "").trim() && dist(s.lat, s.lon, la, lo) < 4)) gates.push({ ref: String(f.props.ref || "").trim(), lat: la, lon: lo, node: null }); }
    } else if (f.type === 3 && cls === "apron") {
      for (const ring of f.parts) { if (ring.length < 4) continue; let sa = 0, so = 0; const pts = ring.slice(0, -1).map(ll); for (const [la, lo] of pts) { sa += la; so += lo; } const c = { ref: "", lat: sa / pts.length, lon: so / pts.length, node: null }; if (!aprons.some(s => dist(s.lat, s.lon, c.lat, c.lon) < 30)) aprons.push(c); }
    }
  }
  // noding: split segments where another feature crosses them or ends/bends on them (simplification drops shared vertices)
  const bin = new Map(), BC = 80;
  segs.forEach((s, i) => {
    const x0 = Math.floor(Math.min(s.a.x, s.b.x) / BC), x1 = Math.floor(Math.max(s.a.x, s.b.x) / BC), y0 = Math.floor(Math.min(s.a.y, s.b.y) / BC), y1 = Math.floor(Math.max(s.a.y, s.b.y) / BC);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const k = x + "," + y; (bin.get(k) || bin.set(k, []).get(k)).push(i); }
  });
  const proj = (p, s) => { const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y, l2 = dx * dx + dy * dy, t = l2 ? ((p.x - s.a.x) * dx + (p.y - s.a.y) * dy) / l2 : 0, len = Math.sqrt(l2); return { t, len, d: Math.hypot(p.x - (s.a.x + t * dx), p.y - (s.a.y + t * dy)) }; };
  const done = new Set();
  for (const list of bin.values()) for (let u = 0; u < list.length; u++) for (let v = u + 1; v < list.length; v++) {
    const i = Math.min(list[u], list[v]), j = Math.max(list[u], list[v]), key = i * 1e6 + j;
    if (done.has(key)) continue; done.add(key);
    const s = segs[i], q = segs[j];
    if (s.f === q.f) continue;
    // proper crossing
    const rx = s.b.x - s.a.x, ry = s.b.y - s.a.y, sx = q.b.x - q.a.x, sy = q.b.y - q.a.y, den = rx * sy - ry * sx;
    if (Math.abs(den) > 1e-9) {
      const t = ((q.a.x - s.a.x) * sy - (q.a.y - s.a.y) * sx) / den, w = ((q.a.x - s.a.x) * ry - (q.a.y - s.a.y) * rx) / den, ls = Math.hypot(rx, ry), lq = Math.hypot(sx, sy);
      if (t * ls > 1.5 && (1 - t) * ls > 1.5 && w * lq > 1.5 && (1 - w) * lq > 1.5) {
        const x = s.a.x + t * rx, y = s.a.y + t * ry, n = mkNode(lat0 + y / ky, lon0 + x / kx);
        s.sp.push({ t, n }); q.sp.push({ t: w, n });
        continue;
      }
    }
    // a vertex of one lies on the other: join
    for (const [a, b] of [[s, q], [q, s]]) for (const e of [b.a, b.b]) {
      if (e === a.a || e === a.b) continue;
      const pr = proj(e, a);
      if (pr.d < 2.5 && pr.t * pr.len > 1.5 && (1 - pr.t) * pr.len > 1.5) a.sp.push({ t: pr.t, n: e });
    }
  }
  const edges = [], seenE = new Set();
  for (const s of segs) {
    const pts = [s.a, ...s.sp.sort((p, q) => p.t - q.t).map(p => p.n), s.b];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1]; if (a === b) continue;
      const k = (a.id < b.id ? a.id + "|" + b.id : b.id + "|" + a.id) + s.kind; if (seenE.has(k)) continue; seenE.add(k);
      const ed = { a: a.id, b: b.id, len: dist(a.lat, a.lon, b.lat, b.lon), name: s.name, kind: s.kind, i: edges.length };
      edges.push(ed); a.adj.push(ed.i); b.adj.push(ed.i);
    }
  }
  // runways: the two far ends over all tile pieces of one ref
  const runways = [];
  for (const [name, ns] of rwRefs) {
    let a = ns[0], b = a; for (const n of ns) if (Math.hypot(n.x - a.x, n.y - a.y) > Math.hypot(b.x - a.x, b.y - a.y)) b = n;
    a = b; b = ns[0]; for (const n of ns) if (Math.hypot(n.x - a.x, n.y - a.y) > Math.hypot(b.x - a.x, b.y - a.y)) b = n;
    runways.push({ refs: name.split("/"), a: { lat: a.lat, lon: a.lon }, b: { lat: b.lat, lon: b.lon } });
  }
  const g = { nodes, edges, stands: [], runways };
  let stands = gates.map(s => ({ s, r: 160 }));
  if (!stands.length) stands = aprons.map(s => ({ s, r: 300 }));
  for (const { s, r } of stands) { const n = nearest(g, s.lat, s.lon, r, true); if (n) { s.node = n.id; g.stands.push(s); } }
  return g.edges.length ? g : null;
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
  const z = x => String(x).replace(/^0+(?=\d)/, ""), rw = g.runways.find(r => r.refs.some(x => z(x) === z(ident)));
  if (!rw) return null;
  const num = parseInt(ident, 10) * 10;
  const h = bearing(rw.a.lat, rw.a.lon, rw.b.lat, rw.b.lon);
  return angDiff(h, num) < 90 ? { thr: rw.a, far: rw.b } : { thr: rw.b, far: rw.a };
}
// taxiway nodes to hold short at: 25-110 m off the runway centre line, nearest the threshold, ONE PER SIDE of the runway (nearest first)
export function holdNodes(g, ident) {
  const e = runwayEnds(g, ident);
  if (!e) return [];
  const k = Math.cos(e.thr.lat * rad), bx = (e.far.lon - e.thr.lon) * k, by = e.far.lat - e.thr.lat, side = {};
  for (const n of g.nodes.values()) {
    if (!n.adj.some(i => g.edges[i].kind === "twy") || n.adj.some(i => g.edges[i].kind === "rwy")) continue;
    const off = distSeg(n.lat, n.lon, e.thr, e.far);
    if (off < 25 || off > 110) continue;
    const d = dist(n.lat, n.lon, e.thr.lat, e.thr.lon), sd = bx * (n.lat - e.thr.lat) - by * (n.lon - e.thr.lon) * k > 0 ? 1 : -1;
    if (!side[sd] || d < side[sd].d) side[sd] = { n, d };
  }
  return Object.values(side).sort((a, b) => a.d - b.d).map(x => x.n);
}
export const holdNode = (g, ident) => holdNodes(g, ident)[0] || null;
// does the path cross or use the runway `ident` (after its leading rollout part)?
function crossesRunway(g, path, ident) {
  const z = x => String(x).replace(/^0+(?=\d)/, "").toUpperCase(), want = new Set((runwayEnds(g, ident) ? g.runways.find(r => r.refs.some(x => z(x) === z(ident))).refs : [ident]).map(z));
  const isT = e => e.kind === "rwy" && String(e.name).split(/[\/;]/).some(x => want.has(z(x.trim())));
  let lead = true;
  for (let i = 0; i < path.length; i++) {
    const e = path[i].e;
    if (e.kind !== "rwy") lead = false;
    else if (!lead && isT(e)) return true;
    const nx = path[i + 1];
    if (nx && e.kind === "twy" && nx.e.kind === "twy" && g.nodes.get(path[i].to).adj.some(k => isT(g.edges[k]))) return true;
  }
  return false;
}
// hold-short point of a runway for an aircraft at fromId: the side it reaches WITHOUT crossing that runway (crossing it would end in a 180 deg turn back onto it)
export function pickHold(g, ident, fromId, extra) {
  let best = null;
  for (const n of holdNodes(g, ident)) {
    const path = n.id === fromId ? [] : route(g, fromId, n.id, extra);
    if (!path) continue;
    const cost = path.reduce((a, s) => a + s.e.len * (s.e.kind === "rwy" ? 15 : 1), 0) + (crossesRunway(g, path, ident) ? 5000 : 0);
    if (!best || cost < best.cost) best = { node: n, path, cost };
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

// ---- heading-aware start: a moving aircraft cannot turn back on the spot.
// startFor: nearest node, but nodes behind a moving aircraft (> 90 deg off its heading) are penalised so the route starts ahead.
export function startFor(g, lat, lon, hdg, gs, maxM = 500) {
  if (!(gs >= 3) || !Number.isFinite(hdg)) return nearest(g, lat, lon, maxM);
  let best = null, bs = Infinity;
  for (const n of g.nodes.values()) {
    const d = dist(lat, lon, n.lat, n.lon); if (d > maxM) continue;
    const behind = d > 12 && angDiff(bearing(lat, lon, n.lat, n.lon), hdg) > 90;
    const s = d + (behind ? 400 : 0);
    if (s < bs) { bs = s; best = n; }
  }
  return best;
}
// wraps an extra-cost function: from the start node, edges that lead back against the heading cost +1500 m (a reversal only if nothing else exists)
export function noUturn(g, startId, lat, lon, hdg, gs, extra) {
  if (!(gs >= 3) || !Number.isFinite(hdg)) return extra;
  return (e, fromId) => {
    let x = extra ? extra(e, fromId) : 0;
    if (fromId === startId) {
      const s = g.nodes.get(startId), o = g.nodes.get(e.a === fromId ? e.b : e.a);
      if (s && o && angDiff(bearing(s.lat, s.lon, o.lat, o.lon), hdg) > 100) x += 1500;
    }
    return x;
  };
}
