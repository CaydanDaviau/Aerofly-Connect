const assert = require("assert");
const { Phase } = require("../core/phase");
const { Airports, parseRunways, parseFreqs } = require("../core/airports");
const { Flight } = require("../core/flight");
let n = 0; const T = async (name, f) => { try { await f(); n++; console.log("PASS", name); } catch (e) { console.log("FAIL", name, e.message); process.exitCode = 1; } };

// Runway 11R/29L at an airport near -15.87,-47.92 (east-west), elevation 3500 ft
const HDR = '"id","airport_ref","airport_ident","length_ft","width_ft","surface","lighted","closed","le_ident","le_latitude_deg","le_longitude_deg","le_elevation_ft","le_heading_degT","le_displaced_threshold_ft","he_ident","he_latitude_deg","he_longitude_deg","he_elevation_ft","he_heading_degT","he_displaced_threshold_ft"';
const CSV = HDR + '\n"1","1","SBXX","10000","150","ASP","1","0","11R","-15.870","-47.940","3500","90","","29L","-15.870","-47.900","3500","270",""\n"2","2","SBYY","8000","150","ASP","1","1","09","1","1","10","90","","27","1","2","10","270",""\n';
const FQ = '"id","airport_ref","airport_ident","type","description","frequency_mhz"\n"1","1","SBXX","TWR","Tower","118.3"\n"2","1","SBXX","GND","Ground","121.9"\n"3","1","SBXX","ATIS","x","127.0"\n"4","1","SBXX","TWR","dup","119.0"\n';

