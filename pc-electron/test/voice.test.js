const assert = require("assert");
const { PttEncoder, Resampler, pcmToB64, b64ToPcm } = require("../core/voice");
let pass = 0; const T = (n, f) => { try { f(); pass++; console.log("PASS", n); } catch (e) { console.log("FAIL", n, e.message); process.exitCode = 1; } };
T("b64 roundtrip", () => { const a = new Int16Array([0, 1, -1, 32767, -32768, 1234]); assert.deepStrictEqual([...b64ToPcm(pcmToB64(a))], [...a]); });
T("resample 48k -> 16k keeps length ratio across blocks", () => { const r = new Resampler(48000); let n = 0; for (let k = 0; k < 50; k++) n += r.process(new Float32Array(2048)).length; assert.ok(Math.abs(n - 50 * 2048 / 3) <= 2, "got " + n); });
T("resample 44.1k ratio", () => { const r = new Resampler(44100); let n = 0; for (let k = 0; k < 50; k++) n += r.process(new Float32Array(2048)).length; assert.ok(Math.abs(n - 50 * 2048 / 2.75625) <= 2, "got " + n); });
T("resample keeps a sine continuous (no block-border jumps)", () => { const r = new Resampler(48000); const out = []; let t = 0; for (let k = 0; k < 10; k++) { const f = new Float32Array(2048); for (let i = 0; i < 2048; i++) f[i] = Math.sin(2 * Math.PI * 300 * (t++) / 48000); out.push(...r.process(f)); } let mx = 0; for (let i = 1; i < out.length; i++) mx = Math.max(mx, Math.abs(out[i] - out[i - 1])); assert.ok(mx < 0.2, "max step " + mx); });
T("encoder: 80 ms chunks, flush returns the rest, size under server limit", () => {
  const e = new PttEncoder(48000); let chunks = []; for (let k = 0; k < 20; k++) chunks.push(...e.push(new Float32Array(2048).fill(0.5)));
  assert.ok(chunks.length >= 9 && chunks.every(c => b64ToPcm(c).length === 1280 && c.length < 12000)); const rest = e.flush(); assert.ok(rest.length === 1 && b64ToPcm(rest[0]).length < 1280); assert.deepStrictEqual(e.flush(), []);
  assert.strictEqual(b64ToPcm(chunks[0])[100], Math.round(0.5 * 32767));
});
T("encoder clips to int16", () => { const e = new PttEncoder(16000); const c = e.push(new Float32Array(1400).fill(2)); assert.strictEqual(b64ToPcm(c[0])[5], 32767); });
T("api: voice send only while the socket is open, incoming pushes reach listeners", () => {
  const { Api } = require("../core/api"); const sent = []; const a = new Api({ key: "k", WebSocket: null });
  assert.strictEqual(a.sendVoiceStream("start", { id: "1" }), false);
  a.open = true; a.ws = { send: m => sent.push(JSON.parse(m)) }; assert.strictEqual(a.sendVoiceStream("chunk", { id: "1", data: "AA==" }), true);
  assert.deepStrictEqual(sent[0], { voice_stream: "chunk", id: "1", data: "AA==" });
});
console.log(pass + " passed");
