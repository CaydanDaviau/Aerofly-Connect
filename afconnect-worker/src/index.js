import { parseMetar, wxSig, nextLetter } from "./atis.js";
// Community backend for the Abflug Android client (v1.5.0) on Cloudflare Workers.
// All state lives in one Durable Object (in memory, TTL-based).
import ATC_HTML from "./atc.js";
import MAP_HTML from "./map.js";
const TTL_MS = 60_000;
const ASSIGN_TTL_MS = 12 * 3600_000;
const TOWER_TTL_MS = 24 * 3600_000;   // a virtual tower expires this long after it was last opened/refreshed
const MAX_TOWERS = 50;
const MAX_TRAFFIC = 500;
const CRASH_TIMEOUT_MS = 5 * 60_000;   // a pilot who crashes is locked out this long
const CRASH_SHOW_MS = 10 * 60_000;     // the X stays on the maps this long
const HARD_LANDING_FPM = -1500;        // landing_fpm at or below this = crash
const TA_COOLDOWN_MS = 30_000;         // per viewer + other aircraft
const TA_MIN_GS = 60;                  // both aircraft must be airborne-fast

// The Android app refuses callsigns starting with "ATC_". Controllers can use
// "ATC-SBBR", "ATC SBBR" or "TWR-SBBR" instead; we present them as "ATC_SBBR".
const normCallsign = cs => {
  if (typeof cs !== "string") return cs;
  const m = cs.trim().match(/^(?:ATC|TWR|TOWER)[-_ .]+([A-Za-z0-9]{2,8})$/i);
  return m ? "ATC_" + m[1].toUpperCase() : cs;
};

// How the Android app decides to draw a tower (TrafficClassification.detectControlTower):
// callsign contains "ATC_" AND (airplane_model is a 3-4 char airport code OR airplane_livery is a function name).
const towerFields = cs => {
  const m = /^ATC_([A-Z0-9]+)$/.exec(cs || "");
  if (!m) return null;
  return { airplane_model: /^[A-Z0-9]{3,4}$/.test(m[1]) ? m[1] : "", airplane_livery: "TOWER", livery: "TOWER" };
};

const pick = (d, ...names) => {
  for (const n of names) if (d && d[n] !== undefined && d[n] !== null && d[n] !== "") return d[n];
  return undefined;
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

// A virtual tower is listed to every player as an aircraft the app classifies as a tower.
function towerAircraft(t, distance) {
  const callsign = "ATC_" + t.name;
  let h = 2166136261;
  for (const ch of callsign) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return {
    icao_address: "7" + h.toString(16).padStart(8, "0").slice(0, 5).toUpperCase(),
    callsign, latitude: t.latitude, longitude: t.longitude,
    altitude_ft: t.altitude_ft, altitude: t.altitude_ft, heading_true: 0, track: 0,
    ground_speed: 0, velocity_knots: 0, vertical_speed_ft_min: 0, vertical_speed: 0,
    squawk: "0000", squawk_code: "0000", ...towerFields(callsign),
    timestamp: Math.floor(Date.now() / 1000), assigned_squawk: null, virtual_tower: true, member: !!t.member,
    distance_miles: Math.round(distance * 10) / 10,
  };
}

async function keyIcao(key) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(h)].slice(0, 3).map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}
function haversineMi(lat1, lon1, lat2, lon2) {
  const r = 3958.8, rad = Math.PI / 180;
  const dp = (lat2 - lat1) * rad, dl = (lon2 - lon1) * rad;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}


// ---- Traffic advisory (TA only): is aircraft b a threat to aircraft a? Null or {clock, rel_alt_ft, vs_trend, range_nm, tau_s} ----
// Normal: closest approach within 40 s, < 1.0 nm, < 1000 ft vertical. Relaxed (either plane near its airport): 20 s, 0.4 nm, 600 ft.
// Formation flying (relative speed < 20 kt) and diverging traffic never alert.
function computeTA(a, b) {
  const n = v => { const x = Number(v); return v === null || v === undefined || v === "" || !Number.isFinite(x) ? null : x; };
  const A = { la: n(a.latitude), lo: n(a.longitude), h: n(a.heading_true), g: n(a.ground_speed), z: n(a.altitude_ft), v: n(a.vertical_speed_ft_min) ?? 0 };
  const B = { la: n(b.latitude), lo: n(b.longitude), h: n(b.heading_true), g: n(b.ground_speed), z: n(b.altitude_ft), v: n(b.vertical_speed_ft_min) ?? 0 };
  for (const o of [A, B]) if (o.la === null || o.lo === null || o.h === null || o.g === null || o.z === null) return null;
  if (A.g < TA_MIN_GS || B.g < TA_MIN_GS) return null;
  const rad = Math.PI / 180, relaxed = a.terminal === true || b.terminal === true;
  const x = (B.lo - A.lo) * 60 * Math.cos((A.la + B.la) / 2 * rad), y = (B.la - A.la) * 60;   // nm, b relative to a
  const rvx = (B.g * Math.sin(B.h * rad) - A.g * Math.sin(A.h * rad)) / 3600;                  // nm/s
  const rvy = (B.g * Math.cos(B.h * rad) - A.g * Math.cos(A.h * rad)) / 3600;
  const v2 = rvx * rvx + rvy * rvy;
  if (Math.sqrt(v2) * 3600 < 20) return null;
  const dot = x * rvx + y * rvy;
  if (dot >= 0) return null;
  const t = -dot / v2;
  if (t > (relaxed ? 20 : 40)) return null;
  if (Math.hypot(x + rvx * t, y + rvy * t) > (relaxed ? 0.4 : 1.0)) return null;
  const dz = B.z - A.z, dzAt = Math.abs(dz + (B.v - A.v) / 60 * t);
  if (dzAt > (relaxed ? 600 : 1000) || Math.abs(dz) > (relaxed ? 1000 : 1500)) return null;
  const rel = ((Math.atan2(x, y) / rad - A.h) % 360 + 360) % 360;
  let clock = Math.round(rel / 30); if (clock === 0) clock = 12;
  return { clock, rel_alt_ft: Math.round(dz / 100) * 100, vs_trend: B.v > 300 ? 1 : B.v < -300 ? -1 : 0, range_nm: Math.round(Math.hypot(x, y) * 10) / 10, tau_s: Math.round(t) };
}

