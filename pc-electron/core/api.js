// Server access: one WebSocket during a flight (fewer billed requests), plain HTTP as fallback. Same protocol as the Android WsLink.
const SERVER = "https://aeroflytest.caydanphoenix14.workers.dev";

class Api {
  constructor({ key, group, WebSocket, fetchFn }) {
    this.key = key; this.group = group || ""; this.WS = WebSocket; this.fetch = fetchFn || fetch;
    this.ws = null; this.open = false; this.pending = new Map(); this.seq = 0; this.voiceListeners = new Set(); this.backoff = 2000; this.nextTry = 0; this.pingT = null; this.want = false;
  }
  setGroup(g) { this.group = g || ""; if (this.ws) this.closeWs(); }
  live() { return this.open; }

  async http(method, path, body) {
    const h = { "X-API-Key": this.key, "Content-Type": "application/json" };
    if (this.group) h["X-Group"] = this.group;
    const c = new AbortController(), t = setTimeout(() => c.abort(), 8000);
    try {
      const r = await this.fetch(SERVER + path, { method, headers: h, body: body == null ? undefined : (typeof body === "string" ? body : JSON.stringify(body)), signal: c.signal });
      return { code: r.status, body: await r.text() };
    } finally { clearTimeout(t); }
  }

  // Goes through the socket while it is live; on timeout or no socket plain HTTP.
  async request(method, path, body) {
    if (this.open) {
      try { return await this.wsCall(method, path, body); } catch (e) { if (e.message === "closed") this.closeWs(); }
    }
    return this.http(method, path, body);
  }

  wsCall(method, path, body) {
    return new Promise((res, rej) => {
      const id = String(++this.seq);
      const t = setTimeout(() => { this.pending.delete(id); this.closeWs(); rej(new Error("timeout")); }, 6000);
      this.pending.set(id, { res: r => { clearTimeout(t); res(r); }, rej: e => { clearTimeout(t); rej(e); } });
      let b = body; if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) {} }
      try { this.ws.send(JSON.stringify({ id, method, path, body: b == null ? undefined : b })); } catch (e) { this.pending.delete(id); clearTimeout(t); rej(new Error("closed")); }
    });
  }


  onVoice(fn) { this.voiceListeners.add(fn); return () => this.voiceListeners.delete(fn); }
  sendVoiceStream(action, payload = {}) {
    if (!this.open || !this.ws) return false;
    try { return this.ws.send(JSON.stringify({ voice_stream: action, ...payload }), err => {}), true; } catch (e) { return false; }
  }
  replayVoice(id) { return this.sendVoiceStream("replay", { id }); }

  // Called every loop turn: (re)connects with backoff 2-30 s.
  ensure(now = Date.now()) {
    this.want = true;
    if (this.ws || !this.WS || now < this.nextTry) return;
    const url = SERVER.replace(/^http/, "ws") + "/ws?key=" + encodeURIComponent(this.key) + (this.group ? "&group=" + encodeURIComponent(this.group) : "");
    let ws;
    try { ws = new this.WS(url); } catch (e) { this.nextTry = now + this.backoff; return; }
    this.ws = ws;
    ws.on("open", () => { if (this.ws !== ws) return; this.open = true; this.backoff = 2000; this.pingT = setInterval(() => { try { ws.ping(); } catch (e) {} }, 25000); });
    ws.on("message", d => {
      let j; try { j = JSON.parse(d.toString()); } catch (e) { return; }
      if (j && j.push === "voice_stream") { for (const fn of this.voiceListeners) { try { fn(j); } catch (e) {} } return; }
      if (j && j.id !== undefined && this.pending.has(String(j.id))) {
        const p = this.pending.get(String(j.id)); this.pending.delete(String(j.id));
        p.res({ code: j.status, body: typeof j.body === "string" ? j.body : JSON.stringify(j.body === undefined ? {} : j.body) });
      }
    });
    const dead = () => { if (this.ws === ws) this.drop(); };
    ws.on("close", dead); ws.on("error", dead);
  }
  drop() {
    clearInterval(this.pingT); this.pingT = null; this.open = false; const w = this.ws; this.ws = null;
    this.nextTry = Date.now() + this.backoff; this.backoff = Math.min(30000, this.backoff * 2);
    for (const p of this.pending.values()) p.rej(new Error("closed")); this.pending.clear();
    try { w && w.terminate && w.terminate(); } catch (e) {}
  }
  closeWs() { if (this.ws) this.drop(); }
  shutdown() { this.want = false; const w = this.ws; this.ws = null; this.open = false; clearInterval(this.pingT); for (const p of this.pending.values()) p.rej(new Error("closed")); this.pending.clear(); try { w && w.close(); } catch (e) {} }
}

module.exports = { Api, SERVER };
