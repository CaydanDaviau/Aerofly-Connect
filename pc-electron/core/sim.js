// Sim links. TCP (Aerofly on another device: phone/iPad, same as the Android app) and UDP (Aerofly on this PC, ForeFlight XGPS/XATT).
const net = require("net"), dgram = require("dgram");

const F = { LAT: 0, LON: 1, ALT: 2, HDG: 3, HDG_MAG: 4, GS: 6, VS: 7 };   // lat|lon|alt ft|true hdg|mag hdg|IAS|GS|VS
const num = s => { const v = parseFloat(String(s).trim()); return Number.isFinite(v) && String(s).trim() !== "" ? v : null; };

// Same as Android SimLink.toPosition: '|'-separated line -> /api/position fields, or null.
function toPosition(raw) {
  const f = String(raw).split("|");
  const off = f.length && num(f[0]) === null ? 1 : 0;
  if (f.length - off <= F.LON) return null;
  const lat = num(f[off + F.LAT]), lon = num(f[off + F.LON]);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
  const o = { latitude: lat, longitude: lon };
  let v;
  if ((v = num(f[off + F.ALT] ?? "")) !== null) o.altitude_ft = Math.round(v);
  if ((v = num(f[off + F.HDG] ?? "")) !== null) o.heading_true = Math.round(v);
  if ((v = num(f[off + F.HDG_MAG] ?? "")) !== null) o.heading_mag = Math.round(v);
  if ((v = num(f[off + F.GS] ?? "")) !== null) o.ground_speed = Math.round(v);
  if ((v = num(f[off + F.VS] ?? "")) !== null) o.vertical_speed_ft_min = Math.round(v);
  return o;
}

class TcpLink {
  constructor(host) { this.host = host; this.sock = null; this.buf = ""; this.waiter = null; this.error = ""; }
  isOpen() { return !!this.sock && !this.sock.destroyed; }
  connect() {
    return new Promise((res, rej) => {
      const s = net.connect({ host: this.host, port: 58585 });
      const t = setTimeout(() => { s.destroy(); rej(new Error("timeout")); }, 3000);
      s.setNoDelay(true);
      s.on("connect", () => { clearTimeout(t); this.sock = s; this.buf = ""; res(); });
      s.on("data", d => {
        this.buf += d.toString("latin1");
        const i = this.buf.indexOf("\n");
        if (i >= 0 && this.waiter) { const line = this.buf.slice(0, i).replace(/\r$/, ""); this.buf = this.buf.slice(i + 1); const w = this.waiter; this.waiter = null; w.res(line); }
      });
      const dead = e => { clearTimeout(t); if (this.waiter) { const w = this.waiter; this.waiter = null; w.rej(e || new Error("closed")); } this.sock = null; rej(e || new Error("closed")); };
      s.on("error", dead); s.on("close", () => dead());
    });
  }
  async readLine() {
    if (!this.isOpen()) await this.connect();
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.waiter = null; this.close(); rej(new Error("no answer")); }, 2000);
      this.waiter = { res: l => { clearTimeout(t); res(l); }, rej: e => { clearTimeout(t); rej(e); } };
      this.sock.write("req_gmap_dat\n");
    });
  }
  close() { try { this.sock && this.sock.destroy(); } catch (e) {} this.sock = null; }
}

const M_TO_FT = 3.28084, MS_TO_KT = 1.943844;
class UdpLink {
  constructor() { this.lat = this.lon = this.alt = this.track = this.gs = 0; this.hdg = null; this.vs = 0; this.gpsAt = 0; this.lastAlt = null; this.lastAt = 0; this.error = ""; this.sock = null; }
  handle(t, now = Date.now() / 1000) {
    const f = String(t).trim().split(",");
    const n = x => { const v = parseFloat(x); return Number.isFinite(v) ? v : NaN; };
    if (t.startsWith("XGPS") && f.length >= 6) {
      const lo = n(f[1]), la = n(f[2]), alt = n(f[3]) * M_TO_FT;
      if (![lo, la, alt].every(Number.isFinite)) return;
      if (this.lastAlt === null) { this.lastAlt = alt; this.lastAt = now; }
      else if (now - this.lastAt >= 0.8) { this.vs = this.vs * 0.6 + ((alt - this.lastAlt) * 60 / (now - this.lastAt)) * 0.4; this.lastAlt = alt; this.lastAt = now; }
      this.lon = lo; this.lat = la; this.alt = alt; this.track = n(f[4]) || 0; this.gs = (n(f[5]) || 0) * MS_TO_KT; this.gpsAt = now;
    } else if (t.startsWith("XATT") && f.length >= 2) { const h = n(f[1]); if (Number.isFinite(h)) this.hdg = h; }
  }
  position(now = Date.now() / 1000) {
    if (now - this.gpsAt > 3 || Math.abs(this.lat) > 90 || Math.abs(this.lon) > 180 || (this.lat === 0 && this.lon === 0)) return null;
    return { latitude: this.lat, longitude: this.lon, altitude_ft: Math.round(this.alt), heading_true: Math.round(this.hdg === null ? this.track : this.hdg), ground_speed: Math.round(this.gs), vertical_speed_ft_min: Math.round(this.vs) };
  }
  start(port = 49002) {
    return new Promise(res => {
      const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
      s.on("message", m => this.handle(m.toString("ascii")));
      s.on("error", e => { this.error = e.code || e.message; res(); });
      s.bind(port, () => { this.sock = s; res(); });
    });
  }
  stop() { try { this.sock && this.sock.close(); } catch (e) {} this.sock = null; }
}

module.exports = { toPosition, TcpLink, UdpLink };