// ---- Auto-ATC (basic clearances for pilots when no human controller covers the airport) ----
const REQ_TYPES = ["clearance", "taxi", "takeoff", "land", "mayday", "mayday_cancel"];
const MAYDAY_MS = 30 * 60_000, MAYDAY_NEAR_MI = 30;
const REQ_LOCK_MS = { takeoff: 90_000, land: 120_000 };
const TOWER_COVER_MI = 8;   // a human tower this close to the aircraft (or named like its airport) takes the request
const fqPick = (str, types) => { const m = {}; for (const kv of String(str || "").split(";")) { const [k, v] = kv.split("="); if (k && v && /^\d{3}\.\d{1,3}$/.test(v)) m[k] = v; } for (const t of types) if (m[t]) return m[t]; return ""; };
const PHRASE = {
  en: {
    clearance: (dest, r, sq) => `Cleared ${dest ? "to " + dest + " " : ""}as filed${r ? ", departure runway " + r : ""}, squawk ${sq}`,
    taxi: r => r ? `Taxi to runway ${r}, hold short` : "Taxi to the runway, hold short",
    takeoff: r => r ? `Runway ${r}, cleared for takeoff` : "Cleared for takeoff",
    land: r => r ? `Runway ${r}, cleared to land` : "Cleared to land",
    busyTakeoff: (r, n) => `Hold position, runway ${r} occupied, number ${n}`,
    busyLand: (r, n) => `Runway ${r} occupied, number ${n}, extend and request again`,
    mayday: "Roger Mayday, say intentions",
    maydayNear: (cs, mi) => `Mayday traffic, ${cs} declared an emergency ${mi} miles from you, keep clear`,
    maydayEnd: "Mayday cancelled",
    departure: f => `Contact departure${f ? " " + f : ""}`,
    approach: f => `Contact approach${f ? " " + f : ""}`,
    tower: f => `Contact tower${f ? " " + f : ""}`,
    welcome: (a, f) => `Welcome to ${a}${f ? ", contact ground " + f : ""}, taxi to the gate`,
    goAround: r => `Go around, runway ${r} occupied`,
    vTaxi: "Stop, hold position, you are not cleared to taxi",
    vRunway: "Hold position, you are not cleared on the runway, vacate",
    vLand: r => `Landing without clearance${r ? " on runway " + r : ""}, vacate the runway`,
  },
  pt: {
    clearance: (dest, r, sq) => `Autorizado${dest ? " para " + dest : ""} conforme o plano${r ? ", pista de saída " + r : ""}, código ${sq}`,
    taxi: r => r ? `Táxi para a pista ${r}, aguarde antes da pista` : "Táxi para a pista, aguarde antes da pista",
    takeoff: r => r ? `Pista ${r}, autorizado a decolar` : "Autorizado a decolar",
    land: r => r ? `Pista ${r}, autorizado a pousar` : "Autorizado a pousar",
    busyTakeoff: (r, n) => `Aguarde na posição, pista ${r} ocupada, número ${n}`,
    busyLand: (r, n) => `Pista ${r} ocupada, número ${n}, prolongue e solicite novamente`,
    mayday: "Mayday recebido, informe intenções",
    maydayNear: (cs, mi) => `Tráfego em Mayday, ${cs} declarou emergência a ${mi} milhas, mantenha-se afastado`,
    maydayEnd: "Mayday cancelado",
    departure: f => `Contate a saída${f ? " " + f : ""}`,
    approach: f => `Contate a aproximação${f ? " " + f : ""}`,
    tower: f => `Contate a torre${f ? " " + f : ""}`,
    welcome: (a, f) => `Bem-vindo a ${a}${f ? ", contate o solo " + f : ""}, táxi para o portão`,
    goAround: r => `Arremeta, pista ${r} ocupada`,
    vTaxi: "Pare, aguarde na posição, você não está autorizado a taxiar",
    vRunway: "Aguarde na posição, você não está autorizado na pista, desocupe",
    vLand: r => `Pouso sem autorização${r ? " na pista " + r : ""}, desocupe a pista`,
  },
};
const REQ_LABEL = { clearance: "clearance", taxi: "taxi", takeoff: "takeoff", land: "landing" };
const cleanRunway = v => {
  const m = /^(\d{1,2})([LRC]?)$/.exec(String(v || "").toUpperCase().replace(/\s/g, ""));
  if (!m) return "";
  const n = Number(m[1]);
  return n >= 1 && n <= 36 ? String(n).padStart(2, "0") + m[2] : "";
};

// opposite end of a runway: 29L <-> 11R
const oppRunway = r => { const m = /^(\d\d)([LRC]?)$/.exec(r); if (!m) return r; const n = ((Number(m[1]) + 17) % 36) + 1; return String(n).padStart(2, "0") + ({ L: "R", R: "L", C: "C", "": "" })[m[2]]; };
const rwyKey = (apt, r) => (apt || "?") + "/" + [r, oppRunway(r)].sort()[0];
const GRACE_MS = 20_000, VIOL_SHOW_MS = 30_000, VIOL_RENEW_MS = 20_000, MAX_VIOL = 100;
const PUSH_MS = 3000;
const VOICE_TTL_MS = 5 * 60 * 1000, VOICE_MAX_CLIPS = 40, VOICE_MAX_B64 = 150_000, VOICE_LISTEN_MS = 60_000;
const up =v => String(v || "").trim().toUpperCase();

// Group code: Worker var GROUP_CODE; clients send it as X-Group header (or ?group=). The Hub only ever sees X-Member 1/0, never the code.
function memberFlag(request, env, url) {
  const gc = String(env.GROUP_CODE || "").trim();
  const got = String(request.headers.get("X-Group") || url.searchParams.get("group") || "").trim();
  return !!gc && got === gc;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/atc" || url.pathname === "/atc/")
      return new Response(ATC_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    if (url.pathname === "/map" || url.pathname === "/map/")
      return new Response(MAP_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") return json({ error: "websocket expected" }, 426);
      const wk = (url.searchParams.get("key") || "").trim();
      const allowed = (env.ABFLUG_KEYS || "").split(",").map(s => s.trim()).filter(Boolean);
      if (!wk || (allowed.length && !allowed.includes(wk))) return json({ error: "invalid api key" }, 401);
      const h = new Headers(request.headers); h.set("X-API-Key", wk); h.set("X-Member", memberFlag(request, env, url) ? "1" : "0");
      return env.HUB.get(env.HUB.idFromName("global")).fetch(request, { headers: h });
    }
    if (!url.pathname.startsWith("/api/")) return json({ name: "abflug-community", ok: true });
    const key = (request.headers.get("X-API-Key") || (url.pathname === "/api/debug" ? url.searchParams.get("key") : "") || "").trim();
    if (url.pathname !== "/api/health" && url.pathname !== "/api/stats") {
      const allowed = (env.ABFLUG_KEYS || "").split(",").map(s => s.trim()).filter(Boolean);
      if (!key || (allowed.length && !allowed.includes(key))) return json({ error: "invalid api key" }, 401);
    }
    if (env.DEBUG) console.log(request.method, url.pathname + url.search, (await request.clone().text()).slice(0, 600));
    const stub = env.HUB.get(env.HUB.idFromName("global"));
    const hh = new Headers(request.headers); hh.delete("X-Group"); hh.set("X-Member", memberFlag(request, env, url) ? "1" : "0");
    return stub.fetch(request, { headers: hh });
  },
};

