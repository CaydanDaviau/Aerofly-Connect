// Ground plan of a bot at one airport, from the OSM taxi graph: a free stand, the taxi route stand -> hold short of the departure runway,
// the line-up point on the centre line, and the rollout + taxi route runway exit -> stand after landing. Pure (no I/O); static once built.
import { pickHold, route, exitAhead, noBackRunway, dist as gDist } from "./taxi.js";
const R = Math.PI / 180, M = 1852;
// ILS frame (see index.js ilsPos): along = nm before the threshold (negative = down the runway), cross = nm right of the centre line
export function toFrame(ils, p) {
  const H = ils.hdg * R, dx = (p.lon - ils.thr.lon) * 60 * Math.cos(ils.thr.lat * R), dy = (p.lat - ils.thr.lat) * 60;
  return { along: -(dx * Math.sin(H) + dy * Math.cos(H)), cross: dx * Math.cos(H) - dy * Math.sin(H) };
}
export function fromFrame(ils, along, cross) {
  const H = ils.hdg * R, e = -along * Math.sin(H) + cross * Math.cos(H), n = -along * Math.cos(H) - cross * Math.sin(H);
  return { lat: ils.thr.lat + n / 60, lon: ils.thr.lon + e / 60 / Math.cos(ils.thr.lat * R) };
}
const bearing = (a, b) => ((Math.atan2((b.lon - a.lon) * Math.cos((a.lat + b.lat) / 2 * R), b.lat - a.lat) / R) % 360 + 360) % 360;
const r6 = x => Math.round(x * 1e6) / 1e6, P = n => [r6(n.lat), r6(n.lon)];
const ids = (g, startId, path) => { const l = [startId]; for (const s of path) l.push(s.to); return l.map(id => g.nodes.get(id)); };

// g: taxi graph, ils: {thr, hdg, rwy}, used: Set of stand refs already taken at this airport. Returns null when nothing usable exists.
export function groundFor(g, ils, rwy, used = new Set()) {
  if (!g || !g.stands || !g.stands.length || !ils) return null;
  const stands = [...g.stands].filter(s => s.node && g.nodes.has(s.node) && !used.has(s.ref) && gDist(s.lat, s.lon, ils.thr.lat, ils.thr.lon) > 250)
    .sort((a, b) => gDist(a.lat, a.lon, ils.thr.lat, ils.thr.lon) - gDist(b.lat, b.lon, ils.thr.lat, ils.thr.lon));
  const p0 = fromFrame(ils, -0.16, 0);
  const ex = exitAhead(g, p0.lat, p0.lon, ils.hdg, 100);   // first taxiway exit that a landing aircraft can still reach
  if (!ex) return null;
  const fx = toFrame(ils, ex.node);
  if (!(fx.along < -0.2)) return null;
  for (const st of stands.slice(0, 40)) {
    const ph = pickHold(g, rwy, st.node);
    if (!ph) continue;
    const back = route(g, ex.node.id, st.node, noBackRunway(g, ex.rname, ils.hdg));
    if (!back) continue;
    const out = [P(st), ...ids(g, st.node, ph.path).map(P)], inn = [...ids(g, ex.node.id, back).map(P), P(st)];
    const hf = toFrame(ils, ph.node), lu = fromFrame(ils, Math.min(hf.along, 0), 0);
    const first = out[1] || out[0];
    return { ref: String(st.ref), stand: { lat: r6(st.lat), lon: r6(st.lon), hdg: Math.round(bearing(st, { lat: first[0], lon: first[1] })) }, out, lineup: P(lu), inRoll: Math.round(-fx.along * M), in: inn };
  }
  return null;
}
