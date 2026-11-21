// The flight loop: read the sim every 3 s, upload position (+ flight plan and SimBrief route once), keep status for the UI.
const { Phase } = require("./phase");
const { AtcPanel } = require("./atc");
const PERIOD_MS = 3000;

class Flight {
  // opts: { api, store, makeLink(), onState(state), now(), airports (core/airports.js instance, optional) }
  constructor(o) { Object.assign(this, o); this.stop_ = false; this.phase = new Phase(); this.fqDep = ""; this.fqArr = "";
    this.atc = new AtcPanel({ api: o.api, phase: this.phase, lang: () => (this.store.data.lang || "en"), onChange: () => this.push() }); this.s = this.blank(); }
  blank() { return { running: false, sim: "", server: "", uploads: 0, failed: 0, raw: "", messages: [], atc: null, crash: null, phase: "", eta: -1, landFpm: null, offers: [] }; }
  state() { return this.s; }
  fq() { return this.phase.phaseName === "air" ? (this.fqArr || this.fqDep) : (this.fqDep || this.fqArr); }
  push() {
    if (this.s.running) { const f = this.store.data.flight; this.s.atc = { ...this.atc.view(this.s.offers, this.fq()), dep: f.dep.trim().toUpperCase(), arr: f.arr.trim().toUpperCase(), air: this.phase.phaseName === "air" }; } else this.s.atc = null; this.onState && this.onState({ ...this.s }); }

  async start() {
    const cfg = this.store.data;
    if (cfg.crashUntil > Date.now()) return { error: "crash", left: cfg.crashUntil - Date.now() };
    this.stop_ = false; this.s = this.blank(); this.s.running = true; this.push();
    this.phase.reset(); this.atc.reset(); this.fqDep = ""; this.fqArr = ""; this.loadAirports();
    this.link = this.makeLink();
    if (this.link.start) await this.link.start();
    this.loop();
    return {};
  }

  // Background: runway + frequency data for the dep/arr fields (a few seconds on first use, then cached). Offline = no data, rules fall back to speed/altitude.
  async loadAirports() {
    const f = this.store.data.flight, ap = this.airports, ph = this.phase;
    const dep = f.dep.trim().toUpperCase(), arr = f.arr.trim().toUpperCase();
    ph.setIcao(dep, arr);
    if (!ap || (!dep && !arr)) return;
    try {
      const d = dep ? await ap.load(dep) : null; if (this.stop_) return; ph.setAirports(d, null);
      const a = arr ? await ap.load(arr) : null; if (this.stop_) return; ph.setAirports(d, a);
      this.fqDep = dep ? await ap.freqs(dep) : ""; this.fqArr = arr ? await ap.freqs(arr) : "";
    } catch (e) {}
  }

  async stop() {
    this.stop_ = true; this.s.running = false;
    try { this.link && (this.link.stop ? this.link.stop() : this.link.close()); } catch (e) {}
    try { await this.api.http("DELETE", "/api/position"); } catch (e) {}
    this.api.shutdown(); this.s.sim = ""; this.s.server = ""; this.push();
  }

  // One turn: returns the position or null. (Exposed for tests.)
  async readSim() {
    const l = this.link, src = this.store.data.simSource;
    if (src === "udp") {
      const p = l.position();
      this.s.sim = p ? "connected (UDP 49002)" : (l.error ? "UDP 49002 unavailable (" + l.error + ")" : "waiting for Aerofly on UDP 49002");
      if (p) this.s.raw = JSON.stringify(p);
      return p;
    }
    try {
      const raw = await l.readLine(); this.s.raw = raw;
      const p = require("./sim").toPosition(raw);
      this.s.sim = (p ? "connected" : "connected, no valid position yet") + " @ " + this.store.data.simIp;
      return p;
    } catch (e) { l.close(); this.s.sim = "no sim (" + (e.message || "error") + ") @ " + this.store.data.simIp; return null; }
  }

