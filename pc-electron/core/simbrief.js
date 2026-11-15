// SimBrief import (public fetcher, no API key). Same mapping as the Android SimBrief.parse.
const MAX_POINTS = 150;

function thin(all, max) {
  const n = all.length; if (n <= max) return all;
  const out = []; for (let i = 0; i < max; i++) out.push(all[Math.round(i * (n - 1) / (max - 1))]); return out;
}

function parse(j) {
  const p = { error: "", callsign: "", dep: "", arr: "", depRwy: "", arrRwy: "", model: "", cruise: "", route: "", points: [] };
  try {
    const st = (j.fetch && j.fetch.status) || "";
    if (st && !String(st).toLowerCase().startsWith("success")) {
      const l = String(st).toLowerCase();
      p.error = /user|pilot|id/.test(l) ? "user" : "noplan"; if (/no flight|no plan/.test(l)) p.error = "noplan"; return p;
    }
    const o = j.origin, d = j.destination, g = j.general || {}, a = j.atc || {}, ac = j.aircraft || {};
    if (!o || !d) { p.error = "noplan"; return p; }
    p.dep = String(o.icao_code || "").toUpperCase(); p.arr = String(d.icao_code || "").toUpperCase();
    p.depRwy = String(o.plan_rwy || "").toUpperCase(); p.arrRwy = String(d.plan_rwy || "").toUpperCase();
    p.callsign = String(a.callsign || "").toUpperCase();
    if (!p.callsign) p.callsign = (String(g.icao_airline || "") + String(g.flight_number || "")).toUpperCase();
    p.cruise = String(g.initial_altitude || ""); p.route = String(g.route || "");
    p.model = String(ac.icaocode || "").toUpperCase();
    if (!p.dep || !p.arr) { p.error = "noplan"; return p; }
    let fx = j.navlog && j.navlog.fix; if (fx && !Array.isArray(fx)) fx = [fx];
    const all = [];
    for (const f of fx || []) {
      const la = parseFloat(f.pos_lat), lo = parseFloat(f.pos_long);
      if (Number.isFinite(la) && Number.isFinite(lo)) all.push([la, lo, parseInt(f.altitude_feet) || 0, String(f.ident || "")]);
    }
    p.points = thin(all, MAX_POINTS);
  } catch (e) { p.error = "bad"; }
  return p;
}

async function fetchPlan(userOrId, fetchFn = fetch) {
  const u = String(userOrId || "").trim();
  if (!u) return { error: "user" };
  const q = /^\d+$/.test(u) ? "userid=" + u : "username=" + encodeURIComponent(u);
  try {
    const r = await fetchFn("https://www.simbrief.com/api/xml.fetcher.php?" + q + "&json=1");
    return parse(await r.json());
  } catch (e) { return { error: "net" }; }
}

module.exports = { parse, fetchPlan, thin };
