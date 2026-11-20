// Pilot-side ATC panel logic (port of the Android Overlay/PilotService/PipReply parts): message queue with Wilco/Unable,
// auto-ATC requests, two-tap Mayday, ATIS, frequency tuning, text chat, traffic advisory, controller status line.
// No UI and no Electron here: the overlay window renders view() and calls these methods.
const MSG_TIMEOUT_MS = 60000, ALERT_MS = 10000, ARM_MS = 3000, STATUS_MS = 6000;

// ---- frequency helpers (same rules as the Worker normFreq / Android overlay) ----
function normFreq(s) {
  s = String(s == null ? "" : s).trim();
  if (!s) return "";
  let khz;
  if (/^\d{3}\.\d{1,3}$/.test(s)) khz = Math.round(parseFloat(s) * 1000);
  else if (/^\d{4,6}$/.test(s)) khz = Math.round(parseFloat(s.slice(0, 3) + "." + s.slice(3)) * 1000);
  else return "";
  if (khz < 118000 || khz > 136975) return "";
  return (khz / 1000).toFixed(3);
}
// Next channel: kHz step (25 = tap, 1000 = hold jump), wraps inside 118.000-136.975.
function stepFreq(f, dir, khz = 25) {
  let k = f ? Math.round(parseFloat(f) * 1000) : 118000;
  k += dir * khz;
  if (k > 136975) k = 118000 + (k - 136975 - 25); if (k < 118000) k = 136975 - (118000 - k - 25);
  k = Math.round(k / 25) * 25;
  return (k / 1000).toFixed(3);
}

// ---- traffic advisory wording (port of TrafficText.shown) ----
function trafficText(pt, clock, dz, trend) {
  const c = Math.max(1, Math.min(12, clock | 0)), ft = Math.abs(Math.round(dz / 100)) * 100;
  let s = (pt ? "TRÁFEGO  " : "TRAFFIC  ") + c + (pt ? " horas" : " o'clock");
  if (ft >= 100) s += " · " + ft + (pt ? " pés " : " ft ") + (dz > 0 ? (pt ? "acima" : "above") : (pt ? "abaixo" : "below"));
  else s += " · " + (pt ? "mesma altitude" : "same altitude");
  if (trend > 0) s += " · " + (pt ? "subindo" : "climbing"); else if (trend < 0) s += " · " + (pt ? "descendo" : "descending");
  return s;
}

// RA wording (port of TrafficText.raShown)
function raText(pt, climb) { return pt ? (climb ? "RA  SUBA - suba agora" : "RA  DESÇA - desça agora") : (climb ? "RA  CLIMB - climb now" : "RA  DESCEND - descend now"); }

