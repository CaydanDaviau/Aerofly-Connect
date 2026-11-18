import { parseMetar, wxSig, nextLetter } from "./atis.js";
import { distSeg } from "./taxi.js";
import { fetchGraph, diag as taxiDiag, nearest, startFor, noUturn, holdNode, route as taxiRoute, legs as taxiLegs, spokenName, dist as gDist } from "./taxi.js";
// Community backend for the Abflug Android client (v1.5.0) on Cloudflare Workers.
// All state lives in one Durable Object (in memory, TTL-based).
import ATC_HTML from "./atc.js";
import MAP_HTML from "./map.js";
import MANAGER_HTML from "./manager.js";
const ROUTE_MAX = 200;   // SimBrief route points kept per flight
const TTL_MS = 60_000;
const ASSIGN_TTL_MS = 12 * 3600_000;
const TOWER_TTL_MS = 120_000;   // an airport expires this long after its owner's page last refreshed it (the page sends a heartbeat every 45 s)
const MAX_TOWERS = 50;
// Positions of one airport: key = ICAO (TWR, kept for old towers) or ICAO_DEL / _GND / _APP / _CTR.
// A claimed position (the page sends a `holder` id + heartbeat) is freed POS_TTL_MS after the last heartbeat.
const ROLE_COOLDOWN_MS = 120_000;
const POS_TTL_MS = 120_000;
const POS_NAMES = ["DEL", "GND", "TWR", "APP", "CTR"];
const HANDOFF_TTL_MS = 120_000, PEND_TTL_MS = 120_000;
const POS_SPOKEN = { DEL: "delivery", GND: "ground", TWR: "tower", APP: "approach", CTR: "center" };
// Which positions can answer each request when staffed (next one up covers the one below it).
const COVER = { clearance: ["DEL", "GND", "TWR"], pushback: ["GND", "TWR"], taxi: ["GND", "TWR"], takeoff: ["TWR"], land: ["TWR"] };
const parseTowerName = s => {
  const m = /^([A-Z0-9]{2,8}?)(?:_(DEL|GND|TWR|APP|CTR))?$/.exec(String(s || "").trim().toUpperCase());
  if (!m) return null;
  const pos = m[2] || "APT";   // plain ICAO = the airport itself (symbol, ATIS); roles are ICAO_DEL / _GND / _TWR / _APP / _CTR
  return { apt: m[1], pos, name: pos === "APT" ? m[1] : m[1] + "_" + pos };
};
// short public id for a holder id (ids themselves are secrets: they are what proves you own a role)
const hid = h => { let x = 2166136261; for (const ch of String(h || "")) x = Math.imul(x ^ ch.charCodeAt(0), 16777619) >>> 0; return x.toString(36).slice(0, 6); };
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
  const m = /^ATC_([A-Z0-9]+)(?:_(?:DEL|GND|TWR|APP|CTR))?$/.exec(cs || "");
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
    position: t.pos || "TWR", airport: t.apt || t.name, claimed: !!t.holder, freq: t.freq || "",
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
// Newest released app versions: bump when a new APK / PC build is published; clients older than this show an update notice.
const FLIGHT_MIN_AIR_S = 180;   // airborne at least 3 min, then touchdown (no crash) = flight completed
const LATEST = { android: "1.2", pc: "2.2.0" };
const REQ_TYPES = ["clearance", "pushback", "taxi", "takeoff", "land", "mayday", "mayday_cancel"];
const MAYDAY_MS = 30 * 60_000, MAYDAY_NEAR_MI = 30;
const REQ_LOCK_MS = { takeoff: 90_000, land: 120_000 };
const TOWER_COVER_MI = 8;   // a human tower this close to the aircraft (or named like its airport) takes the request
// radio frequency "118.300" (118.000-136.975), "" when empty/invalid
const normFreq = v => { const m = /^(\d{3})\.(\d{1,3})$/.exec(String(v ?? "").trim()); if (!m) return ""; const f = m[1] + "." + m[2].padEnd(3, "0"); const n = Number(f); return n >= 118 && n <= 136.975 ? f : ""; };
// heard when either side is untuned ("all") or both are on the same frequency
const tunedTo = (a, b) => !a || !b || a === b;
const fqPick = (str, types) => { const m = {}; for (const kv of String(str || "").split(";")) { const [k, v] = kv.split("="); if (k && v && /^\d{3}\.\d{1,3}$/.test(v)) m[k] = v; } for (const t of types) if (m[t]) return m[t]; return ""; };
const PHRASE = {
  en: {
    clearance: (dest, r, sq) => `Cleared ${dest ? "to " + dest + " " : ""}as filed${r ? ", departure runway " + r : ""}, squawk ${sq}`,
    taxi: r => r ? `Taxi to runway ${r}, hold short` : "Taxi to the runway, hold short",
    pushback: r => `Pushback approved${r ? ", expect runway " + r : ""}`,
    direct: f => `Proceed direct ${f}`, offRoute: f => `You appear off route, say intentions${f ? " or proceed direct " + f : ""}`, expectRwy: r => `Expect runway ${r}`,
    gTaxiOut: (r, via) => `Taxi to runway ${r}${via ? " via " + via : ""}, hold short runway ${r}`,
    gTaxiGate: (g, via) => `Taxi to ${g ? "gate " + g : "the gate"}${via ? " via " + via : ""}`,
    gHold: (via, r) => `Taxi${via ? " via " + via : ""}, hold short of runway ${r}`,
    gCross: r => `cross runway ${r}`, gGive: cs => `give way to ${cs}`, gWord: "Runway", gVacate: "vacate via",
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
    welcome: (a, f) => `Welcome to ${a}${f ? ", contact ground " + f : ""}`,
    goAround: r => `Go around, runway ${r} occupied`,
    vTaxi: "Stop, hold position, you are not cleared to taxi",
    vRunway: "Hold position, you are not cleared on the runway, vacate",
    vLand: r => `Landing without clearance${r ? " on runway " + r : ""}, vacate the runway`,
  },
  pt: {
    clearance: (dest, r, sq) => `Autorizado${dest ? " para " + dest : ""} conforme o plano${r ? ", pista de saída " + r : ""}, código ${sq}`,
    taxi: r => r ? `Táxi para a pista ${r}, aguarde antes da pista` : "Táxi para a pista, aguarde antes da pista",
    pushback: r => `Pushback autorizado${r ? ", espere a pista " + r : ""}`,
    direct: f => `Proceda direto a ${f}`, offRoute: f => `Você parece fora da rota, informe intenções${f ? " ou proceda direto a " + f : ""}`, expectRwy: r => `Espere a pista ${r}`,
    gTaxiOut: (r, via) => `Táxi para a pista ${r}${via ? " via " + via : ""}, aguarde antes da pista ${r}`,
    gTaxiGate: (g, via) => `Táxi para ${g ? "o portão " + g : "o portão"}${via ? " via " + via : ""}`,
    gHold: (via, r) => `Táxi${via ? " via " + via : ""}, aguarde antes da pista ${r}`,
    gCross: r => `cruze a pista ${r}`, gGive: cs => `dê passagem a ${cs}`, gWord: "Pista", gVacate: "livre via",
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
    welcome: (a, f) => `Bem-vindo a ${a}${f ? ", contate o solo " + f : ""}`,
    goAround: r => `Arremeta, pista ${r} ocupada`,
    vTaxi: "Pare, aguarde na posição, você não está autorizado a taxiar",
    vRunway: "Aguarde na posição, você não está autorizado na pista, desocupe",
    vLand: r => `Pouso sem autorização${r ? " na pista " + r : ""}, desocupe a pista`,
  },
};
const REQ_LABEL = { clearance: "clearance", pushback: "pushback", taxi: "taxi", takeoff: "takeoff", land: "landing" };
const cleanRunway = v => {
  const m = /^(\d{1,2})([LRC]?)$/.exec(String(v || "").toUpperCase().replace(/\s/g, ""));
  if (!m) return "";
  const n = Number(m[1]);
  return n >= 1 && n <= 36 ? String(n).padStart(2, "0") + m[2] : "";
};

// opposite end of a runway: 29L <-> 11R
const oppRunway = r => { const m = /^(\d\d)([LRC]?)$/.exec(r); if (!m) return r; const n = ((Number(m[1]) + 17) % 36) + 1; return String(n).padStart(2, "0") + ({ L: "R", R: "L", C: "C", "": "" })[m[2]]; };
const spokenRwy = r => String(r || "").replace(/^(\d)(?=\D|$)/, "0$1");
const rwyKey = (apt, r) => (apt || "?") + "/" + [r, oppRunway(r)].sort()[0];
const GRACE_MS = 20_000, VIOL_SHOW_MS = 30_000, VIOL_RENEW_MS = 20_000, MAX_VIOL = 100;
const PUSH_MS = 3000;
const VOICE_TTL_MS = 5 * 60 * 1000, VOICE_MAX_CLIPS = 120, VOICE_MAX_B64 = 250_000, VOICE_LISTEN_MS = 60_000;
const up =v => String(v || "").trim().toUpperCase();

// Hash of the caller's IP (never stored or sent in clear); used to keep one person from opening many airports with fresh browser ids.
const ipTag = request => { const ip = request.headers.get("CF-Connecting-IP"); return ip ? "ip" + hid(ip) + hid(ip + "x") : ""; };
// Group code: Worker var GROUP_CODE; clients send it as X-Group header (or ?group=). The Hub only ever sees X-Member 1/0, never the code.
function memberFlag(request, env, url) {
  const gc = String(env.GROUP_CODE || "").trim();
  const got = String(request.headers.get("X-Group") || url.searchParams.get("group") || "").trim();
  return !!gc && got === gc;
}

