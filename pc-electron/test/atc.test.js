const assert = require("assert");
const { AtcPanel, normFreq, stepFreq, trafficText, atisText } = require("../core/atc");
let pass = 0; const T = async (n, f) => { try { await f(); pass++; console.log("PASS", n); } catch (e) { console.log("FAIL", n, e.message); process.exitCode = 1; } };

function mk(reply) {
  const calls = []; let now = 1000;
  const api = { request: async (m, p, b) => { calls.push({ m, p, b }); return reply(m, p, b); } };
  let marked = 0; const phase = { runwayFor: t => (t === "land" ? "11R" : ""), markCleared: () => marked++ };
  const a = new AtcPanel({ api, phase, lang: () => "en", now: () => now });
  return { a, calls, adv: ms => { now += ms; }, marked: () => marked };
}
const ok = body => ({ code: 200, body: JSON.stringify(body || {}) });

(async () => {
  await T("normFreq", () => { assert.strictEqual(normFreq("1219"), "121.900"); assert.strictEqual(normFreq("121.9"), "121.900"); assert.strictEqual(normFreq("118.3"), "118.300"); assert.strictEqual(normFreq("117.9"), ""); assert.strictEqual(normFreq("137.0"), ""); assert.strictEqual(normFreq(""), ""); assert.strictEqual(normFreq("abc"), ""); });
  await T("stepFreq", () => { assert.strictEqual(stepFreq("121.900", 1), "121.925"); assert.strictEqual(stepFreq("121.900", -1), "121.875"); assert.strictEqual(stepFreq("", 1), "118.025"); assert.strictEqual(stepFreq("121.900", 1, 1000), "122.900"); assert.strictEqual(stepFreq("136.975", 1), "118.000"); assert.strictEqual(stepFreq("118.000", -1), "136.975"); });
  await T("traffic text", () => { assert.strictEqual(trafficText(false, 2, -300, -1), "TRAFFIC  2 o'clock · 300 ft below · descending"); assert.ok(/TRÁFEGO/.test(trafficText(true, 12, 0, 0)) && /mesma altitude/.test(trafficText(true, 12, 0, 0))); });
  await T("ingest messages, stations, TA, contact", () => {
    const { a } = mk(() => ok());
    const f = a.ingest({ messages: [{ id: "m1", text: "Taxi to runway 29L", contact: "Tower 118.700" }, { id: "m2", text: "Hold", urgent: true }], stations: [{ pos: "TWR", freq: "118.700" }], traffic_alerts: [{ clock: 2, rel_alt_ft: -300, vs_trend: -1 }] });
    assert.strictEqual(f.length, 2); assert.strictEqual(a.pending().id, "m1"); assert.strictEqual(a.contact, "Tower 118.700");
    assert.strictEqual(a.ingest({ messages: [{ id: "m1", text: "dup" }] }).length, 0);
    const v = a.view(["taxi"], "TWR=118.3;GND=121.9"); assert.strictEqual(v.more, 1); assert.ok(/TRAFFIC/.test(v.alert)); assert.deepStrictEqual(v.quick.map(q => q.pos), ["TWR", "GND"]);
  });
  await T("queue timeout 60 s, alert 10 s", () => { const { a, adv } = mk(() => ok()); a.ingest({ messages: [{ id: "m1", text: "x" }], traffic_alerts: [{ clock: 1 }] }); adv(11000); assert.strictEqual(a.view().alert, ""); assert.ok(a.pending()); adv(50000); assert.strictEqual(a.view().pending, null); });
  await T("reply wilco removes message", async () => {
    const { a, calls } = mk(() => ok({ success: true })); a.ingest({ messages: [{ id: "m1", text: "x" }] });
    assert.strictEqual(await a.reply("m1", "wilco"), true); assert.deepStrictEqual(calls[0], { m: "PUT", p: "/api/messages/reply", b: { id: "m1", reply: "wilco" } }); assert.strictEqual(a.pending(), null);
  });
  await T("reply failure keeps message", async () => { const { a } = mk(() => ({ code: 500, body: "{}" })); a.ingest({ messages: [{ id: "m1", text: "x" }] }); assert.strictEqual(await a.reply("m1", "unable"), false); assert.ok(a.pending()); assert.ok(a.view().status); });
  await T("request land: runway fallback, messages ingested", async () => {
    const { a, calls } = mk(() => ok({ mode: "auto", messages: [{ id: "r1", text: "Runway 11R, cleared to land" }] }));
    const fb = await a.request("land"); assert.deepStrictEqual(calls[0].b, { type: "land", lang: "en", runway: "11R" }); assert.strictEqual(fb, "Request sent"); assert.strictEqual(a.pending().id, "r1");
  });
  await T("request to controller / 429 / 404 / net", async () => {
    let r = ok({ mode: "controller" }); const { a } = mk(() => r);
    assert.strictEqual(await a.request("taxi"), "Request sent to the tower");
    r = { code: 429, body: "" }; assert.strictEqual(await a.request("taxi"), "Wait a moment");
    r = { code: 404, body: "" }; assert.strictEqual(await a.request("taxi"), "Not flying yet");
    const b = mk(() => { throw new Error("x"); }); assert.strictEqual(await b.a.request("taxi"), "No connection");
  });
  await T("clearance marks phase", async () => { const m = mk(() => ok()); await m.a.request("clearance"); assert.strictEqual(m.marked(), 1); });
  await T("emergency: two taps, cancel, ends at touchdown", async () => {
    const { a, calls, adv } = mk(() => ok());
    await a.emergencyTap(); assert.strictEqual(calls.length, 0); assert.ok(a.armed());
    adv(4000); assert.ok(!a.armed()); await a.emergencyTap(); assert.strictEqual(calls.length, 0);   // first tap again (timed out)
    adv(1000); await a.emergencyTap(); assert.strictEqual(calls[0].b.type, "mayday"); assert.ok(a.emergency);
    await a.emergencyTap(); assert.strictEqual(calls[1].b.type, "mayday_cancel"); assert.ok(!a.emergency);
    a.emergency = true; a.onPhase("air"); a.onPhase("ground"); assert.ok(!a.emergency);
    a.emergency = true; a.onPhase("ground"); assert.ok(a.emergency);   // never airborne: stays
  });
  await T("chat", async () => {
    let r = ok({ mode: "controller" }); const { a, calls } = mk(() => r);
    assert.strictEqual(await a.chat("  hello  "), "Sent to ATC"); assert.deepStrictEqual(calls[0], { m: "PUT", p: "/api/atc/chat", b: { text: "hello" } });
    r = ok({ mode: "none" }); assert.strictEqual(await a.chat("x"), "Sent, but no controller is online"); assert.strictEqual(await a.chat("   "), undefined); assert.strictEqual(calls.length, 2);
  });
  await T("atis ok / 404 / new letter", async () => {
    let r = ok({ letter: "B", updated: Date.UTC(2026, 10, 15, 14, 5), runways: "29R", weather: { wind: { dir: 270, spd: 12, gst: 20 }, vis_m: 9999, clouds: [{ cover: "BKN", base_ft: 3000 }], temp: 24, dew: 18, qnh: 1015 } });
    const { a, calls } = mk(() => r);
    let x = await a.fetchAtis("sbbr"); assert.strictEqual(calls[0].p, "/api/atis?name=SBBR"); assert.strictEqual(x.letter, "B");
    assert.ok(/ATIS B · 14:05Z/.test(x.text) && /Runways 29R/.test(x.text) && /Wind 270° 12 kt G20/.test(x.text) && /BKN 3000/.test(x.text) && /QNH 1015/.test(x.text));
    r = ok({ letter: "C", updated: 0, weather: null }); x = await a.fetchAtis("SBBR"); assert.ok(/^NEW INFORMATION C/.test(x.text) && /Weather not available/.test(x.text));
    r = { code: 404, body: "" }; x = await a.fetchAtis("SBGR"); assert.ok(/No ATIS/.test(x.text) && x.letter === "");
    x = await a.fetchAtis(""); assert.ok(/Set the departure/.test(x.text));
  });
  await T("setFreq", () => { const { a } = mk(() => ok()); assert.strictEqual(a.setFreq("1219"), "121.900"); assert.strictEqual(a.setFreq("junk"), ""); });
  await T("reset clears state", () => { const { a } = mk(() => ok()); a.ingest({ messages: [{ id: "m1", text: "x" }] }); a.emergency = true; a.reset(); assert.strictEqual(a.pending(), null); assert.ok(!a.emergency); });
  console.log(pass + " passed");
})();
