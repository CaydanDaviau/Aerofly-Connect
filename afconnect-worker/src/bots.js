// AI traffic ("bots"): simple flight model, advanced lazily (only when somebody reads the Hub), no timers, no extra requests.
// A bot flies  origin -> [waypoints] -> destination, lands (despawns at the threshold), waits (hidden), then flies back (if looping).
// Stage 2: with ground data (b.G, see botground.js: stand, taxi routes, runway exit) a bot parks at a stand, pushes back, taxis to the hold-short point, lines up,
// rolls, flies, lands, rolls out, taxis to its stand and parks; one runway lock per physical runway keeps bots from sharing it. Without ground data
// (no OSM taxi/runway data) it keeps the Stage 1 behaviour: spawn airborne, despawn at touchdown, wait hidden. Bots ignore ATC instructions.
const R = Math.PI / 180;
export const MAX_BOTS = 60;

// cr = cruise ground speed, vapp = final approach speed, clb/des = climb/descent rate (ft/min), ceil = service ceiling (ft), v250 = max speed below 10000 ft
export const TYPES = {
  B738: { cr: 450, vapp: 138, clb: 2200, des: 2000, ceil: 41000, v250: 250 }, A320: { cr: 450, vapp: 135, clb: 2200, des: 2000, ceil: 39000, v250: 250 },
  A321: { cr: 450, vapp: 142, clb: 2000, des: 2000, ceil: 39000, v250: 250 }, E190: { cr: 430, vapp: 128, clb: 2200, des: 2000, ceil: 41000, v250: 250 },
  B77W: { cr: 490, vapp: 152, clb: 1800, des: 2000, ceil: 43000, v250: 250 }, A333: { cr: 470, vapp: 146, clb: 1800, des: 2000, ceil: 41000, v250: 250 },
  B789: { cr: 490, vapp: 150, clb: 1900, des: 2000, ceil: 43000, v250: 250 }, AT72: { cr: 260, vapp: 105, clb: 1200, des: 1500, ceil: 25000, v250: 250 },
  C172: { cr: 110, vapp: 60, clb: 700, des: 500, ceil: 12000, v250: 110 }, DH8D: { cr: 290, vapp: 112, clb: 1500, des: 1800, ceil: 27000, v250: 250 },
};
export const perf = model => { const m = String(model || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); return TYPES[m] || TYPES[Object.keys(TYPES).find(k => m.includes(k)) || "B738"]; };

const n360 = a => ((a % 360) + 360) % 360, n180 = a => { a = n360(a); return a > 180 ? a - 360 : a; }, clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
const dist = (a, b) => Math.hypot((b.lon - a.lon) * 60 * Math.cos((a.lat + b.lat) / 2 * R), (b.lat - a.lat) * 60);
const brg = (a, b) => n360(Math.atan2((b.lon - a.lon) * Math.cos((a.lat + b.lat) / 2 * R), b.lat - a.lat) / R);
const offset = (p, hdg, nm) => ({ lat: p.lat + nm * Math.cos(hdg * R) / 60, lon: p.lon + nm * Math.sin(hdg * R) / 60 / Math.cos(p.lat * R) });
// ILS frame (same as the Worker's ilsPos): along = nm before the threshold, cross = nm right of the centre line flying inbound
function frame(ils, p) {
  const H = ils.hdg * R, dx = (p.lon - ils.thr.lon) * 60 * Math.cos(ils.thr.lat * R), dy = (p.lat - ils.thr.lat) * 60;
  return { along: -(dx * Math.sin(H) + dy * Math.cos(H)), cross: dx * Math.cos(H) - dy * Math.sin(H) };
}

// def: {callsign, model, dep, arr, cruise (ft), wps:[{lat,lon}], loop, turn (s), sec, dep_rwy, arr_rwy}; A/B: {lat, lon, elev, ils|null}
export function mkBot(id, def, A, B, now, delaySec = 0, G = null) {
  const st = G ? { mode: "park", waitUntil: now + delaySec * 1000, leg: 0, t: now, lat: G.A.stand.lat, lon: G.A.stand.lon, alt: A.elev, hdg: G.A.stand.hdg, gs: 0, vs: 0, wi: 0, final: false, landed: 0 } : null;
  return { id, def, A, B, G, s: st || { mode: "wait", waitUntil: now + delaySec * 1000, leg: 0, t: now, lat: A.lat, lon: A.lon, alt: A.elev, hdg: 0, gs: 0, vs: 0, wi: 0, final: false, landed: 0 } };
}
const legOf = b => b.s.leg === 0 ? { o: b.A, d: b.B, wps: b.def.wps || [] } : { o: b.B, d: b.A, wps: [...(b.def.wps || [])].reverse() };