export class Hub {
  constructor(ctx) {
    this.towers = new Map(); this.wx = new Map(); this.crashes = new Map(); this.ta = new Map();
    ctx.blockConcurrencyWhile(async () => {
      for (const [k, v] of await ctx.storage.list({ prefix: "tower:" })) this.towers.set(k.slice(6), v);
      for (const [k, v] of await ctx.storage.list({ prefix: "crash:" })) this.crashes.set(k.slice(6), v);
    }); this.ctx = ctx; this.clients = new Map(); this.msgs = new Map(); this.rwy = new Map(); this.rwyQ = new Map(); this.violations = []; this.clips = new Map(); this.listeners = new Map(); this.msgSeq = 0; this.since = Date.now(); this.counts = {}; }

  purge() {
    const now = Date.now();
    for (const [k, c] of this.clients) if (now - c.seen > TTL_MS) this.clients.delete(k);
    for (const [k, m] of this.msgs) if (now - m.at > 30 * 60 * 1000) this.msgs.delete(k);
    for (const [k, l] of this.rwy) if (now > l.until) this.rwy.delete(k);
    for (const [k, v] of this.clips) if (now - v.at > VOICE_TTL_MS) this.clips.delete(k);
    for (const [k, v] of this.listeners) if (now - v.at > VOICE_LISTEN_MS) this.listeners.delete(k);
    for (const [k, q] of this.rwyQ) { const f = q.filter(x => this.clients.has(x)); if (f.length) this.rwyQ.set(k, f); else this.rwyQ.delete(k); }
    for (const [k, t] of this.ta) if (now - t > 120_000) this.ta.delete(k);
    for (const [k, cr] of this.crashes) if (now - cr.at > CRASH_SHOW_MS) { this.crashes.delete(k); this.ctx.storage.delete("crash:" + k); }
    for (const [k, t] of this.towers) if (now - t.at > TOWER_TTL_MS) { this.towers.delete(k); this.ctx.storage.delete("tower:" + k); }
  }

  addMsg(target, text, kind, extra) {
    const pos = target.pos || {};
    const id = Date.now().toString(36) + (++this.msgSeq).toString(36);
    const m = { id, icao: pos.icao_address, callsign: normCallsign(target.plan.callsign ?? pos.callsign), text: String(text).slice(0, 300), kind, at: Date.now(), status: "sent", ...extra };
    this.msgs.set(id, m);
    if (this.msgs.size > 300) this.msgs.delete(this.msgs.keys().next().value);
    return m;
  }

  // First free squawk in 2000-2777 (random start), or null.
  pickSquawk() {
    const used = new Set();
    for (const c of this.clients.values()) {
      if (c.assigned) used.add(c.assigned.squawk);
      if (c.pos && c.pos.squawk) used.add(String(c.pos.squawk));
    }
    const start = Math.floor(Math.random() * 512);
    for (let i = 0; i < 512; i++) {
      const cand = (0o2000 + ((start + i) % 512)).toString(8).padStart(4, "0");
      if (!used.has(cand)) return cand;
    }
    return null;
  }

  crashBlock(key) {
    const cr = this.crashes.get(key), now = Date.now();
    if (!cr || now >= cr.until) return null;
    return json({ error: "crashed", crashed: true, until: cr.until, remaining_s: Math.ceil((cr.until - now) / 1000), latitude: cr.latitude, longitude: cr.longitude, landing_fpm: cr.landing_fpm }, 423);
  }

  humanCovers(c, apt) {
    return [...this.towers.values()].some(t => (apt && t.name === apt) || haversineMi(t.latitude, t.longitude, c.pos.latitude, c.pos.longitude) <= TOWER_COVER_MI);
  }

  // Another recent client standing on that runway (either end ident) at that airport.
  occupant(key, apt, rwy, now) {
    for (const [k, o] of this.clients) {
      const q = o.pos;
      if (k === key || !q || now - o.seen > 15_000 || q.phase !== "runway" || up(q.rwy_apt) !== apt) continue;
      if (String(q.rwy_on || "").split("/").map(cleanRunway).includes(rwy)) return o;
    }
    return null;
  }

  // Auto-ATC follow-up for one position upload: proactive calls, runway locks, go-around, unauthorised actions.
  // Returns the messages to hand to the pilot in this reply. Needs `phase` from our client; stock Abflug is skipped.
  track(key, c, now) {
    const p = c.pos, cur = p.phase, out = [];
    if (cur !== "ground" && cur !== "runway" && cur !== "air") return out;
    const st = c.st || (c.st = { gr: {}, ph: null, at: 0, lat: 0, lon: 0, grace: now + GRACE_MS, calls: {}, viol: {}, landedAt: 0, landRwy: "" });
    const prev = st.ph, plan = c.plan || {};
    const dep = up(plan.departure_airport), arr = up(plan.arrival_airport);
    const lang = c.lang === "pt" ? "pt" : "en";
    const ph = PHRASE[lang];
    if (st.at && (now - st.at > 15_000 || haversineMi(st.lat, st.lon, p.latitude, p.longitude) > 0.5)) st.grace = now + GRACE_MS;   // pause or jump
    st.at = now; st.lat = p.latitude; st.lon = p.longitude; st.ph = cur;
    const say = (text, urgent, contact) => { const m = this.addMsg(c, text, "auto", { urgent: !!urgent }); m.status = "delivered"; out.push({ id: m.id, text: m.text, kind: "auto", urgent: !!urgent, at: m.at, ...(contact ? { contact } : {}) }); };
    const apt = up(p.rwy_apt) || (cur === "air" ? arr : dep);
    if (this.humanCovers(c, apt || dep)) { c.viol = null; return out; }   // a human controller owns this airport

    const gs = Number(p.ground_speed) || 0;
    const onRwys = String(p.rwy_on || "").split("/").map(cleanRunway).filter(Boolean);

    // runway locks held by this aircraft: kept while it is on the runway, dropped when it leaves or departs
    for (const [k, l] of this.rwy) {
      if (l.key !== key) continue;
      if (cur === "runway") l.until = Math.max(l.until, now + 30_000);
      else if ((cur === "air" && l.type === "takeoff") || (cur === "ground" && prev === "runway")) this.rwy.delete(k);
    }

    if (cur === "air") {
      if (prev && prev !== "air" && !st.calls.dep) { st.calls.dep = true; if (st.gr.takeoff > now || prev === "runway") { const f = fqPick(p.fq_dep, ["DEP", "APP"]); say(ph.departure(f), false, "Departure" + (f ? " " + f : "")); } }
      st.gr.taxi = 0; st.gr.takeoff = 0;
      // short final to a runway that is occupied: go around
      const lr = cleanRunway(plan.arrival_runway) || st.landRwy;
      if (st.gr.land > now && !st.calls.ga && lr && arr && Number(p.arr_nm) <= 3 && this.occupant(key, arr, lr, now)) {
        st.calls.ga = true; st.gr.land = 0; say(ph.goAround(lr), true);
      }
      if (Number(p.arr_nm) > 6) st.calls.ga = false;
      // arrival handoffs: approach, then tower (once each per approach; reset when far away again)
      const an = Number(p.arr_nm);
      if (arr && Number.isFinite(an) && p.arr_nm !== null && p.arr_nm !== undefined) {
        if (an > 45) { st.calls.app = false; st.calls.twr = false; }
        else if (an <= 12 && !st.calls.twr) {
          st.calls.twr = true; st.calls.app = true; const f = fqPick(p.fq_arr, ["TWR"]); say(ph.tower(f), false, "Tower" + (f ? " " + f : ""));
        } else if (an <= 35 && an > 12 && !st.calls.app) {
          st.calls.app = true; const f = fqPick(p.fq_arr, ["APP", "DEP"]); say(ph.approach(f), false, "Approach" + (f ? " " + f : ""));
        }
      }
    } else {
      if (prev === "air") {   // touchdown
        st.landedAt = now; st.calls = {};
        const lr = onRwys[0] || cleanRunway(plan.arrival_runway) || st.landRwy;
        const cleared = st.gr.land > now;
        const busy = lr && apt && this.occupant(key, apt, lr, now);
        if (!st.grace || now > st.grace) {
          if (!cleared || busy) this.violate(key, c, st, "landing", apt, lr, now, () => say(ph.vLand(lr), true));
        }
        st.gr.land = 0; st.gr.taxi = now + 30 * 60_000;
        c.emerg = null;   // an emergency ends on the ground (its landing is never a violation)
        if (cleared && !busy && apt && apt === arr) { const f = fqPick(p.fq_arr, ["GND"]); say(ph.welcome(apt, f), false, "Ground" + (f ? " " + f : "")); }
      } else if (now > st.grace) {
        if (cur === "ground" && gs >= 10 && !(st.gr.taxi > now) && !(st.gr.takeoff > now))
          this.violate(key, c, st, "taxi", apt, "", now, () => say(ph.vTaxi, true));
        if (cur === "runway" && !(st.gr.takeoff > now) && now - st.landedAt > 120_000 && (p.on_rwy || gs >= 15))
          this.violate(key, c, st, "runway", apt, onRwys[0] || "", now, () => say(ph.vRunway, true));
      }
    }
    if (c.viol && now - c.viol.at > VIOL_SHOW_MS) c.viol = null;
    return out;
  }

