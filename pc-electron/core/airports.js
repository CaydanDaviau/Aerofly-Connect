// Runways + frequencies of the departure/arrival airport from OurAirports CSVs (cached 30 days in the config). Port of Android Airports.java.
const CACHE_MS = 30 * 24 * 3600 * 1000;
const RW_URLS = ["https://davidmegginson.github.io/ourairports-data/runways.csv", "https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/runways.csv"];
const FQ_URLS = ["https://davidmegginson.github.io/ourairports-data/airport-frequencies.csv", "https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/airport-frequencies.csv"];

function splitCsv(l) {
  const out = []; let f = "", q = false;
  for (let i = 0; i < l.length; i++) {
    const ch = l[i];
    if (q) { if (ch === '"') { if (l[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { out.push(f); f = ""; } else f += ch;
  }
  out.push(f); return out;
}
const num = s => { if (s === undefined || s === "") return NaN; const v = parseFloat(s); return Number.isFinite(v) ? v : NaN; };
const idx = (h, n) => h.indexOf(n);

function finish(a) {
  let sl = 0, sn = 0, se = 0, n = 0, ne = 0;
  for (const r of a.rwys) { sl += r.aLat + r.bLat; sn += r.aLon + r.bLon; n += 2; if (Number.isFinite(r.aElev)) { se += r.aElev; ne++; } if (Number.isFinite(r.bElev)) { se += r.bElev; ne++; } }
  if (n) { a.lat = sl / n; a.lon = sn / n; }
  a.elev = ne ? se / ne : NaN; return a;
}

// Returns { rwys, lat, lon, elev } or null when the file has no such airport.
function parseRunways(text, icao) {
  const lines = text.split("\n"); const hn = splitCsv(lines[0].replace(/\r$/, ""));
  const iAp = idx(hn, "airport_ident"), iCl = idx(hn, "closed"), iLeId = idx(hn, "le_ident"), iLeLa = idx(hn, "le_latitude_deg"), iLeLo = idx(hn, "le_longitude_deg"), iLeEl = idx(hn, "le_elevation_ft");
  const iHeId = idx(hn, "he_ident"), iHeLa = idx(hn, "he_latitude_deg"), iHeLo = idx(hn, "he_longitude_deg"), iHeEl = idx(hn, "he_elevation_ft");
  if (iAp < 0 || iLeLa < 0 || iHeLa < 0) return undefined;
  const needle = '"' + icao + '"', a = { rwys: [], lat: 0, lon: 0, elev: NaN };
  for (let i = 1; i < lines.length; i++) {
    const ln = lines[i]; if (!ln.includes(needle)) continue;
    const f = splitCsv(ln.replace(/\r$/, ""));
    if (f.length <= iHeLo || f[iAp] !== icao || (iCl >= 0 && f[iCl] === "1")) continue;
    const r = { a: f[iLeId], b: f[iHeId], aLat: num(f[iLeLa]), aLon: num(f[iLeLo]), bLat: num(f[iHeLa]), bLon: num(f[iHeLo]), aElev: iLeEl >= 0 ? num(f[iLeEl]) : NaN, bElev: iHeEl >= 0 ? num(f[iHeEl]) : NaN };
    if ([r.aLat, r.aLon, r.bLat, r.bLon].some(Number.isNaN)) continue;
    a.rwys.push(r);
  }
  return a.rwys.length ? finish(a) : null;
}

// "TWR=118.3;GND=121.9;APP=119.1"
function parseFreqs(text, icao) {
  const lines = text.split("\n"); const hn = splitCsv(lines[0].replace(/\r$/, ""));
  const iAp = idx(hn, "airport_ident"), iTy = idx(hn, "type"), iFr = idx(hn, "frequency_mhz");
  if (iAp < 0 || iTy < 0 || iFr < 0) return undefined;
  const needle = '"' + icao + '"', got = {};
  for (let i = 1; i < lines.length; i++) {
    const ln = lines[i]; if (!ln.includes(needle)) continue;
    const f = splitCsv(ln.replace(/\r$/, "")); if (f.length <= iFr || f[iAp] !== icao) continue;
    const t = f[iTy].toUpperCase();
    if (["TWR", "GND", "APP", "DEP"].includes(t) && !(t in got)) { const v = num(f[iFr]); if (Number.isFinite(v)) got[t] = String(v); }
  }
  return ["TWR", "GND", "APP", "DEP"].filter(t => t in got).map(t => t + "=" + got[t]).join(";");
}

class Airports {
  // o: { fetchFn(url) -> text, cache: { get(k), put(k, v) }, now() }
  constructor(o) { this.fetchFn = o.fetchFn; this.cache = o.cache; this.now = o.now || Date.now; this.mem = new Map(); this.fq = new Map(); this.failed = new Set(); }
  async download(urls, parse, icao) {
    for (const u of urls) { try { const r = parse(await this.fetchFn(u), icao); if (r !== undefined) return r; } catch (e) {} }
    return undefined;   // network/parse failure
  }
  async load(icao) {
    icao = String(icao || "").trim().toUpperCase(); if (!icao) return null;
    if (this.mem.has(icao)) return this.mem.get(icao);
    let a = null; const c = this.cache.get("apt_" + icao);
    if (c && this.now() - c.ts <= CACHE_MS && c.v) a = finish({ rwys: c.v, lat: 0, lon: 0 });
    if (!a && !this.failed.has(icao)) {
      const d = await this.download(RW_URLS, parseRunways, icao);
      if (d === undefined) this.failed.add(icao); else if (d) { a = d; this.cache.put("apt_" + icao, { ts: this.now(), v: d.rwys }); }
    }
    if (a) this.mem.set(icao, a); return a;
  }
  async freqs(icao) {
    icao = String(icao || "").trim().toUpperCase(); if (!icao) return "";
    if (this.fq.has(icao)) return this.fq.get(icao);
    const c = this.cache.get("fq_" + icao);
    if (c && this.now() - c.ts <= CACHE_MS) { this.fq.set(icao, c.v); return c.v; }
    if (this.failed.has("fq" + icao)) return "";
    const d = await this.download(FQ_URLS, parseFreqs, icao);
    if (d === undefined) { this.failed.add("fq" + icao); return ""; }
    this.cache.put("fq_" + icao, { ts: this.now(), v: d }); this.fq.set(icao, d); return d;
  }
}

module.exports = { Airports, parseRunways, parseFreqs, splitCsv };
