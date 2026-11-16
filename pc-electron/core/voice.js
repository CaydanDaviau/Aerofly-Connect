// Live PTT audio helpers shared by the overlay window (loaded as a script) and node tests.
// Format on the wire = same as the radar web page: PCM16 mono, base64 chunks, sample rate announced in the "start" message.
(function (root) {
  const OUT_RATE = 16000, CHUNK = 1280;   // 80 ms per chunk, about 4.3 kB of base64 (server limit per chunk: 12000)

  function pcmToB64(a) {
    if (typeof Buffer !== "undefined") return Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString("base64");
    const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); let s = ""; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s);
  }
  function b64ToPcm(b) {
    let u;
    if (typeof Buffer !== "undefined") { const bf = Buffer.from(b, "base64"); u = new Uint8Array(bf.buffer.slice(bf.byteOffset, bf.byteOffset + bf.byteLength)); }
    else { const s = atob(b); u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); }
    return new Int16Array(u.buffer, 0, u.length >> 1);
  }

  // Linear resampler that keeps its position between blocks (no clicks at block borders).
  class Resampler {
    constructor(inRate) { this.step = inRate / OUT_RATE; this.pos = 0; this.prev = 0; }
    process(f) {
      const out = [], n = f.length; let p = this.pos;
      while (Math.floor(p) + 1 < n) {
        const i = Math.floor(p), a = i < 0 ? this.prev : f[i], b = f[i + 1];
        out.push(a + (b - a) * (p - i)); p += this.step;
      }
      this.pos = p - n; if (n) this.prev = f[n - 1];
      return out;
    }
  }

  // Float32 mic blocks in, base64 chunks of 80 ms out.
  class PttEncoder {
    constructor(inRate) { this.rs = new Resampler(inRate || OUT_RATE); this.buf = []; }
    static get rate() { return OUT_RATE; }
    push(f) {
      for (const v of this.rs.process(f)) this.buf.push(v);
      const out = [];
      while (this.buf.length >= CHUNK) out.push(this.take(CHUNK));
      return out;
    }
    flush() { return this.buf.length ? [this.take(this.buf.length)] : []; }
    take(n) {
      const a = new Int16Array(n), src = this.buf.splice(0, n);
      for (let i = 0; i < n; i++) a[i] = Math.max(-32768, Math.min(32767, Math.round(src[i] * 32767)));
      return pcmToB64(a);
    }
  }

  const api = { PttEncoder, Resampler, pcmToB64, b64ToPcm, OUT_RATE, CHUNK };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.AFVoice = api;
})(typeof window !== "undefined" ? window : globalThis);