  violate(key, c, st, type, apt, rwy, now, notify) {
    if (c.emerg && now < c.emerg.until) return;   // declared emergency: no unauthorised-action calls
    const v = st.viol[type];
    if (!v || now - v.said > VIOL_RENEW_MS) { st.viol[type] = { said: now }; notify(); }
    if (!v || now - v.logged > 60_000) {
      st.viol[type] = { said: st.viol[type].said, logged: now };
      this.violations.push({ at: now, callsign: normCallsign(c.plan.callsign ?? c.pos.callsign), icao: c.pos.icao_address, type, airport: apt, runway: rwy });
      if (this.violations.length > MAX_VIOL) this.violations.shift();
    }
    c.viol = { type, at: now };
    if (rwy && (type === "runway" || type === "landing")) {   // the runway counts as occupied for everybody else
      const k = rwyKey(apt, rwy), l = this.rwy.get(k);
      if (!l || l.key === key) this.rwy.set(k, { key, type: "viol", until: now + 30_000 });
    }
  }

  trafficList(key, lat, lon, rad, max) {
    let out = [];
    for (const [ck, c] of this.clients) {
      const pos = c.pos;
      if (!pos) continue;
      const d = haversineMi(lat, lon, pos.latitude, pos.longitude);
      if (d <= rad) {
        const callsign = normCallsign(c.plan.callsign ?? pos.callsign);
        out.push({ ...pos, ...c.plan, callsign, ...towerFields(callsign), member: !!c.member, assigned_squawk: c.assigned ? c.assigned.squawk : null, emergency: !!(c.emerg && Date.now() < c.emerg.until), no_clnc: !!(c.viol && Date.now() - c.viol.at < VIOL_SHOW_MS), ...(ck === key ? { self: true } : {}), distance_miles: Math.round(d * 10) / 10 });
      }
    }
    for (const t of this.towers.values()) {
      const d = haversineMi(lat, lon, t.latitude, t.longitude);
      if (d <= rad) out.push(towerAircraft(t, d));
    }
    out.sort((a, b) => a.distance_miles - b.distance_miles);
    const truncated = out.length > max;
    return { out: out.slice(0, max), truncated };
  }

  crashList() {
    return [...this.crashes.values()].map(x => ({ callsign: x.callsign, icao_address: x.icao, latitude: x.latitude, longitude: x.longitude, landing_fpm: x.landing_fpm, at: x.at, until: x.until }));
  }

  trafficAlerts(key, c) {
    const now = Date.now(), out = [];
    for (const [k2, o] of this.clients) {
      if (k2 === key || !o.pos || now - o.seen > 15_000) continue;
      const al = computeTA(c.pos, o.pos);
      if (!al) continue;
      const pk = key + "|" + k2;
      if (now - (this.ta.get(pk) || 0) < TA_COOLDOWN_MS) continue;
      this.ta.set(pk, now);
      out.push({ ...al, callsign: normCallsign(o.plan.callsign ?? o.pos.callsign), icao_address: o.pos.icao_address });
    }
    return out.sort((x, y) => x.tau_s - y.tau_s).slice(0, 2);
  }