function spawn(b) {
  const s = b.s, { o, d, wps } = legOf(b);
  const first = wps[0] || d;
  if (o.ils) { s.lat = o.ils.thr.lat; s.lon = o.ils.thr.lon; s.alt = o.elev + 60; s.hdg = o.ils.hdg; s.gs = 150; }
  else { s.lat = o.lat; s.lon = o.lon; s.alt = o.elev + 1500; s.hdg = brg(o, first); s.gs = 170; }
  s.vs = 1500; s.wi = 0; s.final = false; s.mode = "fly";
}

// one step of dt seconds; returns "landed" when the bot touches down
function step(b, dt, now) {
  const s = b.s, p = perf(b.def.model), { o, d, wps } = legOf(b), ils = d.ils;
  const here = { lat: s.lat, lon: s.lon };
  const cruise = Math.min(Number(b.def.cruise) || 30000, p.ceil);
  // lateral target
  let des, dd;   // desired heading; distance (nm) still to fly to the touchdown point (straight line, via the final fix)
  let fix = null, fr = null;
  if (ils) { fix = offset(ils.thr, n360(ils.hdg + 180), 12); fr = frame(ils, here); }
  const goal = ils ? ils.thr : d;
  if (!s.final && s.wi < wps.length) {
    const w = wps[s.wi]; if (dist(here, w) < Math.max(1.5, s.gs / 3600 * 9)) s.wi++;
  }
  if (s.final || (ils && s.wi >= wps.length && fr.along <= 14 && Math.abs(fr.cross) < 3 && Math.abs(n180(s.hdg - ils.hdg)) < 70)) {
    s.final = true; des = ils.hdg - clamp(fr.cross * 20, -25, 25); dd = Math.max(0, fr.along);
  } else {
    const tgt = s.wi < wps.length ? wps[s.wi] : (fix || d);
    des = brg(here, tgt);
    dd = (s.wi < wps.length ? dist(here, tgt) : 0) + (fix ? dist(here, fix) + 12 : dist(here, d));
    for (let i = s.wi + 1; i < wps.length; i++) dd += dist(wps[i - 1], wps[i]);   // rest of the route (approximate, straight legs)
    if (s.wi < wps.length) dd += dist(wps[wps.length - 1], fix || d);
  }
  const turn = clamp(n180(des - s.hdg), -3 * dt, 3 * dt); s.hdg = n360(s.hdg + turn);
  // vertical: climb to the cruise level, descend on a 3 deg profile (318 ft/nm) to the touchdown point; never below 2500 ft AGL before the final
  const elev = d.elev, tod = (cruise - elev) / 1000 * 3 + 8;
  let tgtAlt = cruise;
  if (dd <= tod) tgtAlt = Math.min(cruise, elev + (ils ? 50 : 0) + dd * 318 + (ils && !s.final ? 0 : 0));
  if (ils && !s.final) tgtAlt = Math.max(tgtAlt, elev + 2500);
  const aglO = s.alt - o.elev;
  if (aglO < 1500 && dist(here, o) < 15 && s.landed >= 0 && s.mode === "fly" && dd > 40) tgtAlt = Math.max(tgtAlt, s.alt);   // keep climbing out of the airport
  const vsT = clamp((tgtAlt - s.alt) * 3, -p.des, p.clb);
  s.vs += clamp(vsT - s.vs, -400 * dt, 400 * dt);
  s.alt += s.vs * dt / 60;
  // speed: 250 below 10000, cruise above, slower near the airport, approach speed on final
  let gsT = s.alt < 10000 ? Math.min(p.v250, p.cr) : p.cr;
  if (s.alt - o.elev < 3000 && dist(here, o) < 12) gsT = Math.min(gsT, 190);
  if (dd < 25) gsT = Math.min(gsT, 220);
  if (dd < 14) gsT = Math.min(gsT, p.vapp + 40);
  if (dd < 8) gsT = Math.min(gsT, p.vapp + 20);
  if (dd < 3 && s.alt - elev < 1500) gsT = p.vapp + 5;
  s.gs += clamp(gsT - s.gs, -1 * dt, 1.5 * dt);
  const mv = s.gs * dt / 3600;
  s.lat += mv * Math.cos(s.hdg * R) / 60; s.lon += mv * Math.sin(s.hdg * R) / 60 / Math.cos(s.lat * R);
  s.t = now;
  if (ils ? (s.final && frame(ils, { lat: s.lat, lon: s.lon }).along <= 0.05) || (s.final && s.alt <= elev + 20) : dist({ lat: s.lat, lon: s.lon }, d) < 0.4) return "landed";
  return null;
}