(async () => {
  await T("parse runways (closed + other airport ignored)", () => { const a = parseRunways(CSV, "SBXX"); assert.strictEqual(a.rwys.length, 1); assert.strictEqual(a.rwys[0].a, "11R"); assert.strictEqual(a.elev, 3500); assert.ok(Math.abs(a.lon + 47.92) < 1e-9); assert.strictEqual(parseRunways(CSV, "SBYY"), null); assert.strictEqual(parseRunways("x,y\n", "SBXX"), undefined); });
  await T("parse freqs", () => assert.strictEqual(parseFreqs(FQ, "SBXX"), "TWR=118.3;GND=121.9"));
  await T("airports cache, retry rules", async () => {
    let hits = 0, store = {}, t = 1000; const cache = { get: k => store[k], put: (k, v) => { store[k] = v; } };
    const ap = new Airports({ fetchFn: async () => { hits++; return CSV; }, cache, now: () => t });
    const a = await ap.load("sbxx"); assert.strictEqual(a.rwys.length, 1); assert.strictEqual(hits, 1);
    const ap2 = new Airports({ fetchFn: async () => { hits++; return CSV; }, cache, now: () => t + 1000 }); await ap2.load("SBXX"); assert.strictEqual(hits, 1, "from cache");
    const ap3 = new Airports({ fetchFn: async () => { hits++; return CSV; }, cache, now: () => t + 31 * 24 * 3600 * 1000 }); await ap3.load("SBXX"); assert.strictEqual(hits, 2, "expired cache");
    let fails = 0; const off = new Airports({ fetchFn: async () => { fails++; throw new Error("offline"); }, cache: { get: () => undefined, put() {} } });
    assert.strictEqual(await off.load("SBXX"), null); const f1 = fails; assert.strictEqual(await off.load("SBXX"), null); assert.strictEqual(fails, f1, "one attempt per run");
    assert.strictEqual(await new Airports({ fetchFn: async () => FQ, cache: { get: () => undefined, put() {} } }).freqs("SBXX"), "TWR=118.3;GND=121.9"); });

  const dep = parseRunways(CSV, "SBXX"), arr = dep;
  const mk = () => { const p = new Phase(); p.setIcao("SBXX", "SBXX"); p.setAirports(dep, null); return p; };
  await T("stopped near airport: taxi + clearance, no takeoff", () => { const p = mk(); p.update(-15.860, -47.920, 3500, 0, 0, 0, 1000); assert.ok(p.taxi && p.clearance && !p.takeoff && !p.land); assert.strictEqual(p.phaseName, "ground"); });
  await T("lined up on 29L (heading 270)", () => { const p = mk(); p.update(-15.870, -47.905, 3500, 0, 270, 0, 1000); assert.ok(p.takeoff && !p.taxi); assert.strictEqual(p.onRwy, "29L"); assert.strictEqual(p.rwyOn, "11R/29L"); assert.strictEqual(p.phaseName, "runway"); assert.strictEqual(p.runwayFor("takeoff"), "29L"); assert.strictEqual(p.fields(0).on_rwy, "29L"); });
  await T("across the runway is not lined up", () => { const p = mk(); p.update(-15.870, -47.920, 3500, 0, 0, 0, 1000); assert.ok(!p.takeoff); });
  await T("airborne latch, terminal, no taxi", () => { const p = mk(); p.update(-15.870, -47.905, 3500, 0, 270, 0, 1000); p.update(-15.870, -47.93, 3900, 150, 270, 1500, 4000); assert.strictEqual(p.phaseName, "air"); assert.ok(!p.taxi && !p.takeoff && p.land === true); assert.ok(p.terminal); assert.strictEqual(p.fields(4000).phase, "air"); });
  await T("eta + arr_nm + landing rate", () => {
    const p = new Phase(); p.setIcao("SBXX", "SBXX"); p.setAirports(null, arr);
    p.update(-15.870, -47.40, 6000, 240, 270, 0, 1000); assert.strictEqual(p.airborne, true); assert.ok(p.etaMin > 0 && p.arrNm > 20);
    p.update(-15.870, -47.93, 3600, 140, 270, -650, 2000);   // 100 ft AGL, descending
    p.update(-15.870, -47.925, 3520, 140, 270, -620, 5000);  // 20 ft AGL: touchdown
    assert.strictEqual(p.landFpm, -620); assert.ok(p.landingShown(6000) && !p.landingShown(5000 + 120001)); assert.strictEqual(p.fields(6000).landing_fpm, -620); assert.strictEqual(p.airborne, false);
    p.update(-15.870, -47.92, 3500, 100, 270, 0, 8000); assert.strictEqual(p.phaseName, "runway"); });
  await T("runwayFor landing picks aligned end", () => { const p = new Phase(); p.setAirports(null, arr); p.update(-15.870, -47.99, 5000, 150, 90, -600, 1000); assert.strictEqual(p.runwayFor("land"), "11R"); p.update(-15.870, -47.85, 5000, 150, 270, -600, 4000); assert.strictEqual(p.runwayFor("land"), "29L"); assert.strictEqual(p.runwayFor("taxi"), ""); });
  await T("no airport data: stopped => taxi and takeoff offered", () => { const p = new Phase(); p.update(1, 1, 100, 0, 0, 0, 1000); assert.ok(p.taxi && p.takeoff); });
  await T("slow for 20 s resets airborne", () => { const p = new Phase(); p.update(1, 1, 100, 150, 0, 0, 1000); assert.ok(p.airborne); p.update(1, 1, 100, 5, 0, 0, 2000); p.update(1, 1, 100, 5, 0, 0, 23000); assert.ok(!p.airborne); });

  await T("flight upload carries phase fields + frequencies", async () => {
    const calls = []; const api = { ensure() {}, live: () => false, shutdown() {}, request: async (m, path, body) => { calls.push({ m, path, body }); return { code: 200, body: "{}" }; }, http: async () => ({}) };
    const store = { data: { simSource: "tcp", simIp: "1.1.1.1", lang: "en", flight: { callsign: "A1", dep: "SBXX", arr: "SBXX", deprwy: "", arrrwy: "", model: "", livery: "", cruise: "", route: "" }, sbRoute: null, crashUntil: 0 }, set() {}, setFlight() {} };
    const airports = { load: async () => dep, freqs: async () => "TWR=118.3" };
    const f = new Flight({ api, store, airports, makeLink: () => ({ readLine: async () => "-15.870|-47.905|3500|270|270|0|0|0", close() {} }) });
    f.link = f.makeLink(); f.planSent = true; f.routeSent = true; await f.loadAirports();
    await f.turn(); const pos = calls.find(c => c.path === "/api/position").body;
    assert.strictEqual(pos.phase, "runway"); assert.strictEqual(pos.on_rwy, "29L"); assert.strictEqual(pos.terminal, true); assert.strictEqual(pos.fq_dep, "TWR=118.3");
    assert.deepStrictEqual(f.state().offers, ["takeoff"]); assert.strictEqual(f.state().phase, "runway"); });
  console.log(n, "passed");
})();
