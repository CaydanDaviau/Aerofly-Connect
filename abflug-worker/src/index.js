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
    timestamp: Math.floor(Date.now() / 1000), assigned_squawk: null, virtual_tower: true,
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
const REQ_TYPES = ["clearance", "taxi", "takeoff", "land"];
const REQ_LOCK_MS = { takeoff: 90_000, land: 120_000 };
const TOWER_COVER_MI = 8;   // a human tower this close to the aircraft (or named like its airport) takes the request
const PHRASE = {
  en: {
    clearance: (dest, r, sq) => `Cleared ${dest ? "to " + dest + " " : ""}as filed${r ? ", departure runway " + r : ""}, squawk ${sq}`,
    taxi: r => r ? `Taxi to runway ${r}, hold short` : "Taxi to the runway, hold short",
    takeoff: r => r ? `Runway ${r}, cleared for takeoff` : "Cleared for takeoff",
    land: r => r ? `Runway ${r}, cleared to land` : "Cleared to land",
    busyTakeoff: r => `Hold position, runway ${r} occupied`,
    busyLand: r => `Runway ${r} occupied, extend and request again`,
  },
  pt: {
    clearance: (dest, r, sq) => `Autorizado${dest ? " para " + dest : ""} conforme o plano${r ? ", pista de saída " + r : ""}, código ${sq}`,
    taxi: r => r ? `Táxi para a pista ${r}, aguarde antes da pista` : "Táxi para a pista, aguarde antes da pista",
    takeoff: r => r ? `Pista ${r}, autorizado a decolar` : "Autorizado a decolar",
    land: r => r ? `Pista ${r}, autorizado a pousar` : "Autorizado a pousar",
    busyTakeoff: r => `Aguarde na posição, pista ${r} ocupada`,
    busyLand: r => `Pista ${r} ocupada, prolongue e solicite novamente`,
  },
};
const REQ_LABEL = { clearance: "clearance", taxi: "taxi", takeoff: "takeoff", land: "landing" };
const cleanRunway = v => {
  const m = /^(\d{1,2})([LRC]?)$/.exec(String(v || "").toUpperCase().replace(/\s/g, ""));
  if (!m) return "";
  const n = Number(m[1]);
  return n >= 1 && n <= 36 ? String(n).padStart(2, "0") + m[2] : "";
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/atc" || url.pathname === "/atc/")
      return new Response(ATC_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    if (url.pathname === "/map" || url.pathname === "/map/")
      return new Response(MAP_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    if (!url.pathname.startsWith("/api/")) return json({ name: "abflug-community", ok: true });
    const key = (request.headers.get("X-API-Key") || (url.pathname === "/api/debug" ? url.searchParams.get("key") : "") || "").trim();
    if (url.pathname !== "/api/health" && url.pathname !== "/api/stats") {
      const allowed = (env.ABFLUG_KEYS || "").split(",").map(s => s.trim()).filter(Boolean);
      if (!key || (allowed.length && !allowed.includes(key))) return json({ error: "invalid api key" }, 401);
    }
    if (env.DEBUG) console.log(request.method, url.pathname + url.search, (await request.clone().text()).slice(0, 600));
    const stub = env.HUB.get(env.HUB.idFromName("global"));
    return stub.fetch(request, { headers: request.headers });
  },
};

export class Hub {
  constructor(ctx) {
    this.towers = new Map(); this.crashes = new Map(); this.ta = new Map();
    ctx.blockConcurrencyWhile(async () => {
      for (const [k, v] of await ctx.storage.list({ prefix: "tower:" })) this.towers.set(k.slice(6), v);
      for (const [k, v] of await ctx.storage.list({ prefix: "crash:" })) this.crashes.set(k.slice(6), v);
    }); this.ctx = ctx; this.clients = new Map(); this.msgs = new Map(); this.rwy = new Map(); this.msgSeq = 0; this.since = Date.now(); this.counts = {}; }

  purge() {
    const now = Date.now();
    for (const [k, c] of this.clients) if (now - c.seen > TTL_MS) this.clients.delete(k);
    for (const [k, m] of this.msgs) if (now - m.at > 30 * 60 * 1000) this.msgs.delete(k);
    for (const [k, l] of this.rwy) if (now > l.until) this.rwy.delete(k);
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

  trafficList(key, lat, lon, rad, max) {
    let out = [];
    for (const [ck, c] of this.clients) {
      const pos = c.pos;
      if (!pos) continue;
      const d = haversineMi(lat, lon, pos.latitude, pos.longitude);
      if (d <= rad) {
        const callsign = normCallsign(c.plan.callsign ?? pos.callsign);
        out.push({ ...pos, ...c.plan, callsign, ...towerFields(callsign), assigned_squawk: c.assigned ? c.assigned.squawk : null, ...(ck === key ? { self: true } : {}), distance_miles: Math.round(d * 10) / 10 });
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

  async fetch(request) {
    const url = new URL(request.url);
    const key = (request.headers.get("X-API-Key") || "").trim();
    const m = request.method, p = url.pathname;
    this.purge();

    if (m === "GET" && p === "/api/debug") {
      const now = Date.now();
      const mask = k => k.slice(0, 2) + "***" + k.slice(-1);
      return json({ towers: [...this.towers.values()], players: [...this.clients].map(([k, c]) => ({ key: mask(k), age_s: Math.round((now - c.seen) / 1000), position: c.pos || null, plan: c.plan || {} })) });
    }
    if (p !== "/api/stats" && p !== "/api/debug") { const k = m + " " + p; this.counts[k] = (this.counts[k] || 0) + 1; }
    if (m === "GET" && p === "/api/stats") {
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

    if ((m === "PUT" || m === "POST") && p === "/api/atc/request") {
      const d = await request.json().catch(() => ({}));
      const type = String(d.type || "");
      if (!REQ_TYPES.includes(type)) return json({ error: "type must be taxi, takeoff or land" }, 400);
      const c = this.clients.get(key);
      if (!c || !c.pos) return json({ error: "start flying first" }, 404);
      const now = Date.now();
      if (c.lastReq && now - c.lastReq < 2000) return json({ error: "too many requests" }, 429);
      c.lastReq = now;
      const plan = c.plan || {};
      const ph = PHRASE[d.lang === "pt" ? "pt" : "en"];
      const rwy = cleanRunway(plan[type === "land" ? "arrival_runway" : "departure_runway"]) || cleanRunway(d.runway);
      const apt = String(plan[type === "land" ? "arrival_airport" : "departure_airport"] || "").trim().toUpperCase();
      const dest = String(plan.arrival_airport || "").trim().toUpperCase();
      // A human controller wins: a tower named like the airport, or one close to the aircraft.
      const human = [...this.towers.values()].some(t =>
        (apt && t.name === apt) || haversineMi(t.latitude, t.longitude, c.pos.latitude, c.pos.longitude) <= TOWER_COVER_MI);
      if (human) {
        const msg = this.addMsg(c, "Requests " + REQ_LABEL[type] + (rwy ? ", runway " + rwy : ""), "request", {});
        msg.status = "request";
        return json({ success: true, mode: "controller", id: msg.id });
      }
      let text, lockKey = rwy ? (apt || "?") + "/" + rwy : null;
      const holder = lockKey && this.rwy.get(lockKey);
      if (type === "clearance") {
        // The clearance carries the squawk: keep the one already assigned, else pick a free one.
        let sq = c.assigned ? c.assigned.squawk : this.pickSquawk();
        if (sq === null) return json({ error: "no free squawk" }, 409);
        if (!c.assigned) {
          c.assigned = { squawk: sq, at: Date.now() };
          await this.ctx.storage.put("sq:" + c.pos.icao_address, c.assigned);
        }
        text = ph.clearance(dest, rwy, sq);
      } else if (type !== "taxi" && holder && holder.key !== key && this.clients.has(holder.key)) {
        text = (type === "land" ? ph.busyLand : ph.busyTakeoff)(rwy);
      } else {
        text = ph[type](rwy);
        if (type !== "taxi" && lockKey) this.rwy.set(lockKey, { key, until: now + REQ_LOCK_MS[type] });
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
      const t = { name, latitude: lat, longitude: lon, altitude_ft: Number(d.altitude_ft) || 0, at: Date.now() };
      this.towers.set(name, t);
      await this.ctx.storage.put("tower:" + name, t);
      return json({ success: true, callsign: "ATC_" + name });
    }
    if (m === "DELETE" && p === "/api/atc/tower") {
      const name = String(url.searchParams.get("name") || "").trim().toUpperCase();
      this.towers.delete(name);
      await this.ctx.storage.delete("tower:" + name);
      return json({ success: true });
    }

    if (m === "GET" && p === "/api/health")
      return json({ status: "ok", active_clients: this.clients.size, pilots: [...this.clients.values()].filter(c => c.pos).length, towers: this.towers.size });

    if (m === "GET" && p === "/api/traffic") {
      const q = url.searchParams;
      const lat = parseFloat(q.get("lat") ?? q.get("latitude") ?? "0") || 0;
      const lon = parseFloat(q.get("lon") ?? q.get("lng") ?? q.get("longitude") ?? "0") || 0;
      const rad = parseFloat(q.get("radius_miles") ?? q.get("radius") ?? "250") || 250;
      const { out, truncated } = this.trafficList(key, lat, lon, rad, MAX_TRAFFIC);
      const atc_messages = [...this.msgs.values()].map(x => ({ id: x.id, icao_address: x.icao, text: x.text, kind: x.kind, urgent: !!x.urgent, status: x.status, at: x.at }));
      const crashes = this.crashList();
      return json({ aircraft: out, traffic: out, truncated, active_clients: this.clients.size, atc_messages, crashes });
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
      c.pos = pos; c.seen = Date.now();
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
      const reply = { success: true, messages, traffic_alerts: this.trafficAlerts(key, c) };
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