// ---- ground
const MS = 0.514444;   // kt -> m/s
// physical runway key (09L and 27R are the same runway)
export function rwyKey(apt, ident) {
  const n = parseInt(ident, 10) || 0, l = (/[LRC]$/.exec(String(ident)) || [""])[0];
  return n <= 18 ? apt + "/" + n + l : apt + "/" + (n - 18) + ({ L: "R", R: "L", C: "C" }[l] || "");
}
function moveAlong(s, path, meters) {   // follow a [[lat,lon]] polyline; true at its end
  while (s.pi < path.length) {
    const tg = { lat: path[s.pi][0], lon: path[s.pi][1] }, cur = { lat: s.lat, lon: s.lon }, dm = dist(cur, tg) * 1852;
    if (dm > 0.5) s.hdg = brg(cur, tg);
    if (dm <= meters) { s.lat = tg.lat; s.lon = tg.lon; meters -= dm; s.pi++; }
    else { const f = meters / dm; s.lat += (tg.lat - s.lat) * f; s.lon += (tg.lon - s.lon) * f; return false; }
  }
  return true;
}
const fwd = (s, nm) => { const p = offset({ lat: s.lat, lon: s.lon }, s.hdg, nm); s.lat = p.lat; s.lon = p.lon; };
const lockFree = (env, key, t) => env.skipLocks || !((env.lock.get(key) || {}).until > t);
const lockSet = (env, key, until) => { const c = env.lock.get(key); if (!c || until > c.until) env.lock.set(key, { until }); };
const GROUND = new Set(["park", "push", "taxi", "hold", "lineup", "lined"]);
export const onRunway = m => m === "lineup" || m === "lined" || m === "roll" || m === "rollout";

// one ground step (modes: park push taxi hold lineup lined roll rollout); returns "done" for a one-way bot that has parked
function stepGround(b, dt, t, env) {
  const s = b.s, p = perf(b.def.model), ak = s.leg === 0 ? "A" : "B", ap = b[ak], g = b.G[ak];
  s.t = t;
  switch (s.mode) {
    case "park":
      s.gs = 0; if (s.doneAt && t >= s.doneAt) return "done";
      if (!s.doneAt && t >= s.waitUntil) { s.mode = "push"; s.until = t + 45_000; }
      break;
    case "push": s.gs = 0; if (t >= s.until) { s.mode = "taxi"; s.path = g.out; s.pi = 1; s.after = "hold"; } break;
    case "taxi": {
      s.gs += clamp(18 - s.gs, -3 * dt, 3 * dt);
      if (moveAlong(s, s.path, s.gs * MS * dt)) {
        s.gs = 0;
        if (s.after === "hold") { s.mode = "hold"; s.until = t + (15 + (b.id * 7) % 25) * 1000; }
        else { s.mode = "park"; s.waitUntil = t + Math.max(0, Number(b.def.turn) || 300) * 1000; if (!b.def.loop) s.doneAt = t + 60_000; }
      }
      break;
    }
    case "hold": {
      s.gs = 0; const key = rwyKey(b.def[ak === "A" ? "dep" : "arr"], ap.ils.rwy);
      if (t >= s.until && lockFree(env, key, t)) { lockSet(env, key, t + 100_000); s.mode = "lineup"; s.path = [g.lineup]; s.pi = 0; }
      break;
    }
    case "lineup":
      s.gs += clamp(8 - s.gs, -3 * dt, 3 * dt);
      if (moveAlong(s, s.path, s.gs * MS * dt)) { s.gs = 0; s.hdg = ap.ils.hdg; s.mode = "lined"; s.until = t + 6000; }
      break;
    case "lined": s.gs = 0; s.hdg = ap.ils.hdg; if (t >= s.until) s.mode = "roll"; break;
    case "roll":
      s.gs += 4 * dt; fwd(s, s.gs * dt / 3600);
      if (s.gs >= p.vapp + 15) { s.mode = "fly"; s.alt = ap.elev; s.vs = 300; s.wi = 0; s.final = false; lockSet(env, rwyKey(b.def[ak === "A" ? "dep" : "arr"], ap.ils.rwy), t + 25_000); }
      break;
    case "rollout":
      s.gs = Math.max(25, s.gs - 2.5 * dt); const m = s.gs * MS * dt; fwd(s, m / 1852); s.rolled = (s.rolled || 0) + m;
      if (s.rolled >= g.inRoll) { s.mode = "taxi"; s.path = g.in; s.pi = 0; s.after = "park"; s.gs = Math.min(s.gs, 18); }
      break;
  }
  return null;
}