// ---- ATIS text (port of Atis.java, without the best-runway hint) ----
function zulu(ms) { const d = new Date(ms > 0 ? ms : Date.now()); return String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0") + "Z"; }
function wxText(w, pt) {
  const out = [], wd = w.wind;
  if (wd) out.push((pt ? "Vento " : "Wind ") + (wd.dir == null ? "VRB" : String(wd.dir).padStart(3, "0") + "°") + " " + (wd.spd | 0) + " kt" + (wd.gst != null ? " G" + wd.gst : ""));
  if (w.vis_m != null) { const v = w.vis_m; out.push("Vis " + (v >= 9999 ? "10 km+" : v >= 1000 ? (v / 1000).toFixed(1).replace(".0", "") + " km" : v + " m")); }
  if (w.cavok) out.push("CAVOK");
  else if ((w.clouds || []).length) out.push(w.clouds.map(c => c.cover + " " + c.base_ft).join("  "));
  let t = ""; if (w.temp != null) t += "Temp " + w.temp + (w.dew != null ? "/" + w.dew : "") + "°C  "; if (w.qnh != null) t += "QNH " + w.qnh;
  if (t.trim()) out.push(t.trim());
  return out.join("\n");
}
function atisText(j, pt) {
  const l = ["ATIS " + (j.letter || "A") + " · " + zulu(j.updated)];
  if (j.runways) l.push((pt ? "Pistas " : "Runways ") + j.runways);
  if (j.frequencies) l.push(j.frequencies);
  l.push(j.weather ? wxText(j.weather, pt) : (pt ? "Tempo indisponível" : "Weather not available"));
  if (j.remarks) l.push(j.remarks);
  return l.filter(Boolean).join("\n");
}

class AtcPanel {
  // o: { api, phase, lang(): "en"|"pt", onChange(), now() }
  constructor(o) {
    Object.assign(this, o); this.now = o.now || Date.now; this.onChange = o.onChange || (() => {});
    this.freq = ""; this.reset();
  }
  reset() {
    this.queue = []; this.contact = ""; this.stations = []; this.alert = null; this.emergency = false; this.wasAir = false;
    this.armUntil = 0; this.status = null; this.atis = { icao: "", letter: "", text: "" }; this.cleared = false;
  }
  t(en, pt) { return this.lang() === "pt" ? pt : en; }
  noFreq() { return this.t("Tune a frequency first", "Sintonize uma frequência primeiro"); }
  say(text) { this.status = { text, until: this.now() + STATUS_MS }; this.onChange(); }
  setFreq(f) { this.freq = normFreq(f); this.onChange(); return this.freq; }

  // Called after every successful position upload (and with the body of a request reply that carries messages).
  ingest(body) {
    let j; try { j = typeof body === "string" ? JSON.parse(body) : body; } catch (e) { return []; }
    if (!j) return [];
    const fresh = [], now = this.now();
    for (const m of j.messages || []) {
      if (!m || !m.id || !m.text || this.queue.some(q => q.id === m.id)) continue;
      const it = { id: String(m.id), text: String(m.text), urgent: !!m.urgent, at: now };
      this.queue.push(it); fresh.push(it);
      if (m.contact) this.contact = String(m.contact);
    }
    if (Array.isArray(j.stations)) this.stations = j.stations.filter(s => s && s.pos).map(s => ({ pos: String(s.pos), freq: String(s.freq || "") }));
    const ta = (j.traffic_alerts || [])[0], clr = (j.traffic_clear || [])[0];
    if (ta) this.alert = { text: ta.level === "ra" ? raText(this.lang() === "pt", ta.sense === "climb") : trafficText(this.lang() === "pt", ta.clock || 12, ta.rel_alt_ft || 0, ta.vs_trend || 0), until: now + ALERT_MS };
    else if (clr) this.alert = { text: this.lang() === "pt" ? "Livre de conflito." : "Clear of conflict.", until: now + ALERT_MS };
    if (fresh.length || ta || clr) this.onChange();
    return fresh;
  }

  // Phase name from Phase ("ground" | "runway" | "air"): a Mayday ends at touchdown (the server ends it too).
  onPhase(name) {
    const air = name === "air";
    if (this.emergency && this.wasAir && !air) { this.emergency = false; this.onChange(); }
    this.wasAir = air;
  }

  pending() { return this.queue[0] || null; }
  prune() { const n = this.now(); const k = this.queue.length; this.queue = this.queue.filter(q => n - q.at < MSG_TIMEOUT_MS); if (this.alert && n > this.alert.until) this.alert = null; if (this.status && n > this.status.until) this.status = null; return k !== this.queue.length; }

  async reply(id, which) {
    try {
      const r = await this.api.request("PUT", "/api/messages/reply", { id, reply: which });
      if (r.code < 400) { this.queue = this.queue.filter(q => q.id !== id); this.onChange(); return true; }
    } catch (e) {}
    this.say(this.t("Not sent, try again", "Não enviado, tente de novo")); return false;
  }

  async request(type, altitude) {
    let fb;
    try {
      const o = { type, lang: this.lang() };
      if (altitude) o.altitude = String(altitude);
      const rw = this.phase ? this.phase.runwayFor(type) : ""; if (rw) o.runway = rw;
      const r = await this.api.request("PUT", "/api/atc/request", o);
      if (r.code < 400) {
        this.ingest(r.body);
        if (type === "mayday") this.emergency = true; else if (type === "mayday_cancel") this.emergency = false;
        if (type === "clearance") { this.phase && this.phase.markCleared(); }
        if (type === "pushback") { this.phase && this.phase.markPushed(); }
        let mode = ""; try { mode = JSON.parse(r.body).mode; } catch (e) {}
        fb = mode === "controller" ? this.t("Request sent to the tower", "Pedido enviado à torre") : this.t("Request sent", "Pedido enviado");
      } else if (r.code === 429) fb = this.t("Wait a moment", "Aguarde um momento");
      else if (r.code === 404) fb = this.t("Not flying yet", "Voo ainda não iniciado");
      else if (r.code === 400 && /bad_altitude/.test(r.body)) fb = /"above"/.test(r.body) ? this.t("Altitude must be above you", "Altitude deve ser acima de você") : /"below"/.test(r.body) ? this.t("Altitude must be below you", "Altitude deve ser abaixo de você") : this.t("Invalid altitude (e.g. 100 or 5000)", "Altitude inválida (ex.: 100 ou 5000)");
      else if (r.code === 409 && /not_airborne/.test(r.body)) fb = this.t("Only available in flight", "Só disponível em voo");
      else if (r.code === 409 && /frequency_required/.test(r.body)) fb = this.noFreq();
      else fb = this.t("Request failed", "Falha no pedido");
    } catch (e) { fb = this.t("No connection", "Sem conexão"); }
    this.say(fb); return fb;
  }

  // Two taps: the first arms for 3 s, the second declares. While a Mayday is active the button cancels it.
  async emergencyTap() {
    const n = this.now();
    if (this.emergency) return this.request("mayday_cancel");
    if (n < this.armUntil) { this.armUntil = 0; return this.request("mayday"); }
    this.armUntil = n + ARM_MS; this.say(this.t("Tap Emergency again to declare Mayday", "Toque em Emergência de novo para declarar Mayday")); this.onChange();
  }
  armed() { return this.now() < this.armUntil; }

  async chat(text) {
    text = String(text || "").trim().slice(0, 200); if (!text) return;
    let fb;
    try {
      const r = await this.api.request("PUT", "/api/atc/chat", { text });
      if (r.code < 400) { let mode = ""; try { mode = JSON.parse(r.body).mode; } catch (e) {} fb = mode === "controller" ? this.t("Sent to ATC", "Enviado ao ATC") : this.t("Sent, but no controller is online", "Enviado, mas não há controlador online"); }
      else if (r.code === 429) fb = this.t("Wait a moment", "Aguarde um momento");
      else if (r.code === 404) fb = this.t("Not flying yet", "Voo ainda não iniciado");
      else if (r.code === 409 && /frequency_required/.test(r.body)) fb = this.noFreq();
      else fb = this.t("Not sent", "Não enviado");
    } catch (e) { fb = this.t("No connection", "Sem conexão"); }
    this.say(fb); return fb;
  }

  async fetchAtis(icao) {
    icao = String(icao || "").trim().toUpperCase(); const pt = this.lang() === "pt";
    if (!icao) { this.atis = { icao, letter: "", text: this.t("Set the departure and arrival airports first.", "Defina antes os aeroportos de partida e chegada.") }; this.onChange(); return this.atis; }
    let a = { icao, letter: "", text: "" };
    try {
      const r = await this.api.request("GET", "/api/atis?name=" + encodeURIComponent(icao));
      if (r.code === 404) a.text = pt ? "Sem ATIS: nenhuma torre aberta em " + icao + "." : "No ATIS: no tower is open at " + icao + ".";
      else if (r.code !== 200) a.text = (pt ? "ATIS indisponível (HTTP " : "ATIS unavailable (HTTP ") + r.code + ").";
      else { const j = JSON.parse(r.body); a.letter = j.letter || "A"; a.text = atisText(j, pt); }
    } catch (e) { a.text = pt ? "ATIS: sem conexão." : "ATIS: no connection."; }
    const old = this.atis; if (old.icao === icao && old.letter && a.letter && old.letter !== a.letter) a.text = (pt ? "NOVA INFORMAÇÃO " : "NEW INFORMATION ") + a.letter + "\n" + a.text;
    this.atis = a; this.onChange(); return a;
  }

  // Quick buttons for the FREQ row: staffed positions first (from the position reply), then OurAirports data for the airport.
  quick(fq) {
    const out = [], seen = new Set();
    for (const s of this.stations) { const f = normFreq(s.freq); if (f && !seen.has(s.pos)) { seen.add(s.pos); out.push({ pos: s.pos, freq: f }); } }
    for (const part of String(fq || "").split(";")) { const [p, f] = part.split("="); const n = normFreq(f); if (p && n && !seen.has(p)) { seen.add(p); out.push({ pos: p, freq: n }); } }
    return out;
  }

  // Snapshot for the overlay window. offers = phase buttons from Flight ("clearance","taxi","takeoff","land").
  view(offers, fq) {
    this.prune();
    const p = this.pending(), n = this.now();
    return {
      pending: p ? { id: p.id, text: p.text, urgent: p.urgent } : null, more: Math.max(0, this.queue.length - 1),
      offers: offers || [], emergency: this.emergency, armed: this.armed(),
      freq: this.freq, quick: this.quick(fq), contact: this.contact,
      alert: this.alert ? this.alert.text : "", status: this.status ? this.status.text : "",
      atis: this.atis, lang: this.lang(), t: n,
    };
  }
}

module.exports = { AtcPanel, normFreq, stepFreq, trafficText, raText, atisText, MSG_TIMEOUT_MS };