  async turn() {
    const cfg = this.store.data, f = cfg.flight, pos = await this.readSim();
    if (!pos) return;
    this.api.ensure();
    const put = (o, k, v) => { v = String(v || "").trim(); if (v) o[k] = v; };
    put(pos, "airplane_model", f.model); put(pos, "airplane_livery", f.livery);
    pos.auto_atc = cfg.autoAtc !== false;
    pos.voice = true;   // live PTT: the overlay plays incoming radio and can transmit
    pos.lang = cfg.lang || "en";
    if (this.atc.freq) pos.freq = this.atc.freq;
    const now = Date.now();
    this.phase.update(pos.latitude, pos.longitude, pos.altitude_ft || 0, pos.ground_speed || 0, pos.heading_true || 0, pos.vertical_speed_ft_min || 0, now);
    Object.assign(pos, this.phase.fields(now));
    if (this.fqDep) pos.fq_dep = this.fqDep;
    if (this.fqArr) pos.fq_arr = this.fqArr;
    const ph = this.phase;
    this.s.phase = ph.phaseName; this.s.eta = ph.etaMin; this.s.landFpm = ph.landingShown(now) ? ph.landFpm : null;
    this.atc.onPhase(ph.phaseName);
    this.s.own = { lat: pos.latitude, lon: pos.longitude, hdg: pos.heading_true || 0, gs: pos.ground_speed || 0, alt: pos.altitude_ft || 0, callsign: String(f.callsign || "").toUpperCase(), eta: ph.etaMin, fpm: ph.landingShown(now) ? ph.landFpm : null };
    this.s.offers = [ph.clearance && "clearance", ph.pushback && "pushback", ph.taxi && "taxi", ph.takeoff && "takeoff", ph.land && "land"].filter(Boolean);
    try {
      if (!this.planSent) {
        const plan = {};
        put(plan, "callsign", f.callsign.toUpperCase()); put(plan, "departure_airport", f.dep.toUpperCase()); put(plan, "arrival_airport", f.arr.toUpperCase());
        put(plan, "departure_runway", f.deprwy.toUpperCase()); put(plan, "arrival_runway", f.arrrwy.toUpperCase());
        put(plan, "cruise_altitude", f.cruise); put(plan, "flightplan_route", f.route);
        this.planSent = (await this.api.request("PUT", "/api/flightplan", plan)).code < 400;
      }
      if (this.planSent && !this.routeSent) {
        const sb = cfg.sbRoute;
        if (!sb || sb.dep !== f.dep.trim().toUpperCase() || sb.arr !== f.arr.trim().toUpperCase() || (sb.points || []).length < 2) this.routeSent = true;
        else this.routeSent = (await this.api.request("PUT", "/api/flightplan/route", { points: sb.points, route: sb.route || "" })).code < 400;
      }
      const r = await this.api.request("PUT", "/api/position", pos);
      if (r.code === 423) {
        let j = {}; try { j = JSON.parse(r.body); } catch (e) {}
        const left = Math.max(0, Number(j.remaining_s) || 300) * 1000;
        this.store.set({ crashUntil: Date.now() + left });
        this.s.crash = { until: Date.now() + left, fpm: j.landing_fpm };
        this.s.server = "crashed"; await this.stop(); return "crash";
      }
      if (r.code < 400) { this.s.uploads++; this.s.server = "OK (" + (this.api.live() ? "socket" : "HTTP") + ")"; this.messages(r.body); this.atc.ingest(r.body); }
      else { this.s.failed++; this.s.server = "HTTP " + r.code; }
    } catch (e) { this.s.failed++; this.s.server = "error: " + (e.message || "?"); }
  }

  messages(body) {
    let j; try { j = JSON.parse(body); } catch (e) { return; }
    for (const m of j.messages || []) { this.s.messages.unshift({ text: m.text, urgent: !!m.urgent, at: Date.now() }); }
    this.s.messages = this.s.messages.slice(0, 20);
  }

  async loop() {
    this.planSent = false; this.routeSent = false;
    while (!this.stop_) {
      const t0 = Date.now();
      let r; try { r = await this.turn(); } catch (e) { this.s.server = "error: " + e.message; }
      this.push();
      if (r === "crash") return;
      const wait = PERIOD_MS - (Date.now() - t0);
      if (wait > 0) await new Promise(res => setTimeout(res, wait));
    }
  }
}

module.exports = { Flight, PERIOD_MS };