  // ---- WebSocket (Hibernation API). Message in: {id, method, path, body} -> same handlers as HTTP, reply {id, status, body}.
  // {sub:{lat,lon,radius_miles}} subscribes the socket to pushed traffic ({push:"traffic", ...} = body of GET /api/traffic).
  acceptSocket(request) {
    const key = (request.headers.get("X-API-Key") || "").trim();
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ key, sub: null, member: request.headers.get("X-Member") === "1" });
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.startPush();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  startPush() {
    if (this.pushTimer) return;
    this.pushTimer = setInterval(() => this.pushAll().catch(() => {}), PUSH_MS);
  }
  async pushAll() {
    const socks = this.ctx.getWebSockets();
    if (!socks.length) { clearInterval(this.pushTimer); this.pushTimer = null; return; }
    this.purge();
    const cache = new Map();
    for (const ws of socks) {
      const a = ws.deserializeAttachment() || {};
      if (!a.sub) continue;
      const sk = a.key + "|" + a.sub.lat + "|" + a.sub.lon + "|" + a.sub.rad + "|" + a.sub.max;
      let body = cache.get(sk);
      if (!body) { body = JSON.stringify({ push: "traffic", ...this.trafficBody(a.key, a.sub.lat, a.sub.lon, a.sub.rad, a.sub.max) }); cache.set(sk, body); }
      try { ws.send(body); } catch (e) {}
    }
  }
  trafficBody(key, lat, lon, rad, max) {
    const { out, truncated } = this.trafficList(key, lat, lon, rad, Math.max(1, Math.min(MAX_TRAFFIC, Number(max) || MAX_TRAFFIC)));
    const atc_messages = [...this.msgs.values()].map(x => ({ id: x.id, icao_address: x.icao, text: x.text, kind: x.kind, urgent: !!x.urgent, status: x.status, at: x.at }));
    const voice_clips = [...this.clips.values()].filter(v => v.dir === "up").map(v => ({ id: v.id, icao_address: v.icao, callsign: v.callsign, ms: v.ms, at: v.at }));
    return { aircraft: out, traffic: out, truncated, active_clients: this.clients.size, atc_messages, crashes: this.crashList(), voice_clips };
  }

  // ---- ATIS (per open tower): letter, runways, frequencies, remarks + METAR from aviationweather.gov (cached 5 min)
  async weather(name) {
    if (!/^[A-Z]{4}$/.test(name)) return null;
    const now = Date.now(), c = this.wx.get(name);
    if (c && now - c.at < 300_000) return c.w;
    let w = c ? c.w : null, ok = false;
    try {
      const r = await fetch("https://aviationweather.gov/api/data/metar?ids=" + name + "&format=raw", { signal: AbortSignal.timeout(4000) });
      if (r.ok) { w = parseMetar(await r.text()) || null; ok = true; }
    } catch (e) {}
    this.wx.set(name, { at: ok ? now : now - 240_000, w });   // failed fetch: keep the old data, retry in 1 min
    return w;
  }
  async atisFor(name) {
    const t = this.towers.get(name);
    if (!t) return null;
    const a = t.atis || (t.atis = { letter: "A", runways: "", frequencies: "", remarks: "", at: Date.now(), sig: "" });
    const w = await this.weather(name);
    if (w) {
      const sg = wxSig(w);
      if (sg !== a.sig) { if (a.sig) { a.letter = nextLetter(a.letter); a.at = Date.now(); } a.sig = sg; await this.ctx.storage.put("tower:" + name, t); }
    }
    return { name, letter: a.letter, runways: a.runways, frequencies: a.frequencies, remarks: a.remarks, updated: a.at, weather: w, wx_ok: !!w };
  }

  voiceListening() {
    const now = Date.now();
    for (const v of this.listeners.values()) if (v.on && now - v.at <= VOICE_LISTEN_MS) return true;
    return false;
  }
  addClip(dir, target, d) {
    const audio = String(d.audio || "");
    const id = "v" + Date.now().toString(36) + (++this.msgSeq).toString(36);
    const ms = Math.max(0, Math.min(10_000, Number(d.ms) || 0));
    const pos = target.pos || {};
    this.clips.set(id, { id, dir, icao: pos.icao_address, callsign: normCallsign(target.plan.callsign ?? pos.callsign), audio, mime: String(d.mime || "audio/mp4").slice(0, 40), ms, at: Date.now(), delivered: false });
    if (this.clips.size > VOICE_MAX_CLIPS) this.clips.delete(this.clips.keys().next().value);
    return id;
  }
  async webSocketMessage(ws, raw) {
    this.startPush();
    const a = ws.deserializeAttachment() || {};
    let d; try { d = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)); } catch (e) { return; }
    if (!d || typeof d !== "object") return;
    if (d.sub !== undefined) {
      const s = d.sub, lat = Number(s && s.lat) || 0, lon = Number(s && s.lon) || 0, rad = Number(s && s.radius_miles) || 250;
      const max = Math.max(1, Math.min(MAX_TRAFFIC, Number(s && s.max) || MAX_TRAFFIC));
      a.sub = s ? { lat, lon, rad, max } : null; ws.serializeAttachment(a);
      if (a.sub) { try { ws.send(JSON.stringify({ push: "traffic", ...this.trafficBody(a.key, lat, lon, rad, max) })); } catch (e) {} }
      return;
    }
    const method = String(d.method || "GET").toUpperCase(), path = String(d.path || "");
    if (!path.startsWith("/api/") || path.startsWith("/api/debug") || !["GET", "PUT", "POST", "DELETE"].includes(method)) {
      try { ws.send(JSON.stringify({ id: d.id, status: 400, body: { error: "bad request" } })); } catch (e) {}
      return;
    }
    const init = { method, headers: { "X-API-Key": a.key, "Content-Type": "application/json", "X-Via": "ws", "X-Member": a.member ? "1" : "0" } };
    if (method !== "GET" && method !== "DELETE" && d.body !== undefined) init.body = JSON.stringify(d.body);
    let status = 500, body = { error: "server error" };
    try {
      const r = await this.fetch(new Request("https://hub" + path, init));
      status = r.status; const t = await r.text(); try { body = JSON.parse(t); } catch (e) { body = t; }
    } catch (e) {}
    try { ws.send(JSON.stringify({ id: d.id, status, body })); } catch (e) {}
  }
  webSocketClose(ws) { try { ws.close(); } catch (e) {} }
  webSocketError() {}

  async fetch(request) {
    const url = new URL(request.url);
    const key = (request.headers.get("X-API-Key") || "").trim();
    const m = request.method, p = url.pathname;
    if (p === "/ws" && request.headers.get("Upgrade") === "websocket") return this.acceptSocket(request);
    this.purge();

    if (m === "GET" && p === "/api/debug") {
      const now = Date.now();
      const mask = k => k.slice(0, 2) + "***" + k.slice(-1);
      return json({ towers: [...this.towers.values()], players: [...this.clients].map(([k, c]) => ({ key: mask(k), age_s: Math.round((now - c.seen) / 1000), position: c.pos || null, plan: c.plan || {} })) });
    }
    if (p !== "/api/stats" && p !== "/api/debug") { const k = (request.headers.get("X-Via") === "ws" ? "WS " : "") + m + " " + p; this.counts[k] = (this.counts[k] || 0) + 1; }
    if (m === "GET" && p === "/api/stats") {
      if (url.searchParams.get("reset") === "1") { this.counts = {}; this.since = Date.now(); }   // /api/stats?reset=1 starts the counters over
      const secs = Math.max(1, (Date.now() - this.since) / 1000);
      const per_minute = {};
      for (const [k, v] of Object.entries(this.counts)) per_minute[k] = Math.round((v / secs) * 600) / 10;
      return json({ seconds_since_start: Math.round(secs), counts: this.counts, per_minute, total_per_hour: Math.round(Object.values(this.counts).reduce((a, b) => a + b, 0) / secs * 3600) });
    }

    if ((m === "PUT" || m === "POST") && p === "/api/atc/squawk") {
      const d = await request.json().catch(() => ({}));
      const icao = String(d.icao_address || "").toUpperCase();
      const target = [...this.clients.values()].find(c => c.pos && c.pos.icao_address === icao);
      if (!target) return json({ error: "aircraft not found" }, 404);
      let sq = d.squawk === undefined || d.squawk === null || d.squawk === "" ? null : String(d.squawk);
      if (sq === null) {
        sq = this.pickSquawk();
        if (sq === null) return json({ error: "no free squawk" }, 409);
      } else if (!/^[0-7]{4}$/.test(sq) || ["7500", "7600", "7700"].includes(sq)) {
        return json({ error: "invalid squawk (4 octal digits, not 7500/7600/7700)" }, 400);
      }
      const rec = { squawk: sq, at: Date.now() };
      target.assigned = rec;
      this.addMsg(target, "Squawk " + sq, "squawk", { squawk: sq });
      await this.ctx.storage.put("sq:" + icao, rec);
      return json({ success: true, squawk: sq });
    }
    if (m === "DELETE" && p === "/api/atc/squawk") {
      const icao = String(url.searchParams.get("icao_address") || "").toUpperCase();
      for (const c of this.clients.values()) if (c.pos && c.pos.icao_address === icao) c.assigned = null;
      await this.ctx.storage.delete("sq:" + icao);
      return json({ success: true });
    }

    if ((m === "PUT" || m === "POST") && p === "/api/atc/message") {
      const d = await request.json().catch(() => ({}));
      const icao = String(d.icao_address || "").toUpperCase();
      const text = String(d.text || "").trim();
      const target = [...this.clients.values()].find(c => c.pos && c.pos.icao_address === icao);
      if (!target) return json({ error: "aircraft not found" }, 404);
      if (!text) return json({ error: "empty message" }, 400);
      return json({ success: true, id: this.addMsg(target, text, "msg", { urgent: d.urgent === true }).id });
    }
    if ((m === "PUT" || m === "POST") && p === "/api/messages/reply") {
      const d = await request.json().catch(() => ({}));
      const msg = this.msgs.get(String(d.id || ""));
      const me = this.clients.get(key);
      if (!msg || !me || !me.pos || me.pos.icao_address !== msg.icao) return json({ error: "message not found" }, 404);
      if (!["wilco", "unable"].includes(d.reply)) return json({ error: "reply must be wilco or unable" }, 400);
      msg.status = d.reply; msg.replied = Date.now();
      return json({ success: true });
    }

    // ---- Push-to-talk voice clips (in memory, 5 min, base64 audio <= ~110 KB, max 10 s).
    if ((m === "PUT" || m === "POST") && p === "/api/voice/listen") {   // controller page: "I can hear voice" (renew every <= 30 s)
      const d = await request.json().catch(() => ({}));
      if (d.on === true) this.listeners.set(key, { on: true, at: Date.now() }); else this.listeners.delete(key);
      return json({ success: true, listening: this.voiceListening() });
    }
    if ((m === "PUT" || m === "POST") && p === "/api/voice/clip") {   // pilot -> controllers
      const d = await request.json().catch(() => ({}));
      const c = this.clients.get(key);
      if (!c || !c.pos) return json({ error: "start flying first" }, 404);
      if (c.pos.voice === false) return json({ error: "voice_off" }, 409);
      if (!d.audio || typeof d.audio !== "string" || d.audio.length > VOICE_MAX_B64) return json({ error: "bad audio" }, 400);
      const now = Date.now();
      if (c.lastClip && now - c.lastClip < 1500) return json({ error: "too many clips" }, 429);
      if (!this.voiceListening()) return json({ error: "no_listener" }, 409);
      c.lastClip = now;
      return json({ success: true, id: this.addClip("up", c, d) });
    }
    if (m === "GET" && p === "/api/voice/clip") {   // controller fetches the audio of a clip announced in traffic.voice_clips
      const v = this.clips.get(String(url.searchParams.get("id") || ""));
      if (!v || v.dir !== "up") return json({ error: "clip not found" }, 404);
      return json({ id: v.id, audio: v.audio, mime: v.mime, ms: v.ms, at: v.at, callsign: v.callsign });
    }
    if ((m === "PUT" || m === "POST") && p === "/api/atc/voice") {   // controller -> pilot
      const d = await request.json().catch(() => ({}));
      const icao = String(d.icao_address || "").toUpperCase();
      const target = [...this.clients.values()].find(c => c.pos && c.pos.icao_address === icao);
      if (!target) return json({ error: "aircraft not found" }, 404);
      if (target.pos.voice === false) return json({ error: "voice_off", callsign: normCallsign(target.plan.callsign ?? target.pos.callsign) }, 409);
      if (!d.audio || typeof d.audio !== "string" || d.audio.length > VOICE_MAX_B64) return json({ error: "bad audio" }, 400);
      return json({ success: true, id: this.addClip("down", target, d) });
    }

    // Pilot -> controller free text. Stored like a request (status "request": never delivered back to the pilot).
    if ((m === "PUT" || m === "POST") && p === "/api/atc/chat") {
      const d = await request.json().catch(() => ({}));
      const text = String(d.text || "").trim().slice(0, 200);
      const c = this.clients.get(key);
      if (!c || !c.pos) return json({ error: "start flying first" }, 404);
      if (!text) return json({ error: "empty message" }, 400);
      const now = Date.now();
      if (c.lastChat && now - c.lastChat < 2000) return json({ error: "too many messages" }, 429);
      c.lastChat = now;
      const msg = this.addMsg(c, text, "chat", {});
      msg.status = "request";
      return json({ success: true, id: msg.id, mode: this.towers.size > 0 ? "controller" : "none" });
    }

    if ((m === "PUT" || m === "POST") && p === "/api/atc/request") {
      const d = await request.json().catch(() => ({}));
      const type = String(d.type || "");
      if (!REQ_TYPES.includes(type)) return json({ error: "type must be clearance, taxi, takeoff, land, mayday or mayday_cancel" }, 400);
      const c = this.clients.get(key);
      if (!c || !c.pos) return json({ error: "start flying first" }, 404);
      const now = Date.now();
      if (c.lastReq && now - c.lastReq < 2000) return json({ error: "too many requests" }, 429);
      c.lastReq = now;
      const plan = c.plan || {};
      const ph = PHRASE[d.lang === "pt" ? "pt" : "en"];
      if (d.lang === "pt" || d.lang === "en") c.lang = d.lang;
      if (type === "mayday_cancel") {
        if (!c.emerg) return json({ success: true, mode: "auto", messages: [] });
        c.emerg = null;
        for (const [k, l] of this.rwy) if (l.key === key && l.type === "emerg") this.rwy.delete(k);
        const m0 = this.addMsg(c, PHRASE[c.lang === "pt" ? "pt" : "en"].maydayEnd, "auto", {}); m0.status = "delivered";
        return json({ success: true, mode: "auto", messages: [{ id: m0.id, text: m0.text, kind: "auto", urgent: false, at: m0.at }] });
      }
      const rwy = cleanRunway(plan[type === "land" ? "arrival_runway" : "departure_runway"]) || cleanRunway(d.runway);
      const apt = String(plan[type === "land" ? "arrival_airport" : "departure_airport"] || "").trim().toUpperCase();
      const dest = String(plan.arrival_airport || "").trim().toUpperCase();
      const apt0 = String(plan.departure_airport || "").trim().toUpperCase();
      if (type === "mayday") {
        // Emergency: always accepted. Flag for the radar, warn nearby pilots, hold the runway; a human tower gets it as a request.
        const air = c.pos.phase === "air";
        const eapt = air ? dest : apt0;
        const erwy = cleanRunway(air ? plan.arrival_runway : plan.departure_runway) || cleanRunway(d.runway);
        c.emerg = { at: now, until: now + MAYDAY_MS };
        if (erwy && eapt) this.rwy.set(rwyKey(eapt, erwy), { key, type: "emerg", until: now + 10 * 60_000 });
        const cs = normCallsign(plan.callsign ?? c.pos.callsign);
        for (const [k2, o] of this.clients) {
          if (k2 === key || !o.pos || now - o.seen > 15_000) continue;
          const mi = haversineMi(o.pos.latitude, o.pos.longitude, c.pos.latitude, c.pos.longitude);
          if (mi <= MAYDAY_NEAR_MI) this.addMsg(o, PHRASE[o.lang === "pt" ? "pt" : "en"].maydayNear(cs, Math.round(mi)), "auto", { urgent: true });
        }
        this.violations.push({ at: now, callsign: cs, icao: c.pos.icao_address, type: "mayday", airport: eapt, runway: erwy });
        if (this.violations.length > MAX_VIOL) this.violations.shift();
        if (this.humanCovers(c, eapt)) {
          const msg = this.addMsg(c, "Declares MAYDAY", "request", { urgent: true });
          msg.status = "request";
          return json({ success: true, mode: "controller", id: msg.id });
        }
        const m1 = this.addMsg(c, ph.mayday, "auto", { urgent: true }); m1.status = "delivered";
        return json({ success: true, mode: "auto", messages: [{ id: m1.id, text: m1.text, kind: "auto", urgent: true, at: m1.at }] });
      }
      // A human controller wins: a tower named like the airport, or one close to the aircraft.
      if (this.humanCovers(c, apt)) {
        const msg = this.addMsg(c, "Requests " + REQ_LABEL[type] + (rwy ? ", runway " + rwy : ""), "request", {});
        msg.status = "request";
        return json({ success: true, mode: "controller", id: msg.id });
      }
      let text;
      const lockKey = rwy ? rwyKey(apt, rwy) : null;
      const holder = lockKey && this.rwy.get(lockKey);
      const st = c.st || (c.st = { gr: {}, ph: null, at: 0, lat: 0, lon: 0, grace: now + GRACE_MS, calls: {}, viol: {}, landedAt: 0, landRwy: "" });
      if (type === "clearance") {
        // The clearance carries the squawk: keep the one already assigned, else pick a free one.
        let sq = c.assigned ? c.assigned.squawk : this.pickSquawk();
        if (sq === null) return json({ error: "no free squawk" }, 409);
        if (!c.assigned) {
          c.assigned = { squawk: sq, at: Date.now() };
          await this.ctx.storage.put("sq:" + c.pos.icao_address, c.assigned);
        }
        text = ph.clearance(dest, rwy, sq);
      } else if (type === "taxi") {
        text = ph.taxi(rwy); st.gr.taxi = now + 30 * 60_000;
      } else if (!lockKey) {
        text = ph[type](rwy);
        if (type === "takeoff") st.gr.takeoff = now + 10 * 60_000; else { st.gr.land = now + 15 * 60_000; st.landRwy = ""; }
      } else {
        // sequencing: the holder goes first, then the queue in order of request
        const q = (this.rwyQ.get(lockKey) || []).filter(k => this.clients.has(k));
        const busy = holder && holder.key !== key && this.clients.has(holder.key);
        if (busy || (q.length && q[0] !== key)) {
          if (!q.includes(key)) q.push(key);
          this.rwyQ.set(lockKey, q);
          const n = q.indexOf(key) + 1 + (busy ? 1 : 0);
          text = (type === "land" ? ph.busyLand : ph.busyTakeoff)(rwy, n);
        } else {
          this.rwyQ.set(lockKey, q.filter(k => k !== key));
          text = ph[type](rwy);
          this.rwy.set(lockKey, { key, type, until: now + REQ_LOCK_MS[type] });
          if (type === "takeoff") st.gr.takeoff = now + 10 * 60_000; else { st.gr.land = now + 15 * 60_000; st.landRwy = rwy; }
        }
      }
      const msg = this.addMsg(c, text, "auto", {});
      msg.status = "delivered";   // returned right here, not with the next position upload
      return json({ success: true, mode: "auto", messages: [{ id: msg.id, text: msg.text, kind: "auto", urgent: false, at: msg.at }] });
    }

    if ((m === "PUT" || m === "POST") && p === "/api/atc/tower") {
      const d = await request.json().catch(() => ({}));
      const name = String(d.name || "").trim().toUpperCase();
      const lat = Number(d.latitude), lon = Number(d.longitude);
      if (!/^[A-Z0-9]{2,8}$/.test(name) || !(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180))
        return json({ error: "need name (2-8 letters/digits), latitude and longitude" }, 400);
      if (!this.towers.has(name) && this.towers.size >= MAX_TOWERS) return json({ error: "too many towers" }, 409);
      if (this.towers.get(name)?.member && request.headers.get("X-Member") !== "1") return json({ error: "member_tower" }, 403);
      const t = { name, latitude: lat, longitude: lon, altitude_ft: Number(d.altitude_ft) || 0, at: Date.now(), member: request.headers.get("X-Member") === "1", atis: (this.towers.get(name) || {}).atis };
      this.towers.set(name, t);
      await this.ctx.storage.put("tower:" + name, t);
      return json({ success: true, callsign: "ATC_" + name });
    }
    if (m === "DELETE" && p === "/api/atc/tower") {
      const name = String(url.searchParams.get("name") || "").trim().toUpperCase();
      if (this.towers.get(name)?.member && request.headers.get("X-Member") !== "1") return json({ error: "member_tower" }, 403);
      this.towers.delete(name);
      await this.ctx.storage.delete("tower:" + name);
      return json({ success: true });
    }

    if (m === "GET" && p === "/api/atis") {
      const r = await this.atisFor(String(url.searchParams.get("name") || "").trim().toUpperCase());
      return r ? json(r) : json({ error: "no tower open at that airport" }, 404);
    }
    if ((m === "PUT" || m === "POST") && p === "/api/atc/atis") {
      const d = await request.json().catch(() => ({}));
      const name = String(d.name || "").trim().toUpperCase(), t = this.towers.get(name);
      if (!t) return json({ error: "no tower open at that airport" }, 404);
      if (t.member && request.headers.get("X-Member") !== "1") return json({ error: "member_tower" }, 403);
      const a = t.atis || (t.atis = { letter: "A", runways: "", frequencies: "", remarks: "", at: Date.now(), sig: "" });
      const cl = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
      let change = d.bump === true;
      if (d.runways !== undefined) { const v = cl(d.runways, 40).toUpperCase(); if (v !== a.runways) { a.runways = v; change = true; } }
      if (d.frequencies !== undefined) { const v = cl(d.frequencies, 120); if (v !== a.frequencies) { a.frequencies = v; change = true; } }
      if (d.remarks !== undefined) { const v = cl(d.remarks, 200); if (v !== a.remarks) { a.remarks = v; change = true; } }
      if (change) { a.letter = nextLetter(a.letter); a.at = Date.now(); }
      await this.ctx.storage.put("tower:" + name, t);
      return json(await this.atisFor(name));
    }

    if (m === "GET" && p === "/api/health")
      return json({ status: "ok", active_clients: this.clients.size, pilots: [...this.clients.values()].filter(c => c.pos).length, towers: this.towers.size, member: request.headers.get("X-Member") === "1" });

    if (m === "GET" && p === "/api/traffic") {
      const q = url.searchParams;
      const lat = parseFloat(q.get("lat") ?? q.get("latitude") ?? "0") || 0;
      const lon = parseFloat(q.get("lon") ?? q.get("lng") ?? q.get("longitude") ?? "0") || 0;
      const rad = parseFloat(q.get("radius_miles") ?? q.get("radius") ?? "250") || 250;
      return json(this.trafficBody(key, lat, lon, rad));
    }

    if ((m === "POST" || m === "PUT") && p === "/api/position") {
      const blocked = this.crashBlock(key);
      if (blocked) { this.clients.delete(key); return blocked; }
      let d = await request.json().catch(() => ({}));
      if (d.position && typeof d.position === "object") d = d.position;
      const lat = pick(d, "latitude", "lat"), lon = pick(d, "longitude", "lon", "lng");
      if (lat === undefined || lon === undefined) return json({ error: "latitude/longitude required" }, 400);
      const icao = String(pick(d, "icao_address", "icao") ?? (await keyIcao(key))).toUpperCase();
      const alt = pick(d, "altitude_ft", "altitude");
      const hdg = pick(d, "heading_true", "track", "heading");
      const gs = pick(d, "ground_speed", "velocity_knots", "gs");
      const vs = pick(d, "vertical_speed_ft_min", "vertical_speed");
      const sq = pick(d, "squawk_code", "squawk");
      const pos = {
        icao_address: icao, callsign: pick(d, "callsign") ?? icao,
        latitude: lat, longitude: lon,
        altitude_ft: alt, altitude: alt, heading_true: hdg, track: hdg,
        ground_speed: gs, velocity_knots: gs,
        vertical_speed_ft_min: vs, vertical_speed: vs,
        squawk: sq, squawk_code: sq,
        airborne_flag: pick(d, "airborne_flag"),
        heading_mag: pick(d, "heading_mag"),
        eta_min: pick(d, "eta_min"),
        landing_fpm: pick(d, "landing_fpm"),
        terminal: pick(d, "terminal") === true,
        voice: pick(d, "voice") !== false,
        phase: pick(d, "phase"), rwy_on: pick(d, "rwy_on"), on_rwy: pick(d, "on_rwy"), rwy_apt: pick(d, "rwy_apt"), arr_nm: pick(d, "arr_nm"), fq_dep: pick(d, "fq_dep"), fq_arr: pick(d, "fq_arr"),
        airplane_model: pick(d, "airplane_model"),
        airplane_livery: pick(d, "airplane_livery", "livery"),
        timestamp: pick(d, "timestamp") ?? Math.floor(Date.now() / 1000),
      };
      let c = this.clients.get(key);
      if (!c) {
        const rec = await this.ctx.storage.get("sq:" + icao);
        c = { plan: (await this.ctx.storage.get("plan:" + key)) || {},
              assigned: rec && Date.now() - rec.at < ASSIGN_TTL_MS ? rec : null };
      }
      c.pos = pos; c.seen = Date.now(); c.member = request.headers.get("X-Member") === "1";
      const lg = pick(d, "lang"); if (lg === "pt" || lg === "en") c.lang = lg;
      const lf = Number(pos.landing_fpm);
      if (pos.landing_fpm !== undefined && Number.isFinite(lf) && lf <= HARD_LANDING_FPM) {
        // hard landing = crash: the plane vanishes from traffic, an X is marked, the pilot waits CRASH_TIMEOUT_MS
        const now = Date.now();
        const cr = { key, icao, callsign: normCallsign(c.plan.callsign ?? pos.callsign), latitude: lat, longitude: lon, landing_fpm: Math.round(lf), at: now, until: now + CRASH_TIMEOUT_MS };
        this.crashes.set(key, cr);
        await this.ctx.storage.put("crash:" + key, cr);
        this.clients.delete(key);
        return this.crashBlock(key);
      }
      this.clients.set(key, c);
      const messages = [];
      for (const x of this.msgs.values()) if (x.icao === icao && x.status === "sent") { x.status = "delivered"; messages.push({ id: x.id, text: x.text, kind: x.kind, urgent: !!x.urgent, at: x.at }); }
      messages.push(...this.track(key, c, Date.now()));
      const reply = { success: true, messages, traffic_alerts: this.trafficAlerts(key, c) };
      const voice = [];
      for (const v of this.clips.values()) if (v.dir === "down" && v.icao === icao && !v.delivered) { v.delivered = true; voice.push({ id: v.id, audio: v.audio, mime: v.mime, ms: v.ms, at: v.at }); }
      if (voice.length) reply.voice = voice;
      if (url.searchParams.get("traffic") === "1") {
        // our client: nearest 100 entries (whole planet) + crashes, so it needs no separate /api/traffic poll
        const t = this.trafficList(key, lat, lon, 13000, 100);
        reply.aircraft = t.out; reply.truncated = t.truncated; reply.crashes = this.crashList();
      }
      return json(reply);
    }

    if ((m === "POST" || m === "PUT") && p === "/api/flightplan") {
      const blocked = this.crashBlock(key);
      if (blocked) return blocked;
      let d = await request.json().catch(() => ({}));
      if (d.flightplan && typeof d.flightplan === "object") d = d.flightplan;
      const plan = {};
      for (const [k, v] of Object.entries(d).slice(0, 30))
        if (["string", "number", "boolean"].includes(typeof v)) plan[k] = typeof v === "string" ? v.slice(0, 500) : v;
      const c = this.clients.get(key) || {};
      c.plan = plan; c.seen = Date.now();
      await this.ctx.storage.put("plan:" + key, plan);
      this.clients.set(key, c);
      return json({ success: true });
    }

    if (m === "DELETE" && p === "/api/position") {
      this.clients.delete(key);
      return json({ success: true });
    }
    return json({ error: "not found" }, 404);
  }
}
