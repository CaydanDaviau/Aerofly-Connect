// Community backend for the Abflug Android client (v1.5.0) on Cloudflare Workers.
// All state lives in one Durable Object (in memory, TTL-based).
import ATC_HTML from "./atc.js";
const TTL_MS = 60_000;
const ASSIGN_TTL_MS = 12 * 3600_000;
const MAX_TRAFFIC = 500;

const pick = (d, ...names) => {
  for (const n of names) if (d && d[n] !== undefined && d[n] !== null && d[n] !== "") return d[n];
  return undefined;
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/atc" || url.pathname === "/atc/")
      return new Response(ATC_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
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
  constructor(ctx) { this.ctx = ctx; this.clients = new Map(); this.since = Date.now(); this.counts = {}; }

  purge() {
    const now = Date.now();
    for (const [k, c] of this.clients) if (now - c.seen > TTL_MS) this.clients.delete(k);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const key = (request.headers.get("X-API-Key") || "").trim();
    const m = request.method, p = url.pathname;
    this.purge();

    if (m === "GET" && p === "/api/debug") {
      const now = Date.now();
      const mask = k => k.slice(0, 2) + "***" + k.slice(-1);
      return json({ players: [...this.clients].map(([k, c]) => ({ key: mask(k), age_s: Math.round((now - c.seen) / 1000), position: c.pos || null, plan: c.plan || {} })) });
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
        const used = new Set();
        for (const c of this.clients.values()) {
          if (c.assigned) used.add(c.assigned.squawk);
          if (c.pos && c.pos.squawk) used.add(String(c.pos.squawk));
        }
        const start = Math.floor(Math.random() * 512);
        for (let i = 0; i < 512 && sq === null; i++) {
          const cand = (0o2000 + ((start + i) % 512)).toString(8).padStart(4, "0");
          if (!used.has(cand)) sq = cand;
        }
        if (sq === null) return json({ error: "no free squawk" }, 409);
      } else if (!/^[0-7]{4}$/.test(sq) || ["7500", "7600", "7700"].includes(sq)) {
        return json({ error: "invalid squawk (4 octal digits, not 7500/7600/7700)" }, 400);
      }
      const rec = { squawk: sq, at: Date.now() };
      target.assigned = rec;
      await this.ctx.storage.put("sq:" + icao, rec);
      return json({ success: true, squawk: sq });
    }
    if (m === "DELETE" && p === "/api/atc/squawk") {
      const icao = String(url.searchParams.get("icao_address") || "").toUpperCase();
      for (const c of this.clients.values()) if (c.pos && c.pos.icao_address === icao) c.assigned = null;
      await this.ctx.storage.delete("sq:" + icao);
      return json({ success: true });
    }

    if (m === "GET" && p === "/api/health")
      return json({ status: "ok", active_clients: this.clients.size });

    if (m === "GET" && p === "/api/traffic") {
      const q = url.searchParams;
      const lat = parseFloat(q.get("lat") ?? q.get("latitude") ?? "0") || 0;
      const lon = parseFloat(q.get("lon") ?? q.get("lng") ?? q.get("longitude") ?? "0") || 0;
      const rad = parseFloat(q.get("radius_miles") ?? q.get("radius") ?? "250") || 250;
      let out = [];
      for (const c of this.clients.values()) {
        const pos = c.pos;
        if (!pos) continue;
        const d = haversineMi(lat, lon, pos.latitude, pos.longitude);
        if (d <= rad) out.push({ ...pos, ...c.plan, assigned_squawk: c.assigned ? c.assigned.squawk : null, distance_miles: Math.round(d * 10) / 10 });
      }
      out.sort((a, b) => a.distance_miles - b.distance_miles);
      const truncated = out.length > MAX_TRAFFIC;
      out = out.slice(0, MAX_TRAFFIC);
      return json({ aircraft: out, traffic: out, truncated, active_clients: this.clients.size });
    }

    if ((m === "POST" || m === "PUT") && p === "/api/position") {
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
      this.clients.set(key, c);
      return json({ success: true });
    }

    if ((m === "POST" || m === "PUT") && p === "/api/flightplan") {
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