// Advance a bot to `now`. Returns "done" when a one-way bot has landed (remove it).
export function advance(b, now, env = { lock: new Map(), skipLocks: false }) {
  const s = b.s;
  let t = s.t;
  if (s.mode === "wait") {
    if (now < s.waitUntil) { s.t = now; return null; }
    t = Math.max(s.waitUntil, now - 3 * 3600_000); s.t = t; spawn(b);
  }
  const gap = now - t, dt = gap > 120_000 ? 10 : 2;
  for (let n = 0; n < 4000 && t < now; n++) {
    const h = Math.min(dt, (now - t) / 1000); t += h * 1000;
    if (s.mode !== "fly") { if (stepGround(b, h, t, env) === "done") return "done"; continue; }
    const ils0 = legOf(b).d.ils, r0 = step(b, h, t);
    if (b.G && ils0 && s.final) {   // runway lock: the runway is taken from 4.5 nm out until the lander has left it
      const al = frame(ils0, { lat: s.lat, lon: s.lon }).along, k = rwyKey(b.def[s.leg === 0 ? "arr" : "dep"], ils0.rwy);
      if (al <= 4.5 && r0 !== "landed") lockSet(env, k, t + al / Math.max(60, s.gs) * 3_600_000 + 70_000);
    }
    if (r0 === "landed" && b.G) {   // touchdown on the runway: roll out, taxi to the stand
      const k = rwyKey(b.def[s.leg === 0 ? "arr" : "dep"], ils0.rwy), nx = s.leg === 0 ? "B" : "A";
      s.landed++; s.leg = 1 - s.leg; s.mode = "rollout"; s.alt = legOf(b).o.elev; s.vs = 0; s.rolled = 0; s.final = false; s.hdg = ils0.hdg;
      lockSet(env, k, t + (b.G[nx].inRoll / 12 + 20) * 1000);
      continue;
    }
    if (r0 === "landed") {
      s.landed++; s.mode = "wait"; s.alt = (s.leg === 0 ? b.B : b.A).elev; s.gs = 0; s.vs = 0;
      if (!b.def.loop) return "done";
      s.leg = 1 - s.leg; s.waitUntil = t + Math.max(0, Number(b.def.turn) || 300) * 1000; s.t = now;
      return null;
    }
  }
  s.t = now;
  return null;
}

// position record in the shape of a pilot upload (see /api/position)
export function posOf(b, now) {
  const s = b.s, d = legOf(b).d, sq = 2000 + (b.id * 37) % 3000;
  const left = s.final && d.ils ? Math.max(0, frame(d.ils, { lat: s.lat, lon: s.lon }).along) : dist({ lat: s.lat, lon: s.lon }, d);
  const phase = s.mode === "fly" ? "air" : onRunway(s.mode) ? "runway" : "ground", air = phase === "air";
  return {
    icao_address: "BB" + b.id.toString(16).toUpperCase().padStart(4, "0"), callsign: b.def.callsign,
    latitude: s.lat, longitude: s.lon, altitude_ft: Math.round(s.alt), heading_true: Math.round(s.hdg), ground_speed: Math.round(s.gs), vertical_speed_ft_min: air ? Math.round(s.vs) : 0,
    squawk_code: String(sq).replace(/[89]/g, "1"), airplane_model: b.def.model, airplane_livery: "", voice: false, auto_atc: true, phase,
    arr_nm: Math.round(left * 10) / 10, timestamp: Math.floor(now / 1000), bot: true,
  };
}
export const planOf = b => ({ callsign: b.def.callsign, departure_airport: b.s.leg === 0 ? b.def.dep : b.def.arr, arrival_airport: b.s.leg === 0 ? b.def.arr : b.def.dep, cruise_altitude: String(b.def.cruise || ""), arrival_runway: (b.s.leg === 0 ? b.def.arr_rwy : b.def.dep_rwy) || "" });
const MODE_TXT = { park: "parked", push: "pushback", taxi: "taxiing", hold: "holding short", lineup: "lining up", lined: "lined up", roll: "takeoff roll", rollout: "landing roll" };
export const statusOf = b => {
  const s = b.s, at = s.leg === 0 ? b.def.dep : b.def.arr, to = s.leg === 0 ? b.def.arr : b.def.dep;
  const text = s.mode === "wait" ? "waiting at " + at + (s.waitUntil > s.t ? " (" + Math.ceil((s.waitUntil - s.t) / 60000) + " min)" : "")
    : s.mode === "fly" ? (s.final ? "final" : "enroute") + " to " + to + ", " + Math.round(s.alt) + " ft, " + Math.round(s.gs) + " kt"
    : MODE_TXT[s.mode] + " at " + (s.mode === "park" && s.doneAt ? at : at) + (s.mode === "park" && s.waitUntil > s.t ? " (departs in " + Math.ceil((s.waitUntil - s.t) / 60000) + " min)" : "");
  return { phase: s.mode, at, to, text };
};
