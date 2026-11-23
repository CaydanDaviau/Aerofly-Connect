// Settings file (JSON in the user data folder). Pure functions + a tiny store, testable in node.
const fs = require("fs"), path = require("path"), crypto = require("crypto");

const DEFAULTS = {
  key: "", token: "", acctName: "", group: "", mode: "expert", lang: "", simSource: "udp", simIp: "", simbrief: "",
  flight: { callsign: "", dep: "", arr: "", deprwy: "", arrrwy: "", model: "", livery: "", cruise: "", route: "" },
  sbRoute: null, crashUntil: 0, cache: {}, overlay: true, autoAtc: true, ov: null, browser: false,
};

class Store {
  constructor(dir) { this.file = path.join(dir, "config.json"); this.data = this.load(); }
  load() {
    let c = {};
    try { c = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch (e) {}
    const d = { ...DEFAULTS, ...c, flight: { ...DEFAULTS.flight, ...(c.flight || {}) } };
    if (!d.key) { d.key = "rv" + crypto.randomBytes(8).toString("hex"); this.data = d; this.save(); }
    return d;
  }
  save() { try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.data, null, 1)); } catch (e) {} }
  set(patch) { Object.assign(this.data, patch); this.save(); }
  cacheGet(k) { return (this.data.cache || {})[k]; }
  cachePut(k, v) { this.data.cache = this.data.cache || {}; this.data.cache[k] = v; this.save(); }
  setFlight(patch) { Object.assign(this.data.flight, patch); this.save(); }
}

// Same checks as the Android SimHost: empty = not set, mobile 192.0.0.x refused, only full IPv4 or a host name.
function simHostProblem(h) {
  h = String(h || "").trim();
  if (!h) return "";
  if (/^192\.0\.0\./.test(h)) return "mobile";
  if (/^[0-9.]+$/.test(h)) {
    const p = h.split(".");
    if (p.length !== 4 || p.some(x => x === "" || Number(x) > 255)) return "invalid";
  }
  return "";
}

// Signed in: the account token replaces the device key everywhere.
const effKey = c => c.token || c.key;

module.exports = { effKey, Store, DEFAULTS, simHostProblem };