// ATC credential: Worker var ATC_CODES (comma separated, each "CODE" or "CODE=Name"), issued by the network management to controllers.
// Only meaningful for group members. X-Atc to the Hub: "1" valid, "0" invalid/missing, "n" no codes configured (rule off).
function atcFlag(request, env, url, member) {
  const codes = String(env.ATC_CODES || "").split(",").map(s => s.split("=")[0].trim()).filter(Boolean);
  if (!codes.length) return "n";
  const got = String(request.headers.get("X-Atc") || url.searchParams.get("atc") || "").trim();
  return member && got && codes.includes(got) ? "1" : "0";
}
// Manager: Worker var MANAGER_CODES (comma separated). A manager can generate/revoke ATC credentials from /manager. X-Mgr to the Hub: "1"/"0".
function mgrFlag(request, env, url) {
  const codes = String(env.MANAGER_CODES || "").split(",").map(s => s.trim()).filter(Boolean);
  const got = String(request.headers.get("X-Manager") || url.searchParams.get("manager") || "").trim();
  return codes.length && got && codes.includes(got) ? "1" : "0";
}
function atcName(request, env, url) {
  const got = String(request.headers.get("X-Atc") || url.searchParams.get("atc") || "").trim();
  if (!got) return "";
  for (const e of String(env.ATC_CODES || "").split(",")) { const [c, ...n] = e.split("="); if (c.trim() === got) return n.join("=").trim().slice(0, 40); }
  return "";
}
const atcRaw = (request, url) => String(request.headers.get("X-Atc") || url.searchParams.get("atc") || "").trim().slice(0, 40);
const CRED_ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newCred() { const b = crypto.getRandomValues(new Uint8Array(10)); const c = [...b].map(x => CRED_ALPHA[x % 32]).join(""); return "ATC-" + c.slice(0, 5) + "-" + c.slice(5); }

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/atc" || url.pathname === "/atc/")
      return new Response(ATC_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    if (url.pathname === "/map" || url.pathname === "/map/")
      return new Response(MAP_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    if (url.pathname === "/manager" || url.pathname === "/manager/")
      return new Response(MANAGER_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") return json({ error: "websocket expected" }, 426);
      const wk = (url.searchParams.get("key") || "").trim();
      const allowed = (env.ABFLUG_KEYS || "").split(",").map(s => s.trim()).filter(Boolean);
      if (!wk || (allowed.length && !allowed.includes(wk))) return json({ error: "invalid api key" }, 401);
      const h = new Headers(request.headers); h.set("X-API-Key", wk); const mem = memberFlag(request, env, url); h.set("X-Member", mem ? "1" : "0"); h.set("X-Atc", atcFlag(request, env, url, mem)); h.set("X-Atc-Raw", atcRaw(request, url)); h.set("X-Atc-Name", atcName(request, env, url)); h.set("X-IP", ipTag(request));
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
    const hh = new Headers(request.headers); hh.delete("X-Group"); hh.delete("X-Atc"); hh.delete("X-Manager"); hh.set("X-Atc-Raw", atcRaw(request, url)); hh.set("X-Atc-Name", atcName(request, env, url)); hh.set("X-Mgr", mgrFlag(request, env, url)); const mem2 = memberFlag(request, env, url); hh.set("X-Member", mem2 ? "1" : "0"); hh.set("X-Atc", atcFlag(request, env, url, mem2)); hh.set("X-IP", ipTag(request));
    return stub.fetch(request, { headers: hh });
  },
};

export class Hub {
  constructor(ctx) {
    this.towers = new Map(); this.creds = new Map(); this.credOn = false; this.wx = new Map(); this.crashes = new Map(); this.ta = new Map();
    this.voiceStreams = new Map(); this.latestVoiceByPeer = new Map();
    this.prof = new Map(); this.lastClaim = new Map(); this.clients = new Map(); this.msgs = new Map(); this.rwy = new Map(); this.rwyQ = new Map(); this.gfx = new Map(); this.tres = new Map(); this.stands = new Map(); this.violations = []; this.clips = new Map(); this.listeners = new Map(); this.msgSeq = 0; this.since = Date.now(); this.counts = {};
    ctx.blockConcurrencyWhile(async () => {
      for (const [k, v] of await ctx.storage.list({ prefix: "tower:" })) this.towers.set(k.slice(6), v);
      for (const [k, v] of await ctx.storage.list({ prefix: "cred:" })) this.creds.set(k.slice(5), v);
      this.credOn = !!(await ctx.storage.get("credon")) || this.creds.size > 0;
      for (const [k, v] of await ctx.storage.list({ prefix: "crash:" })) this.crashes.set(k.slice(6), v);
      for (const [k, v] of await ctx.storage.list({ prefix: "prof:" })) this.prof.set(k.slice(5), v);
    }); this.ctx = ctx; }

  purge() {
    const now = Date.now();
    for (const [k, c] of this.clients) if (now - c.seen > TTL_MS) this.clients.delete(k);
    for (const [k, m] of this.msgs) if (now - m.at > 30 * 60 * 1000) this.msgs.delete(k);
    for (const [k, l] of this.rwy) if (now > l.until) this.rwy.delete(k);
    for (const [k, r] of this.tres) if (now > r.until || !this.clients.has(r.key)) this.tres.delete(k);
    for (const [k, r] of this.stands) if (now > r.until || !this.clients.has(r.key)) this.stands.delete(k);
    for (const [k, v] of this.gfx) if (now - v.at > 24 * 3600_000) this.gfx.delete(k);
    for (const [k, v] of this.clips) if (now - v.at > VOICE_TTL_MS) this.clips.delete(k);
    for (const [k, v] of this.listeners) if (now - v.at > VOICE_LISTEN_MS) this.listeners.delete(k);
    for (const [k, v] of this.voiceStreams) if (now - v.at > 90_000) this.voiceStreams.delete(k);
    for (const [k, q] of this.rwyQ) { const f = q.filter(x => this.clients.has(x)); if (f.length) this.rwyQ.set(k, f); else this.rwyQ.delete(k); }
    for (const [k, t] of this.ta) if (now - t > 120_000) this.ta.delete(k);
    for (const [k, cr] of this.crashes) if (now - cr.at > CRASH_SHOW_MS) { this.crashes.delete(k); this.ctx.storage.delete("crash:" + k); }
    for (const [k, t] of this.towers) if (now - t.at > (t.holder ? POS_TTL_MS : TOWER_TTL_MS)) { this.towers.delete(k); this.ctx.storage.delete("tower:" + k); }
  }



  // ---- waypoint tracking on the pilot's own route (SimBrief / route upload): next fix, direct-to, off-route
  wpTrack(c, st, p, now, say, ph, cur, an) {
    const pts = c.route && c.route.points;
    if (!pts || pts.length < 2) { st.wp = null; return; }
    const la = p.latitude, lo = p.longitude;
    const nm = (a, b) => haversineMi(la, lo, a, b) * 0.868976;
    const w = st.wp && st.wp.at === c.route.at ? st.wp : (st.wp = { at: c.route.at, i: 0, off: 0, said: 0 });
    const id = i => String(pts[i][3] || "").trim();
    const named = i => /^[A-Z0-9]{2,7}$/.test(id(i)) && !/^[A-Z]{4}$/.test(id(i));   // skip airport idents / blanks
    // advance: first fix not yet reached (within 4 nm or already passed along the leg)
    while (w.i < pts.length - 1 && nm(pts[w.i][0], pts[w.i][1]) < 4) w.i++;
    if (cur !== "air") { w.i = 0; w.off = 0; w.init = false; return; }
    // joined (or resumed) mid-route: start at the end of the leg nearest the aircraft, not at the first fix
    if (!w.init) {
      w.init = true;
      let best = 1, bd = Infinity;
      for (let j = 0; j + 1 < pts.length; j++) { const d = distSeg(la, lo, { lat: pts[j][0], lon: pts[j][1] }, { lat: pts[j + 1][0], lon: pts[j + 1][1] }); if (d < bd) { bd = d; best = j + 1; } }
      if (best > w.i) w.i = best;
    }
    // skip fixes already passed: aircraft is beyond the fix along the next leg
    while (w.i < pts.length - 1) {
      const k = Math.cos(la * Math.PI / 180), ax = (la - pts[w.i][0]), ay = (lo - pts[w.i][1]) * k, bx = pts[w.i + 1][0] - pts[w.i][0], by = (pts[w.i + 1][1] - pts[w.i][1]) * k;
      if (ax * bx + ay * by > 0 && distSeg(la, lo, { lat: pts[w.i][0], lon: pts[w.i][1] }, { lat: pts[w.i + 1][0], lon: pts[w.i + 1][1] }) < 20 * 1852) w.i++; else break;
    }
    let n = w.i; while (n < pts.length - 1 && !named(n)) n++;
    const fix = named(n) ? id(n) : "";
    // first call after departure: direct to the first named fix
    if (!st.calls.direct && fix && st.calls.dep) { st.calls.direct = true; say(ph.direct(fix), false); }
    // off route: more than 10 nm from the active leg for 60 s (not near either airport's terminal area)
    const a = w.i > 0 ? pts[w.i - 1] : null, b = pts[w.i];
    const from = a ? { lat: a[0], lon: a[1] } : null, to = { lat: b[0], lon: b[1] };
    const xt = from ? distSeg(la, lo, from, to) / 1852 : nm(to.lat, to.lon);
    const term = (Number.isFinite(an) && an < 25) || haversineMi(la, lo, pts[0][0], pts[0][1]) < 15;
    if (!term && xt > 10) { if (!w.off) w.off = now; } else w.off = 0;
    if (w.off && now - w.off > 60_000 && now - w.said > 5 * 60_000) { w.said = now; say(ph.offRoute(fix), false); }
  }

  // ---- ground routing (taxiway names from OpenFreeMap vector tiles, Overpass as fallback; cached per airport 24 h, failures retried after 2 min)
  graphFor(apt, lat, lon) {
    const now = Date.now(), v = this.gfx.get(apt);
    if (v && v.g && gDist(lat, lon, v.g.center.lat, v.g.center.lon) < 3500) return Promise.resolve(v.g);
    if (v && v.p) return v.p;
    if (v && !v.g && now - v.at < 120_000) return Promise.resolve(null);
    const p = fetchGraph(lat, lon).then(g => { this.gfx.set(apt, { at: Date.now(), g, err: g ? "" : "tiles: " + (taxiDiag.tiles || "-") + " | overpass: " + (taxiDiag.overpass || "-") }); return g; }, e => { this.gfx.set(apt, { at: Date.now(), g: null, err: String(e && e.message || e) }); return null; });
    this.gfx.set(apt, { at: now, g: v ? v.g : null, p });
    return p;
  }
  // kind: "out" (to the hold short point of rwy) | "gate". Returns {text} or null (no data / no path): caller falls back to generic text.
  async groundRoute(key, c, kind, apt, rwy, wait) {
    const p = c.pos;
    let g = null;
    try { g = await Promise.race([this.graphFor(apt, p.latitude, p.longitude), new Promise(r => setTimeout(() => r(undefined), wait))]); } catch (e) {}
    if (g === undefined) return undefined;   // still downloading
    if (!g) return null;
    const now = Date.now(), lang = c.lang === "pt" ? "pt" : "en", ph = PHRASE[lang];
    const hdg = Number(p.heading_true), gs0 = Number(p.ground_speed), from = startFor(g, p.latitude, p.longitude, hdg, gs0, 500);
    if (!from) return null;
    let toId = null, gate = "";
    if (kind === "out") { const h = rwy && holdNode(g, rwy); if (!h) return null; toId = h.id; }
    // other ground traffic: occupied nodes and reserved edges cost extra so routes avoid meeting head on
    const occ = new Set();
    for (const [k2, o] of this.clients) {
      if (k2 === key || !o.pos || now - o.seen > 15_000 || o.pos.phase === "air" || !!o.member !== !!c.member) continue;
      if (gDist(o.pos.latitude, o.pos.longitude, p.latitude, p.longitude) > 6000) continue;
      const n = nearest(g, o.pos.latitude, o.pos.longitude, 60); if (n) occ.add(n.id);
    }
    const extra = (e, fromId) => {
      let x = 0;
      const r = this.tres.get(apt + ":" + e.i);
      if (r && r.key !== key && now < r.until) x += r.from === fromId ? 350 : 800;
      if (occ.has(e.a) || occ.has(e.b)) x += 500;
      return x;
    };
    const extra2 = noUturn(g, from.id, p.latitude, p.longitude, hdg, gs0, extra);
    let path = null;
    if (kind === "gate") {
      const taken = new Set([...this.stands].filter(([k, r]) => r.key !== key && now < r.until).map(([k]) => k));
      const cand = g.stands.filter(s => !taken.has(apt + ":" + (s.ref || s.lat + "," + s.lon))).map(s => ({ s, d: gDist(p.latitude, p.longitude, s.lat, s.lon) })).sort((a, b) => a.d - b.d).slice(0, 4);
      for (const { s } of cand) { path = taxiRoute(g, from.id, s.node, extra2); if (path) { gate = s.ref; this.stands.set(apt + ":" + (s.ref || s.lat + "," + s.lon), { key, until: now + 15 * 60_000 }); break; } }
    } else path = taxiRoute(g, from.id, toId, extra2);
    if (!path) return null;
    // legs -> words; a crossing of a busy runway ends the instruction ("hold short")
    const lg = taxiLegs(path, g), parts = []; let held = "", heldFrom = null, cutAt = -1, rwyIdx = 0;
    let lead = true;   // the aircraft may start on a runway (rollout): that part is "vacate", not a crossing
    for (const l of lg) {
      if (l.kind === "rwy") {
        if (lead) continue;
        const idents = String(l.name).split(/[\/;]/).map(s => s.trim().toUpperCase()).filter(Boolean), id0 = idents[0] || "";
        const busy = idents.some(r => { const h = this.rwy.get(rwyKey(apt, r)); return h && h.key !== key && now < h.until && this.clients.has(h.key); });
        if (busy) { held = id0; heldFrom = l.from; break; }
        for (const r of idents) this.rwy.set(rwyKey(apt, r), { key, type: "cross", until: now + 60_000 });
        parts.push(ph.gCross(spokenRwy(id0)));
      } else { lead = false; if (l.name) parts.push(spokenName(l.name)); }
    }
    // reserve the route, note who is in the way
    for (const [k, r] of this.tres) if (r.key === key) this.tres.delete(k);
    const who = new Set();
    for (const s of path) {
      const k = apt + ":" + s.e.i, r = this.tres.get(k);
      if (r && r.key !== key && now < r.until) { const o = this.clients.get(r.key); if (o) who.add(normCallsign(o.plan?.callsign ?? o.pos?.callsign)); }
      this.tres.set(k, { key, until: now + 8 * 60_000, from: s.from });
    }
    // route line for the maps: nodes from the aircraft to the hold-short point / stand (cut where a busy runway stops the instruction)
    {
      const pts = [[from.lat, from.lon]]; const heldNode = held ? heldFrom : null;
      for (const s of path) {
        const nd = g.nodes.get(s.to); if (!nd) continue;
        if (heldNode !== null && s.from === heldNode) break;
        pts.push([nd.lat, nd.lon]);
        if (heldNode !== null && s.to === heldNode) break;
      }
      const last = pts[pts.length - 1];
      c.taxi = { kind, apt, points: pts.map(q => [Math.round(q[0] * 1e6) / 1e6, Math.round(q[1] * 1e6) / 1e6]), end: { lat: last[0], lon: last[1], label: held ? "HOLD " + held : kind === "out" ? "HOLD " + (rwy || "") : gate ? "GATE " + gate : "GATE" }, held: !!held, at: now, until: now + 20 * 60_000 };
    }
    const via = parts.join(", ");
    let text = held ? ph.gHold(via, spokenRwy(held)) : kind === "out" ? ph.gTaxiOut(rwy, via) : ph.gTaxiGate(gate, via);
    if (who.size) text += ", " + ph.gGive([...who][0]);
    return { text, held: !!held };
  }

  // Profile: nickname + flight time (airborne) + ATC time (holding a role), per app key. Saved at most once a minute.
  profGet(key) { let p = this.prof.get(key); if (!p) { p = { nick: "", flight_s: 0, atc_s: 0, flights: 0, saved: 0 }; this.prof.set(key, p); } if (!p.flights) p.flights = 0; return p; }
  profAdd(key, field, secs, now) {
    if (!key || !(secs > 0)) return;
    const p = this.profGet(key); p[field] += secs;
    if (now - p.saved > 60_000) { p.saved = now; this.ctx.storage.put("prof:" + key, p); }
  }
  activeAtcHolder(holder) {
    if (!holder) return false;
    const now = Date.now();
    return [...this.towers.values()].some(t => t.holder === holder && POS_NAMES.includes(t.pos) && now - t.at <= POS_TTL_MS);
  }
  // The live role record a holder works (null = none)
  roleOf(holder, pos) {
    if (!holder) return null;
    const now = Date.now(), all = [...this.towers.values()].filter(t => t.holder === holder && POS_NAMES.includes(t.pos) && now - t.at <= POS_TTL_MS);
    return (pos && all.find(t => t.pos === pos)) || all[0] || null;   // a holder with several roles: the asked one first
  }
  // The live role currently handling an aircraft (set when a handoff is accepted); null if none or the role went away
  handlerOf(c) {
    const r = c && c.handler && this.towers.get(c.handler);
    return r && r.holder && Date.now() - r.at <= POS_TTL_MS ? r : null;
  }
  handFields(c) {
    const h = this.handlerOf(c), ho = c.handoff && Date.now() - c.handoff.at <= HANDOFF_TTL_MS ? c.handoff : null;
    const r = {};
    if (h) { r.handler = h.pos; r.handler_apt = h.apt; r.handler_ctl = h.ctl || h.nick || ""; }
    if (ho) { r.handoff_from = ho.from; r.handoff_to = ho.to; r.handoff_apt = ho.apt; }
    return r;
  }
  // Airport lead guard (owner of the airport or a group member), shared by approval / approve / deny
  leadGuard(request, d) {
    const apt = String(d.airport || "").trim().toUpperCase(), who = String(d.holder || "").slice(0, 40), now = Date.now();
    const a = this.towers.get(apt), member = request.headers.get("X-Member") === "1";
    if (!a || a.pos !== "APT") return { err: json({ error: "no airport open with that code" }, 404) };
    if (!member) {
      if (!who || a.owner !== who) return { err: json({ error: "not_owner", airport: apt }, 403) };
      const lk = this.lockedApt(who, now);
      if (lk && lk !== apt) return { err: json({ error: "locked_to_airport", airport: lk }, 409) };
    }
    return { a, apt, who, now };
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

  // type given: only a staffed position that can answer it counts (COVER chain); no type: any position of the airport.
  humanCovers(c, apt, type) {
    const ok = t => !!t.member === !!c.member && t.pos !== "APT" && (!type || !COVER[type] || COVER[type].includes(t.pos || "TWR"));
    return [...this.towers.values()].some(t => ok(t) && ((apt && (t.apt || t.name) === apt) || haversineMi(t.latitude, t.longitude, c.pos.latitude, c.pos.longitude) <= TOWER_COVER_MI));
  }
  towerOf(apt) { for (const t of this.towers.values()) if ((t.apt || t.name) === apt) return t; return null; }
  // The airport this person (browser id `who` or IP tag) already has open as owner / role holder, or null.
  airportOf(who, ipt) {
    for (const t of this.towers.values()) {
      if (t.member) continue;
      if ((who && (t.owner === who || t.holder === who)) || (ipt && t.oip === ipt)) return t.apt || t.name;
    }
    return null;
  }
  // The airport a holder currently works a live role at (null = free). One airport at a time.
  lockedApt(who, now) {
    if (!who) return null;
    for (const t of this.towers.values()) if ((t.pos || "TWR") !== "APT" && t.holder === who && now - t.at <= POS_TTL_MS) return t.apt || t.name;
    return null;
  }
  // ATIS and weather belong to the airport: resolve an airport code (or any position name) to the tower record that holds them.
  towerKey(name) {
    const pn = parseTowerName(name), apt = pn ? pn.apt : name;
    let best = null, bestScore = -1;
    for (const [k, t] of this.towers) {
      if ((t.apt || t.name) !== apt) continue;
      const score = (t.atis ? 2 : 0) + ((t.pos || "TWR") === "APT" ? 1 : 0);
      if (score > bestScore) { best = k; bestScore = score; }
    }
    return best;
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
  // frequency for an auto handoff: a staffed human position of that airport first, else OurAirports data from the app
  pf(str, apt, roles) {
    for (const r of roles) for (const t of this.towers.values()) if (t.freq && (t.apt || t.name) === apt && (t.pos || "TWR") === r) return t.freq;
    return fqPick(str, roles);
  }

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
    if (cur === "ground" && /^[A-Z]{4}$/.test(dep) && !this.gfx.has(dep)) this.graphFor(dep, p.latitude, p.longitude);   // warm the taxiway cache before the first taxi request
    const onRwys = String(p.rwy_on || "").split("/").map(cleanRunway).filter(Boolean);

    // runway locks held by this aircraft: kept while it is on the runway, dropped when it leaves or departs
    for (const [k, l] of this.rwy) {
      if (l.key !== key) continue;
      if (cur === "runway") l.until = Math.max(l.until, now + 30_000);
      else if ((cur === "air" && l.type === "takeoff") || (cur === "ground" && prev === "runway")) this.rwy.delete(k);
    }

    if (cur === "air") {
      if (prev && prev !== "air" && !st.calls.dep) { st.calls.dep = true; if (st.gr.takeoff > now || prev === "runway") { const f = this.pf(p.fq_dep, dep, ["DEP", "APP"]); say(ph.departure(f), false, "Departure" + (f ? " " + f : "")); } }
      st.gr.taxi = 0; st.gr.takeoff = 0;
      // short final to a runway that is occupied: go around
      const lr = cleanRunway(plan.arrival_runway) || st.landRwy;
      if (st.gr.land > now && !st.calls.ga && lr && arr && Number(p.arr_nm) <= 3 && this.occupant(key, arr, lr, now)) {
        st.calls.ga = true; st.gr.land = 0; say(ph.goAround(lr), true);
      }
      if (Number(p.arr_nm) > 6) st.calls.ga = false;
      // arrival handoffs: approach, then tower (once each per approach; reset when far away again)
      const an = Number(p.arr_nm);
      this.wpTrack(c, st, p, now, say, ph, cur, an);
      if (arr && Number.isFinite(an) && p.arr_nm !== null && p.arr_nm !== undefined) {
        if (an > 45) { st.calls.app = false; st.calls.twr = false; }
        else if (an <= 12 && !st.calls.twr) {
          st.calls.twr = true; st.calls.app = true; const f = this.pf(p.fq_arr, arr, ["TWR"]); say(ph.tower(f), false, "Tower" + (f ? " " + f : ""));
        } else if (an <= 35 && an > 12 && !st.calls.app) {
          st.calls.app = true; const f = this.pf(p.fq_arr, arr, ["APP", "DEP"]); say(ph.approach(f), false, "Approach" + (f ? " " + f : ""));
          const er = cleanRunway(plan.arrival_runway); if (er) say(ph.expectRwy(er), false);
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
        if (apt && apt === arr && /^[A-Z]{4}$/.test(apt)) st.rollout = apt;   // taxi route to the gate follows once the speed is down
        c.emerg = null;   // an emergency ends on the ground (its landing is never a violation)
        if (cleared && !busy && apt && apt === arr) { const f = this.pf(p.fq_arr, arr, ["GND"]); say(ph.welcome(apt, f), false, "Ground" + (f ? " " + f : "")); }
      } else if (now > st.grace) {
        if (cur === "ground" && gs >= 10 && !(st.gr.taxi > now) && !(st.gr.takeoff > now))
          this.violate(key, c, st, "taxi", apt, "", now, () => say(ph.vTaxi, true));
        if (cur === "runway" && !(st.gr.takeoff > now) && now - st.landedAt > 120_000 && (p.on_rwy || gs >= 15))
          this.violate(key, c, st, "runway", apt, onRwys[0] || "", now, () => say(ph.vRunway, true));
      }
    }
    if (st.rollout && cur !== "air" && prev !== "air" && gs < 35 && now - st.landedAt > 6000) {
      const a = st.rollout; st.rollout = null;
      this.groundRoute(key, c, "gate", a, "", 25_000).then(r => { this.addMsg(c, r ? r.text : ph.gTaxiGate("", ""), "auto", {}); }, () => {});
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

  trafficList(key, lat, lon, rad, max, vm) {
    let out = [];
    for (const [ck, c] of this.clients) {
      const pos = c.pos;
      if (!pos || !!c.member !== !!vm) continue;   // members and public never see each other
      const d = haversineMi(lat, lon, pos.latitude, pos.longitude);
      if (d <= rad) {
        const callsign = normCallsign(c.plan.callsign ?? pos.callsign);
        out.push({ ...pos, ...c.plan, callsign, ...towerFields(callsign), member: !!c.member, ...(!c.member && this.prof.get(ck)?.nick ? { nick: this.prof.get(ck).nick } : {}), has_route: !!c.route, has_taxi: !!(c.taxi && Date.now() < c.taxi.until), ...this.handFields(c), freq: c.pos.freq || "", assigned_squawk: c.assigned ? c.assigned.squawk : null, emergency: !!(c.emerg && Date.now() < c.emerg.until), no_clnc: !!(c.viol && Date.now() - c.viol.at < VIOL_SHOW_MS), ...(ck === key ? { self: true } : {}), distance_miles: Math.round(d * 10) / 10 });
      }
    }
    // one symbol per airport; its staffed roles are listed in `positions`
    const byApt = new Map();
    for (const t of this.towers.values()) {
      const a = t.apt || t.name;
      let g = byApt.get(a); if (!g) byApt.set(a, g = { anchor: null, roles: [] });
      if ((t.pos || "TWR") === "APT") g.anchor = t; else g.roles.push(t);
    }
    for (const [a, g] of byApt) {
      const base = g.anchor || g.roles[0];
      if (!!base.member !== !!vm) continue;
      const d = haversineMi(lat, lon, base.latitude, base.longitude);
      if (d > rad) continue;
      const e = towerAircraft({ ...base, name: a, pos: "APT", holder: undefined, freq: "" }, d);
      e.positions = g.roles.map(r => ({ pos: r.pos || "TWR", freq: r.freq || "", claimed: !!r.holder, hid: r.holder ? hid(r.holder) : "", ctl: r.holder ? (r.ctl || "") : "", nick: r.holder && !r.member ? (r.nick || "") : "" }));
      e.owner_hid = g.anchor && g.anchor.owner ? hid(g.anchor.owner) : "";
      e.bans = g.anchor && g.anchor.bans ? Object.values(g.anchor.bans).map(b => ({ hid: b.hid, pos: b.pos })) : [];
      e.claimed = g.roles.some(r => r.holder);
      e.approval = !!(g.anchor && g.anchor.approval);
      e.pending = g.anchor && g.anchor.pend ? Object.values(g.anchor.pend).filter(p => Date.now() - p.at <= PEND_TTL_MS).map(p => ({ hid: p.hid, pos: p.pos, name: p.name || "" })) : [];
      out.push(e);
    }
    out.sort((a, b) => a.distance_miles - b.distance_miles);
    const truncated = out.length > max;
    return { out: out.slice(0, max), truncated };
  }

  crashList(vm) {
    return [...this.crashes.values()].filter(x => !!x.member === !!vm).map(x => ({ callsign: x.callsign, icao_address: x.icao, latitude: x.latitude, longitude: x.longitude, landing_fpm: x.landing_fpm, at: x.at, until: x.until }));
  }

  trafficAlerts(key, c) {
    const now = Date.now(), out = [];
    for (const [k2, o] of this.clients) {
      if (k2 === key || !o.pos || now - o.seen > 15_000 || !!o.member !== !!c.member) continue;
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
    const holder = String(new URL(request.url).searchParams.get("holder") || "").slice(0, 80);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ key, holder, sub: null, member: request.headers.get("X-Member") === "1", atc: request.headers.get("X-Atc") || "n", atcRaw: request.headers.get("X-Atc-Raw") || "", atcName: request.headers.get("X-Atc-Name") || "", ip: request.headers.get("X-IP") || "" });
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
      const sk = (a.member ? "m" : "p") + a.key + "|" + a.sub.lat + "|" + a.sub.lon + "|" + a.sub.rad + "|" + a.sub.max;
      let body = cache.get(sk);
      if (!body) { body = JSON.stringify({ push: "traffic", ...this.trafficBody(a.key, a.sub.lat, a.sub.lon, a.sub.rad, a.sub.max, a.member) }); cache.set(sk, body); }
      try { ws.send(body); } catch (e) {}
    }
  }
  trafficBody(key, lat, lon, rad, max, vm) {
    const { out, truncated } = this.trafficList(key, lat, lon, rad, Math.max(1, Math.min(MAX_TRAFFIC, Number(max) || MAX_TRAFFIC)), vm);
    const grp = new Map(); for (const c of this.clients.values()) if (c.pos) grp.set(c.pos.icao_address, !!c.member);
    const same = icao => grp.has(icao) ? grp.get(icao) === !!vm : !vm;
    const atc_messages = [...this.msgs.values()].filter(x => same(x.icao)).map(x => ({ id: x.id, icao_address: x.icao, text: x.text, kind: x.kind, urgent: !!x.urgent, status: x.status, at: x.at, freq: x.freq || "" }));
    const voice_clips = [...this.clips.values()].filter(v => v.dir === "up" && same(v.icao)).map(v => ({ id: v.id, icao_address: v.icao, callsign: v.callsign, ms: v.ms, at: v.at, freq: v.freq || "" }));
    return { aircraft: out, traffic: out, truncated, active_clients: [...this.clients.values()].filter(c => !!c.member === !!vm).length, atc_messages, crashes: this.crashList(vm), voice_clips };
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
    const key = this.towerKey(name), t = key && this.towers.get(key);
    if (!t) return null;
    const apt = t.apt || t.name;
    const a = t.atis || (t.atis = { letter: "A", runways: "", frequencies: "", remarks: "", at: Date.now(), sig: "" });
    const w = await this.weather(apt);
    if (w) {
      const sg = wxSig(w);
      if (sg !== a.sig) { if (a.sig) { a.letter = nextLetter(a.letter); a.at = Date.now(); } a.sig = sg; await this.ctx.storage.put("tower:" + key, t); }
    }
    return { name: apt, letter: a.letter, runways: a.runways, frequencies: a.frequencies, remarks: a.remarks, updated: a.at, weather: w, wx_ok: !!w };
  }

  voiceListening() {
    const now = Date.now();
    for (const v of this.listeners.values()) if (v.on && now - v.at <= VOICE_LISTEN_MS) return true;
    return false;
  }
  addClip(dir, target, d) {
    const audio = String(d.audio || "");
    const id = "v" + Date.now().toString(36) + (++this.msgSeq).toString(36);
    const ms = Math.max(0, Math.min(20_000, Number(d.ms) || 0));
    const pos = target.pos || {};
    this.clips.set(id, { id, dir, icao: pos.icao_address, callsign: normCallsign(target.plan.callsign ?? pos.callsign), audio, mime: String(d.mime || "audio/mp4").slice(0, 40), ms, freq: dir === "up" ? (pos.freq || "") : "", at: Date.now(), delivered: false });
    // everyone tuned to the same frequency hears it (pilots too); untuned = no relay
    const f = dir === "up" ? (pos.freq || "") : normFreq(d.freq), nowT = Date.now();
    if (f) for (const o of this.clients.values()) {
      const q = o.pos;
      if (!q || !!o.member !== !!target.member || q.icao_address === pos.icao_address || q.voice === false || q.freq !== f || nowT - o.seen > 15_000) continue;
      const id2 = id + "r" + (++this.msgSeq).toString(36);
      this.clips.set(id2, { id: id2, dir: "down", icao: q.icao_address, callsign: normCallsign(target.plan.callsign ?? pos.callsign), audio, mime: String(d.mime || "audio/mp4").slice(0, 40), ms, freq: "", at: nowT, delivered: false });
    }
    while (this.clips.size > VOICE_MAX_CLIPS) this.clips.delete(this.clips.keys().next().value);
    return id;
  }

  voicePeers(sender, meta) {
    const peers = [];
    for (const other of this.ctx.getWebSockets()) {
      if (other === sender) continue;
      const oa = other.deserializeAttachment() || {};
      if (!oa.key || !!oa.member !== !!meta.member) continue;
      const pilot = this.clients.get(oa.key);
      if (meta.direction === "up") {
        if (this.activeAtcHolder(oa.holder) && (!oa.member || oa.atc === "1" || oa.atc === "n" || this.creds.has(oa.atcRaw || ""))) peers.push(other);
        else if (pilot && pilot.pos && pilot.pos.freq === meta.freq && pilot.pos.voice !== false) peers.push(other);
      } else if (pilot && pilot.pos && pilot.pos.icao_address === meta.icao && pilot.pos.voice !== false && tunedTo(pilot.pos.freq, meta.freq)) peers.push(other);
    }
    return peers;
  }
  async handleVoiceStream(ws, a, d) {
    const action = d.voice_stream;
    if (action === "start") {
      const pilot = this.clients.get(a.key);
      const direction = d.direction === "down" ? "down" : "up";
      const holder = String(d.holder || "");
      if (direction === "up" && (!pilot || !pilot.pos || !pilot.pos.freq)) return;
      if (direction === "down" && (!this.activeAtcHolder(holder) || !d.icao_address)) return;
      const meta = direction === "up"
        ? { direction, member: !!a.member, freq: pilot.pos.freq, icao: pilot.pos.icao_address, callsign: normCallsign(pilot.plan.callsign ?? pilot.pos.callsign), sender: a.key }
        : { direction, member: !!a.member, freq: normFreq(d.freq), icao: String(d.icao_address).toUpperCase(), holder, callsign: this.ctlName({ headers: new Headers({ "X-Member": a.member ? "1" : "0", "X-Atc": a.atc || "n", "X-Atc-Raw": a.atcRaw || "", "X-Atc-Name": a.atcName || "" }) }), sender: a.key };
      const peers = [...new Map(this.voicePeers(ws, meta).map(x => [(x.deserializeAttachment() || {}).key, x])).values()];
      const id = String(d.id || ("s" + Date.now().toString(36) + (++this.msgSeq).toString(36))).slice(0, 80);
      const stream = { id, meta, peers: peers.map(x => (x.deserializeAttachment() || {}).key).filter(Boolean), chunks: [], bytes: 0, at: Date.now(), ended: false };
      this.voiceStreams.set(id, stream);
      const event = JSON.stringify({ push: "voice_stream", event: "start", id, meta: { direction, freq: meta.freq, icao: meta.icao, callsign: meta.callsign, sampleRate: Number(d.sampleRate) || 16000 } });
      for (const peer of peers) { try { peer.send(event); } catch (e) {} }
      return;
    }
    const id = String(d.id || "");
    const stream = this.voiceStreams.get(id);
    if (!stream || (action !== "replay" && stream.meta.sender !== a.key)) return;
    if (action === "chunk") {
      const chunk = String(d.data || "");
      if (!chunk || chunk.length > 12000 || stream.bytes + chunk.length > 1_500_000 || stream.ended) return;
      stream.chunks.push(chunk); stream.bytes += chunk.length; stream.at = Date.now();
      const event = JSON.stringify({ push: "voice_stream", event: "chunk", id, data: chunk, seq: stream.chunks.length - 1 });
      { const done = new Set(); for (const peer of this.ctx.getWebSockets().reverse()) { const pa = peer.deserializeAttachment() || {}; if (stream.peers.includes(pa.key) && !done.has(pa.key)) { done.add(pa.key); try { peer.send(event); } catch (e) {} } } }
      return;
    }
    if (action === "end") {
      stream.ended = true; stream.at = Date.now();
      const event = JSON.stringify({ push: "voice_stream", event: "end", id, chunks: stream.chunks.length, at: stream.at });
      { const done = new Set(); for (const peer of this.ctx.getWebSockets().reverse()) { const pa = peer.deserializeAttachment() || {}; if (stream.peers.includes(pa.key) && !done.has(pa.key)) { done.add(pa.key); try { peer.send(event); } catch (e) {} } } }
      this.latestVoiceByPeer.set(a.key, id);
      for (const peerKey of stream.peers) this.latestVoiceByPeer.set(peerKey, id);
      return;
    }
    if (action === "replay") {
      if (!stream.ended || (a.key !== stream.meta.sender && !stream.peers.includes(a.key))) return;
      try { ws.send(JSON.stringify({ push: "voice_stream", event: "replay_start", id, meta: stream.meta })); } catch (e) {}
      for (let i = 0; i < stream.chunks.length; i++) { try { ws.send(JSON.stringify({ push: "voice_stream", event: "chunk", id, data: stream.chunks[i], seq: i })); } catch (e) {} }
      try { ws.send(JSON.stringify({ push: "voice_stream", event: "replay_end", id, chunks: stream.chunks.length })); } catch (e) {}
    }
  }
  async webSocketMessage(ws, raw) {
    this.startPush();
    const a = ws.deserializeAttachment() || {};
    let d; try { d = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)); } catch (e) { return; }
    if (!d || typeof d !== "object") return;
    // Low-latency PTT transport: clients send short independently playable PCM16 chunks.
    // Events are relayed only to the sender's authorized radio peers; completed streams
    // remain briefly available for synchronized replay by those same peers.
    if (typeof d.voice_stream === "string") {
      await this.handleVoiceStream(ws, a, d);
      return;
    }
    if (d.sub !== undefined) {
      const s = d.sub, lat = Number(s && s.lat) || 0, lon = Number(s && s.lon) || 0, rad = Number(s && s.radius_miles) || 250;
      const max = Math.max(1, Math.min(MAX_TRAFFIC, Number(s && s.max) || MAX_TRAFFIC));
      a.sub = s ? { lat, lon, rad, max } : null; ws.serializeAttachment(a);
      if (a.sub) { try { ws.send(JSON.stringify({ push: "traffic", ...this.trafficBody(a.key, lat, lon, rad, max, a.member) })); } catch (e) {} }
      return;
    }
    const method = String(d.method || "GET").toUpperCase(), path = String(d.path || "");
    if (!path.startsWith("/api/") || path.startsWith("/api/debug") || !["GET", "PUT", "POST", "DELETE"].includes(method)) {
      try { ws.send(JSON.stringify({ id: d.id, status: 400, body: { error: "bad request" } })); } catch (e) {}
      return;
    }
    const init = { method, headers: { "X-API-Key": a.key, "Content-Type": "application/json", "X-Via": "ws", "X-Member": a.member ? "1" : "0", "X-Atc": a.atc || "n", "X-Atc-Raw": a.atcRaw || "", "X-Atc-Name": a.atcName || "", "X-IP": a.ip || "" } };
    if (method !== "GET" && method !== "DELETE" && d.body !== undefined) init.body = JSON.stringify(d.body);
    let status = 500, body = { error: "server error" };
    try {
      const r = await this.fetch(new Request("https://hub" + path, init));
      status = r.status; const t = await r.text(); try { body = JSON.parse(t); } catch (e) { body = t; }
    } catch (e) {}
    try { ws.send(JSON.stringify({ id: d.id, status, body })); } catch (e) {}
  }
  // "1" valid, "0" invalid/missing, "n" rule off. Env codes are decided at the edge; managed codes (this.creds) here, so revoking is immediate.
  atcState(request) {
    const f = request.headers.get("X-Atc") || "n";
    if (f === "1") return "1";
    const raw = request.headers.get("X-Atc-Raw") || "";
    if (request.headers.get("X-Member") === "1" && raw && this.creds.has(raw)) return "1";
    return f === "n" && (this.credOn || this.creds.size) ? "0" : f;
  }
  ctlName(request) {   // name of the credential holder (managed code label or ATC_CODES label), "" if none/invalid
    if (request.headers.get("X-Member") !== "1" || this.atcState(request) !== "1") return "";
    const c = this.creds.get(request.headers.get("X-Atc-Raw") || "");
    return c ? c.name : (request.headers.get("X-Atc-Name") || "");
  }
  noCred(request) { return request.headers.get("X-Member") === "1" && this.atcState(request) === "0"; }
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
      return json({ ground: [...this.gfx].map(([apt, v]) => ({ apt, age_s: Math.round((now - v.at) / 1000), src: v.g ? v.g.src || "" : "", nodes: v.g ? v.g.nodes.size : 0, edges: v.g ? v.g.edges.length : 0, stands: v.g ? v.g.stands.length : 0, runways: v.g ? v.g.runways.map(r => r.refs.join("/")) : [], error: v.g ? "" : v.err || "" })), taxi_diag: taxiDiag, towers: [...this.towers.values()], players: [...this.clients].map(([k, c]) => ({ key: mask(k), age_s: Math.round((now - c.seen) / 1000), position: c.pos || null, plan: c.plan || {} })) });
    }
    if (p !== "/api/stats" && p !== "/api/debug") { const k = (request.headers.get("X-Via") === "ws" ? "WS " : "") + m + " " + p; this.counts[k] = (this.counts[k] || 0) + 1; }
    if (m === "GET" && p === "/api/stats") {
      if (url.searchParams.get("reset") === "1") { this.counts = {}; this.since = Date.now(); }   // /api/stats?reset=1 starts the counters over
      const secs = Math.max(1, (Date.now() - this.since) / 1000);
      const per_minute = {};
      for (const [k, v] of Object.entries(this.counts)) per_minute[k] = Math.round((v / secs) * 600) / 10;
      return json({ seconds_since_start: Math.round(secs), counts: this.counts, per_minute, total_per_hour: Math.round(Object.values(this.counts).reduce((a, b) => a + b, 0) / secs * 3600) });
    }

    // controller-drawn taxi route: click a destination, the Worker finds the taxiway path; preview first, then send (line only, no message)
    if ((m === "PUT" || m === "POST" || m === "DELETE") && p === "/api/atc/taxiroute") {
      if (this.noCred(request)) return json({ error: "atc_credential" }, 403);
      const d = m === "DELETE" ? Object.fromEntries(url.searchParams) : await request.json().catch(() => ({}));
      const role = this.roleOf(String(d.holder || ""));
      if (!role) return json({ error: "division_required" }, 409);
      const icao = String(d.icao_address || "").toUpperCase();
      const target = [...this.clients.values()].find(c => c.pos && c.pos.icao_address === icao);
      if (!target || !!target.member !== (request.headers.get("X-Member") === "1")) return json({ error: "aircraft not found" }, 404);
      if (!tunedTo(target.pos.freq, normFreq(d.freq))) return json({ error: "not_tuned", freq: target.pos.freq, callsign: normCallsign(target.plan.callsign ?? target.pos.callsign) }, 409);
      if (m === "DELETE") { target.taxi = null; return json({ success: true }); }
      if (target.pos.phase === "air") return json({ error: "airborne" }, 409);
      const lat = Number(d.lat), lon = Number(d.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json({ error: "bad_point" }, 400);
      const pp = target.pos;
      let g; try { g = await Promise.race([this.graphFor(role.apt, pp.latitude, pp.longitude), new Promise(r => setTimeout(() => r(undefined), 4000))]); } catch (e) { g = null; }
      if (g === undefined) return json({ error: "graph_loading" }, 503);
      if (!g) return json({ error: "no_taxi_data" }, 404);
      const hdg = Number(pp.heading_true), gs0 = Number(pp.ground_speed), from = startFor(g, pp.latitude, pp.longitude, hdg, gs0, 500), to = nearest(g, lat, lon, 250, true);
      if (!from) return json({ error: "not_on_taxiway" }, 404);
      if (!to) return json({ error: "no_destination" }, 404);
      const path = from.id === to.id ? [] : taxiRoute(g, from.id, to.id, noUturn(g, from.id, pp.latitude, pp.longitude, hdg, gs0, null));
      if (!path) return json({ error: "no_path" }, 404);
      const pts = [[from.lat, from.lon]];
      for (const s of path) { const nd = g.nodes.get(s.to); if (nd) pts.push([nd.lat, nd.lon]); }
      let label = "STOP";
      const st = g.stands.filter(s => s.node === to.id || gDist(s.lat, s.lon, to.lat, to.lon) < 80).sort((a, b) => gDist(a.lat, a.lon, lat, lon) - gDist(b.lat, b.lon, lat, lon))[0];
      if (st) label = st.ref ? "GATE " + st.ref : "GATE";
      else for (const r of g.runways) { const id0 = (r.refs || []).find(x => { const h = holdNode(g, x); return h && h.id === to.id; }); if (id0) { label = "HOLD " + id0; break; } }
      const taxi = { kind: "ctl", apt: role.apt, points: pts.map(q => [Math.round(q[0] * 1e6) / 1e6, Math.round(q[1] * 1e6) / 1e6]), end: { lat: to.lat, lon: to.lon, label }, held: false, by: role.name || role.apt, at: Date.now(), until: Date.now() + 20 * 60_000 };
      if (!d.preview) target.taxi = taxi;
      return json({ success: true, preview: !!d.preview, ...taxi });
    }
    if ((m === "PUT" || m === "POST") && p === "/api/atc/squawk") {
      if (this.noCred(request)) return json({ error: "atc_credential" }, 403);
      const d = await request.json().catch(() => ({}));
      if (!this.activeAtcHolder(String(d.holder || ""))) return json({ error: "division_required" }, 409);
      const icao = String(d.icao_address || "").toUpperCase();
      const target = [...this.clients.values()].find(c => c.pos && c.pos.icao_address === icao);
      if (!target) return json({ error: "aircraft not found" }, 404);
      if (!tunedTo(target.pos.freq, normFreq(d.freq))) return json({ error: "not_tuned", freq: target.pos.freq, callsign: normCallsign(target.plan.callsign ?? target.pos.callsign) }, 409);
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
      if (this.noCred(request)) return json({ error: "atc_credential" }, 403);
      if (!this.activeAtcHolder(String(url.searchParams.get("holder") || ""))) return json({ error: "division_required" }, 409);
      const icao = String(url.searchParams.get("icao_address") || "").toUpperCase();
      const tg = [...this.clients.values()].find(c => c.pos && c.pos.icao_address === icao);
      if (tg && !tunedTo(tg.pos.freq, normFreq(url.searchParams.get("freq")))) return json({ error: "not_tuned", freq: tg.pos.freq, callsign: normCallsign(tg.plan.callsign ?? tg.pos.callsign) }, 409);
      for (const c of this.clients.values()) if (c.pos && c.pos.icao_address === icao) c.assigned = null;
      await this.ctx.storage.delete("sq:" + icao);
      return json({ success: true });
    }

    if ((m === "PUT" || m === "POST") && p === "/api/atc/message") {
      if (this.noCred(request)) return json({ error: "atc_credential" }, 403);
      const d = await request.json().catch(() => ({}));
      if (!this.activeAtcHolder(String(d.holder || ""))) return json({ error: "division_required" }, 409);
      const icao = String(d.icao_address || "").toUpperCase();
      const text = String(d.text || "").trim();
      const target = [...this.clients.values()].find(c => c.pos && c.pos.icao_address === icao);
      if (!target) return json({ error: "aircraft not found" }, 404);
      if (!text) return json({ error: "empty message" }, 400);
      if (!tunedTo(target.pos.freq, normFreq(d.freq))) return json({ error: "not_tuned", freq: target.pos.freq, callsign: normCallsign(target.plan.callsign ?? target.pos.callsign) }, 409);
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

    // ---- Push-to-talk voice clips (in memory, 5 min, base64 audio <= ~110 KB, max 20 s).
    if ((m === "PUT" || m === "POST") && p === "/api/voice/listen") {   // controller page: "I can hear voice" (renew every <= 30 s)
      const d = await request.json().catch(() => ({}));
      if (d.on === true) this.listeners.set(key, { on: true, at: Date.now() }); else this.listeners.delete(key);
      return json({ success: true, listening: this.voiceListening() });
    }
    if ((m === "PUT" || m === "POST") && p === "/api/voice/clip") {   // pilot -> controllers
      const d = await request.json().catch(() => ({}));
      const c = this.clients.get(key);
      if (!c || !c.pos) return json({ error: "start flying first" }, 404);
      if (!c.pos.freq) return json({ error: "frequency_required" }, 409);
      if (c.pos.voice === false) return json({ error: "voice_off" }, 409);
      if (!d.audio || typeof d.audio !== "string" || d.audio.length > VOICE_MAX_B64) return json({ error: "bad audio" }, 400);
      const now = Date.now();
      if (c.lastClip && now - c.lastClip < 1500) return json({ error: "too many clips" }, 429);
      const peers = c.pos.freq && [...this.clients.values()].some(o => o !== c && o.pos && o.pos.freq === c.pos.freq && o.pos.voice !== false);
      if (!this.voiceListening() && !peers) return json({ error: "no_listener" }, 409);
      c.lastClip = now;
      return json({ success: true, id: this.addClip("up", c, d) });
    }
    if (m === "GET" && p === "/api/voice/clip") {   // controller fetches the audio of a clip announced in traffic.voice_clips
      const v = this.clips.get(String(url.searchParams.get("id") || ""));
      if (!v || v.dir !== "up") return json({ error: "clip not found" }, 404);
      return json({ id: v.id, audio: v.audio, mime: v.mime, ms: v.ms, at: v.at, callsign: v.callsign });
    }
    if ((m === "PUT" || m === "POST") && p === "/api/atc/voice") {   // controller -> pilot
      if (this.noCred(request)) return json({ error: "atc_credential" }, 403);
      const d = await request.json().catch(() => ({}));
      if (!this.activeAtcHolder(String(d.holder || ""))) return json({ error: "division_required" }, 409);
      const icao = String(d.icao_address || "").toUpperCase();
      const target = [...this.clients.values()].find(c => c.pos && c.pos.icao_address === icao);
      if (!target) return json({ error: "aircraft not found" }, 404);
      if (target.pos.voice === false) return json({ error: "voice_off", callsign: normCallsign(target.plan.callsign ?? target.pos.callsign) }, 409);
      if (!d.audio || typeof d.audio !== "string" || d.audio.length > VOICE_MAX_B64) return json({ error: "bad audio" }, 400);
      if (!tunedTo(target.pos.freq, normFreq(d.freq))) return json({ error: "not_tuned", freq: target.pos.freq, callsign: normCallsign(target.plan.callsign ?? target.pos.callsign) }, 409);
      return json({ success: true, id: this.addClip("down", target, d) });
    }

    // Pilot -> controller free text. Stored like a request (status "request": never delivered back to the pilot).
    if ((m === "PUT" || m === "POST") && p === "/api/atc/chat") {
      const d = await request.json().catch(() => ({}));
      const text = String(d.text || "").trim().slice(0, 200);
      const c = this.clients.get(key);
      if (!c || !c.pos) return json({ error: "start flying first" }, 404);
      // Validate the payload before radio eligibility so malformed messages
      // consistently return 400; valid transmissions still require a tuned frequency.
      if (!text) return json({ error: "empty message" }, 400);
      if (!c.pos.freq) return json({ error: "frequency_required" }, 409);
      const now = Date.now();
      if (c.lastChat && now - c.lastChat < 2000) return json({ error: "too many messages" }, 429);
      c.lastChat = now;
      const msg = this.addMsg(c, text, "chat", { freq: c.pos.freq || "" });
      msg.status = "request";
      return json({ success: true, id: msg.id, mode: this.towers.size > 0 ? "controller" : "none" });
    }

    if ((m === "PUT" || m === "POST") && p === "/api/atc/request") {
      const d = await request.json().catch(() => ({}));
      const type = String(d.type || "");
      if (!REQ_TYPES.includes(type)) return json({ error: "type must be clearance, pushback, taxi, takeoff, land, mayday or mayday_cancel" }, 400);
      const c = this.clients.get(key);
      if (!c || !c.pos) return json({ error: "start flying first" }, 404);
      if (!c.pos.freq && !type.startsWith("mayday")) return json({ error: "frequency_required" }, 409);   // an emergency never waits for the radio
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
          if (k2 === key || !o.pos || now - o.seen > 15_000 || !!o.member !== !!c.member) continue;
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
      if (this.humanCovers(c, apt, type)) {
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
      } else if (type === "pushback") {
        text = ph.pushback(rwy); st.pushed = now;
      } else if (type === "taxi") {
        text = ph.taxi(rwy); st.gr.taxi = now + 30 * 60_000;
        if (/^[A-Z]{4}$/.test(apt) && rwy) {
          const r = await this.groundRoute(key, c, "out", apt, rwy, 3500);
          if (r) text = r.text;
          else if (r === undefined) this.groundRoute(key, c, "out", apt, rwy, 25_000).then(r2 => { if (r2) this.addMsg(c, r2.text, "auto", {}); }, () => {});   // download still running: route follows as a second message
        }
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
      if (this.noCred(request)) return json({ error: "atc_credential" }, 403);
      const d = await request.json().catch(() => ({}));
      const pn = parseTowerName(d.name);
      const lat = Number(d.latitude), lon = Number(d.longitude);
      if (!pn || !(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180))
        return json({ error: "need name (2-8 letters/digits, optional _DEL/_GND/_TWR/_APP/_CTR), latitude and longitude" }, 400);
      const name = pn.name, old = this.towers.get(name), now = Date.now();
      const holder = String(d.holder || "").slice(0, 40), who = holder || String(d.owner || "").slice(0, 40);
      const lk = this.lockedApt(who, now);
      if (lk && lk !== pn.apt) return json({ error: "locked_to_airport", airport: lk }, 409);
      const aptRec = this.towers.get(pn.apt);
      if (pn.pos !== "APT" && holder && aptRec && aptRec.pos === "APT" && aptRec.bans && aptRec.bans[holder]) return json({ error: "banned", airport: pn.apt }, 403);
      const freq = normFreq(d.freq);
      if (String(d.freq ?? "").trim() && !freq) return json({ error: "bad_freq" }, 400);
      if (!old && this.towers.size >= MAX_TOWERS) return json({ error: "too many towers" }, 409);
      // one airport per person (by browser id or IP); group-code members are unrestricted
      const ipt = request.headers.get("X-IP") || "";
      if (!old && request.headers.get("X-Member") !== "1" && !this.towerOf(pn.apt)) {
        const mine = this.airportOf(who, ipt);
        if (mine && mine !== pn.apt) return json({ error: "one_tower", airport: mine }, 409);
      }
      if (old?.member && request.headers.get("X-Member") !== "1") return json({ error: "member_tower" }, 403);
      // one controller per position: a live claim by someone else blocks (heartbeats keep it alive)
      if (old && old.holder && holder && old.holder !== holder && now - old.at <= POS_TTL_MS) return json({ error: "position_taken", position: pn.pos, airport: pn.apt }, 409);
      if (old && old.holder && !holder && now - old.at <= POS_TTL_MS) return json({ error: "position_taken", position: pn.pos, airport: pn.apt }, 409);
      // airport lead approval: with approval on, only the owner, members and approved people may take a NEW role
      if (holder && pn.pos !== "APT" && aptRec && aptRec.pos === "APT" && aptRec.approval && !(old && old.holder === holder)
          && aptRec.owner !== holder && request.headers.get("X-Member") !== "1" && !(aptRec.ok && aptRec.ok[holder])) {
        aptRec.pend = aptRec.pend || {};
        const isNew = !aptRec.pend[holder];
        aptRec.pend[holder] = { hid: hid(holder), pos: pn.pos, at: now, name: this.ctlName(request) || this.prof.get(key)?.nick || "" };
        if (isNew) await this.ctx.storage.put("tower:" + pn.apt, aptRec);
        return json({ error: "approval_required", airport: pn.apt, position: pn.pos }, 409);
      }
      if (holder && pn.pos !== "APT") {
        if (old && old.holder === holder) this.profAdd(key, "atc_s", Math.min(now - old.at, 60_000) / 1000, now);
        else {   // taking a NEW role: 2 minutes after the last one taken before another can be taken
          const lc = this.lastClaim.get(holder);
          if (lc && lc.name !== name && now - lc.at < ROLE_COOLDOWN_MS) return json({ error: "role_cooldown", remaining_s: Math.ceil((ROLE_COOLDOWN_MS - (now - lc.at)) / 1000) }, 409);
          this.lastClaim.set(holder, { name, at: now });
        }
      }
      const atis = old && old.atis;
      const t = { name, apt: pn.apt, pos: pn.pos, freq, holder: holder || undefined, ctl: holder ? (this.ctlName(request) || undefined) : undefined, nick: holder && request.headers.get("X-Member") !== "1" ? (this.prof.get(key)?.nick || undefined) : undefined, oip: (old && old.oip) || ipt || undefined, latitude: lat, longitude: lon, altitude_ft: Number(d.altitude_ft) || 0, at: now, member: request.headers.get("X-Member") === "1", atis };
      if (pn.pos === "APT") {   // the creator owns the airport (kept across re-PUTs); bans live on the airport record
        const ow = (old && old.owner) || String(d.owner || "").slice(0, 40);
        if (ow) t.owner = ow;
        if (old && old.bans) t.bans = old.bans;
        if (old && old.approval) t.approval = true;
        if (old && old.ok) t.ok = old.ok;
        if (old && old.pend) t.pend = old.pend;
      }
      this.towers.set(name, t);
      await this.ctx.storage.put("tower:" + name, t);
      return json({ success: true, callsign: "ATC_" + name, position: pn.pos, airport: pn.apt });
    }
    if (p === "/api/profile") {
      const pr = this.profGet(key);
      if (m === "PUT" || m === "POST") {
        const d = await request.json().catch(() => ({}));
        pr.nick = String(d.nick ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 20); pr.saved = Date.now();
        this.ctx.storage.put("prof:" + key, pr);
      }
      if (m === "GET" || m === "PUT" || m === "POST") return json({ nick: pr.nick, flight_s: Math.round(pr.flight_s), atc_s: Math.round(pr.atc_s), flights: pr.flights || 0 });
    }
    if (m === "DELETE" && p === "/api/atc/tower") {
      if (this.noCred(request)) return json({ error: "atc_credential" }, 403);
      const pn = parseTowerName(url.searchParams.get("name")), name = pn ? pn.name : String(url.searchParams.get("name") || "").trim().toUpperCase();
      if (this.towers.get(name)?.member && request.headers.get("X-Member") !== "1") return json({ error: "member_tower" }, 403);
      const cur = this.towers.get(name), hq = String(url.searchParams.get("holder") || "");
      const lk = pn ? this.lockedApt(hq, Date.now()) : null;
      if (lk && lk !== pn.apt) return json({ error: "locked_to_airport", airport: lk }, 409);
      if (pn && pn.pos === "APT" && cur && cur.bans && Object.keys(cur.bans).length && cur.owner !== hq && request.headers.get("X-Member") !== "1")
        return json({ error: "not_owner", airport: pn.apt }, 403);   // closing would wipe the bans
      if (pn && pn.pos === "APT") {   // closing the airport removes its roles, unless another controller is live on one
        const roles = [...this.towers.values()].filter(t => (t.apt || t.name) === pn.apt && t.name !== name);
        if (roles.some(t => t.holder && t.holder !== hq && Date.now() - t.at <= POS_TTL_MS)) return json({ error: "position_taken", airport: pn.apt }, 409);
        for (const t of roles) { this.towers.delete(t.name); await this.ctx.storage.delete("tower:" + t.name); }
      }
      if (cur && cur.holder && cur.holder !== hq && Date.now() - cur.at <= POS_TTL_MS) return json({ error: "position_taken", position: cur.pos, airport: cur.apt }, 409);
      this.towers.delete(name);
      await this.ctx.storage.delete("tower:" + name);
      return json({ success: true });
    }

    // ---- Airport lead: approval switch, approve / deny pending controllers
    if (m === "POST" && (p === "/api/atc/approval" || p === "/api/atc/approve")) {
      if (this.noCred(request)) return json({ error: "atc_credential" }, 403);
      const d = await request.json().catch(() => ({}));
      const g = this.leadGuard(request, d);
      if (g.err) return g.err;
      const { a, apt, now } = g;
      if (p === "/api/atc/approval") {
        a.approval = d.on === true;
        if (a.approval) {   // people already working a role here stay approved
          a.ok = a.ok || {};
          for (const t of this.towers.values()) if ((t.apt || t.name) === apt && t.holder && now - t.at <= POS_TTL_MS) a.ok[t.holder] = { hid: hid(t.holder), at: now };
        } else { delete a.pend; delete a.ok; }
      } else {
        const id = String(d.hid || ""), k = a.pend && Object.keys(a.pend).find(x => a.pend[x].hid === id);
        if (!k) return json({ error: "not pending" }, 404);
        if (d.allow !== false) { a.ok = a.ok || {}; a.ok[k] = { hid: id, at: now }; }
        delete a.pend[k];
      }
      if (a.pend && !Object.keys(a.pend).length) delete a.pend;
      await this.ctx.storage.put("tower:" + apt, a);
      return json({ success: true, approval: !!a.approval });
    }

    // ---- Handoff of an aircraft between roles of the same airport (target must accept)
    if (m === "POST" && (p === "/api/atc/handoff" || p === "/api/atc/handoff/accept")) {
      if (this.noCred(request)) return json({ error: "atc_credential" }, 403);
      const d = await request.json().catch(() => ({}));
      const icao = String(d.icao_address || "").toUpperCase(), now = Date.now();
      const target = [...this.clients.values()].find(c => c.pos && c.pos.icao_address === icao);
      const me = this.roleOf(String(d.holder || "").slice(0, 40), p === "/api/atc/handoff" ? String(d.from || "").toUpperCase() : target && target.handoff && target.handoff.to);
      if (!me) return json({ error: "division_required" }, 409);
      if (!target) return json({ error: "aircraft not found" }, 404);
      if (p === "/api/atc/handoff") {
        const to = String(d.to || "").toUpperCase();
        if (!POS_NAMES.includes(to) || to === me.pos) return json({ error: "bad_target" }, 400);
        const tr = this.towers.get(me.apt + "_" + to);
        if (!tr || !tr.holder || now - tr.at > POS_TTL_MS) return json({ error: "not_staffed", position: to }, 409);
        const h = this.handlerOf(target);
        if (h && h.name !== me.name) return json({ error: "handled_by", position: h.pos, ctl: h.ctl || h.nick || "" }, 409);
        target.handoff = { from: me.pos, to, apt: me.apt, at: now };
        return json({ success: true });
      }
      const ho = target.handoff;
      if (!ho || now - ho.at > HANDOFF_TTL_MS || ho.apt !== me.apt || ho.to !== me.pos) return json({ error: "no_handoff" }, 404);
      target.handoff = null;
      if (d.accept === false) return json({ success: true, accepted: false });
      target.handler = me.name;
      if (me.freq) this.addMsg(target, "Contact " + POS_SPOKEN[me.pos] + " " + me.freq, "msg", {});
      return json({ success: true, accepted: true });
    }

    if (m === "POST" && (p === "/api/atc/kick" || p === "/api/atc/unban")) {
      if (this.noCred(request)) return json({ error: "atc_credential" }, 403);
      const d = await request.json().catch(() => ({}));
      const apt = String(d.airport || "").trim().toUpperCase(), who = String(d.holder || "").slice(0, 40), now = Date.now();
      const a = this.towers.get(apt), member = request.headers.get("X-Member") === "1";
      if (!a || a.pos !== "APT") return json({ error: "no airport open with that code" }, 404);
      if (!member) {
        if (!who || a.owner !== who) return json({ error: "not_owner", airport: apt }, 403);
        const lk = this.lockedApt(who, now);
        if (lk && lk !== apt) return json({ error: "locked_to_airport", airport: lk }, 409);
      }
      a.bans = a.bans || {};
      if (p === "/api/atc/kick") {
        const pos = String(d.pos || "").toUpperCase(), role = POS_NAMES.includes(pos) && this.towers.get(apt + "_" + pos);
        if (!role) return json({ error: "no such role" }, 404);
        if (role.holder && role.holder !== a.owner) a.bans[role.holder] = { hid: hid(role.holder), pos, at: now };
        this.towers.delete(role.name); await this.ctx.storage.delete("tower:" + role.name);
      } else {
        const id = String(d.hid || ""), k = Object.keys(a.bans).find(x => a.bans[x].hid === id);
        if (!k) return json({ error: "not banned" }, 404);
        delete a.bans[k];
      }
      if (!Object.keys(a.bans).length) delete a.bans;
      await this.ctx.storage.put("tower:" + apt, a);
      return json({ success: true });
    }

    if (m === "GET" && p === "/api/atis") {
      const r = await this.atisFor(String(url.searchParams.get("name") || "").trim().toUpperCase());
      return r ? json(r) : json({ error: "no tower open at that airport" }, 404);
    }
    if ((m === "PUT" || m === "POST") && p === "/api/atc/atis") {
      if (this.noCred(request)) return json({ error: "atc_credential" }, 403);
      const d = await request.json().catch(() => ({}));
      const name = this.towerKey(String(d.name || "").trim().toUpperCase()), t = name && this.towers.get(name);
      if (!t) return json({ error: "no tower open at that airport" }, 404);
      if (t.member && request.headers.get("X-Member") !== "1") return json({ error: "member_tower" }, 403);
      const lk = this.lockedApt(String(d.holder || "").slice(0, 40), Date.now());
      if (lk && lk !== (t.apt || name)) return json({ error: "locked_to_airport", airport: lk }, 409);
      const a = t.atis || (t.atis = { letter: "A", runways: "", frequencies: "", remarks: "", at: Date.now(), sig: "" });
      const cl = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
      let change = d.bump === true;
      if (d.runways !== undefined) { const v = cl(d.runways, 40).toUpperCase(); if (v !== a.runways) { a.runways = v; change = true; } }
      if (d.frequencies !== undefined) { const v = cl(d.frequencies, 120); if (v !== a.frequencies) { a.frequencies = v; change = true; } }
      if (d.remarks !== undefined) { const v = cl(d.remarks, 200); if (v !== a.remarks) { a.remarks = v; change = true; } }
      if (change) { a.letter = nextLetter(a.letter); a.at = Date.now(); }
      await this.ctx.storage.put("tower:" + name, t);
      return json(await this.atisFor(t.apt || name));
    }

    if (p === "/api/manager/creds") {
      if (request.headers.get("X-Mgr") !== "1") return json({ error: "not_manager" }, 403);
      const q = new URL(request.url).searchParams;
      if (m === "GET") return json({ creds: [...this.creds].map(([code, v]) => ({ code, name: v.name, at: v.at })).sort((a, b) => b.at - a.at) });
      if (m === "PUT") {
        let d = {}; try { d = await request.json(); } catch (e) {}
        const name = String(d.name || "").trim().slice(0, 40);
        if (!name) return json({ error: "name_required" }, 400);
        if (this.creds.size >= 200) return json({ error: "too_many" }, 409);
        let code = newCred(); while (this.creds.has(code)) code = newCred();
        const v = { name, at: Date.now() }; this.creds.set(code, v); await this.ctx.storage.put("cred:" + code, v); if (!this.credOn) { this.credOn = true; await this.ctx.storage.put("credon", true); }
        return json({ success: true, code, name, at: v.at });
      }
      if (m === "DELETE") {
        const code = String(q.get("code") || "").trim();
        if (!this.creds.has(code)) return json({ error: "not_found" }, 404);
        this.creds.delete(code); await this.ctx.storage.delete("cred:" + code);
        return json({ success: true });
      }
    }

    if (m === "GET" && p === "/api/health")
      return json({ status: "ok", latest_android: LATEST.android, latest_pc: LATEST.pc, active_clients: this.clients.size, pilots: [...this.clients.values()].filter(c => c.pos).length, towers: this.towers.size, member: request.headers.get("X-Member") === "1", atc: this.atcState(request) === "1", atc_required: this.atcState(request) !== "n", mgr: request.headers.get("X-Mgr") === "1" });

    if (m === "GET" && p === "/api/traffic") {
      const q = url.searchParams;
      const lat = parseFloat(q.get("lat") ?? q.get("latitude") ?? "0") || 0;
      const lon = parseFloat(q.get("lon") ?? q.get("lng") ?? q.get("longitude") ?? "0") || 0;
      const rad = parseFloat(q.get("radius_miles") ?? q.get("radius") ?? "250") || 250;
      return json(this.trafficBody(key, lat, lon, rad, undefined, request.headers.get("X-Member") === "1"));
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
        phase: pick(d, "phase"), rwy_on: pick(d, "rwy_on"), on_rwy: pick(d, "on_rwy"), rwy_apt: pick(d, "rwy_apt"), arr_nm: pick(d, "arr_nm"), fq_dep: pick(d, "fq_dep"), fq_arr: pick(d, "fq_arr"), freq: normFreq(pick(d, "freq")),
        airplane_model: pick(d, "airplane_model"),
        airplane_livery: pick(d, "airplane_livery", "livery"),
        timestamp: pick(d, "timestamp") ?? Math.floor(Date.now() / 1000),
      };
      let c = this.clients.get(key);
      if (!c) {
        const rec = await this.ctx.storage.get("sq:" + icao);
        c = { plan: (await this.ctx.storage.get("plan:" + key)) || {}, route: (await this.ctx.storage.get("route:" + key)) || null,
              assigned: rec && Date.now() - rec.at < ASSIGN_TTL_MS ? rec : null };
      }
      if (pos.phase === "air" && c.seen) { const gap = Math.min(Date.now() - c.seen, 10_000) / 1000; this.profAdd(key, "flight_s", gap, Date.now()); c.airS = (c.airS || 0) + gap; }
      else if (c.pos && c.pos.phase === "air" && pos.phase && pos.phase !== "air" && (c.airS || 0) >= FLIGHT_MIN_AIR_S) {   // landed after a real flight
        const pf = this.profGet(key); pf.flights += 1; pf.saved = Date.now(); this.ctx.storage.put("prof:" + key, pf); c.airS = 0;
      }
      c.pos = pos; c.seen = Date.now(); c.member = request.headers.get("X-Member") === "1";
      if (pos.phase === "air" && c.taxi) c.taxi = null;
      const lg = pick(d, "lang"); if (lg === "pt" || lg === "en") c.lang = lg;
      const lf = Number(pos.landing_fpm);
      if (pos.landing_fpm !== undefined && Number.isFinite(lf) && lf <= HARD_LANDING_FPM) {
        // hard landing = crash: the plane vanishes from traffic, an X is marked, the pilot waits CRASH_TIMEOUT_MS
        const now = Date.now();
        const cr = { key, icao, callsign: normCallsign(c.plan.callsign ?? pos.callsign), latitude: lat, longitude: lon, member: !!c.member, landing_fpm: Math.round(lf), at: now, until: now + CRASH_TIMEOUT_MS };
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
      const sApt = up(c.pos.phase === "air" ? c.plan.arrival_airport : c.plan.departure_airport);
      const stations = sApt ? [...this.towers.values()].filter(t => t.freq && !!t.member === !!c.member && (t.apt || t.name) === sApt).map(t => ({ pos: t.pos || "TWR", freq: t.freq, airport: sApt })) : [];
      if (stations.length) reply.stations = stations;
      const voice = [];
      for (const v of this.clips.values()) if (v.dir === "down" && v.icao === icao && !v.delivered) { v.delivered = true; voice.push({ id: v.id, audio: v.audio, mime: v.mime, ms: v.ms, at: v.at }); }
      if (voice.length) reply.voice = voice;
      if (url.searchParams.get("traffic") === "1") {
        // our client: nearest 100 entries (whole planet) + crashes, so it needs no separate /api/traffic poll
        const t = this.trafficList(key, lat, lon, 13000, 100, c.member);
        reply.aircraft = t.out; reply.truncated = t.truncated; reply.crashes = this.crashList(c.member);
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
      c.plan = plan; c.seen = Date.now(); c.route = null;   // a new plan drops the old SimBrief route (the app sends the route right after)
      await this.ctx.storage.put("plan:" + key, plan);
      await this.ctx.storage.delete("route:" + key);
      this.clients.set(key, c);
      return json({ success: true });
    }

    // ---- SimBrief route: sent once by the app after the plan; never part of traffic replies. points: [[lat, lon, alt_ft, ident], ...]
    if ((m === "POST" || m === "PUT") && p === "/api/flightplan/route") {
      const blocked = this.crashBlock(key);
      if (blocked) return blocked;
      const d = await request.json().catch(() => ({}));
      if (!Array.isArray(d.points)) return json({ error: "points required" }, 400);
      const pts = [];
      for (const q of d.points.slice(0, ROUTE_MAX)) {
        if (!Array.isArray(q)) continue;
        const la = Number(q[0]), lo = Number(q[1]);
        if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) continue;
        const al = Number(q[2]);
        pts.push([Math.round(la * 1e5) / 1e5, Math.round(lo * 1e5) / 1e5, Number.isFinite(al) ? Math.round(al) : null, String(q[3] ?? "").slice(0, 12)]);
      }
      if (pts.length < 2) return json({ error: "need at least 2 valid points" }, 400);
      const route = { points: pts, route: typeof d.route === "string" ? d.route.slice(0, 1500) : "", at: Date.now() };
      const c = this.clients.get(key) || {};
      c.route = route; c.seen = Date.now();
      await this.ctx.storage.put("route:" + key, route);
      this.clients.set(key, c);
      return json({ success: true, points: pts.length });
    }
    if (m === "GET" && p === "/api/taxi") {
      const icao = String(url.searchParams.get("icao_address") || "").toUpperCase();
      const target = [...this.clients.values()].find(c => c.pos && c.pos.icao_address === icao);
      if (!target || !target.taxi || Date.now() >= target.taxi.until || (!!target.member !== (request.headers.get("X-Member") === "1"))) return json({ error: "no taxi route" }, 404);
      return json(target.taxi);
    }
    if (m === "GET" && p === "/api/route") {
      const icao = String(url.searchParams.get("icao_address") || "").toUpperCase();
      const target = [...this.clients.values()].find(c => c.pos && c.pos.icao_address === icao);
      if (!target || !target.route) return json({ error: "no route" }, 404);
      return json(target.route);
    }

    if (m === "DELETE" && p === "/api/position") {
      this.clients.delete(key);
      await this.ctx.storage.delete("route:" + key);
      return json({ success: true });
    }
    return json({ error: "not found" }, 404);
  }
}
