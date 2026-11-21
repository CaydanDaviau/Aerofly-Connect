import { createRequire } from "module";
const require = createRequire(import.meta.url);
const E = require("./train-engine.js");
let fails = 0; const t = (n, c) => { console.log(n + ": " + (c ? "PASS" : "FAIL")); if (!c) fails++; };
// synthetic airport near EHAM: 18R/36L (north-south) and a parallel 18C/36C 1.1 nm to the east, 3.4 km long
const dl = 3.4 / 111.2;   // degrees of latitude for 3.4 km
const rows = [["EHAM", "18R", 52.34, 4.70, "36L", 52.34 - dl, 4.70, 60], ["EHAM", "18C", 52.34, 4.74, "36C", 52.34 - dl, 4.74, 60], ["EHAM", "H1", 52.3, 4.7, "H1", 52.3, 4.7, 0], ["XXXX", "09", 1, 1, "27", 1, 1.05, 45]];
const ap = E.buildAirport("EHAM", rows);
t("airport: 4 ends, helipad ignored", ap.ends.length === 4);
t("airport: end 18R heads south ~180", Math.abs(E.n180(ap.ends[0].hdg - 180)) < 1);
t("airport: magvar ~0", Math.abs(ap.magvar) < 2);
let thrown = false; try { E.buildAirport("ZZZZ", rows); } catch (e) { thrown = true; } t("airport: unknown ICAO throws", thrown);
t("parseAlt FL100 / 3000 / 85", E.parseAlt("FL100") === 10000 && E.parseAlt("3000") === 3000 && E.parseAlt("85") === 8500 && isNaN(E.parseAlt("x")));
t("speak digits", E.speak("heading 270", "en") === "heading two seven zero" && E.speak("FL100", "en").includes("flight level one zero zero"));
const run = (S, n, dt = 1) => { for (let i = 0; i < n && !S.over; i++) S.step(dt); };

// ---- TWR: wind from the north -> runway 36 ends are used
let S = E.createSim({ airport: ap, role: "twr", seed: 7, wind: { dir: 0, spd: 10 } });
t("twr: landing end heads north (36x)", Math.abs(E.n180(S.landEnd.hdg)) < 1);
t("twr: departures use the parallel runway", S.depEnd !== S.landEnd && S.depEnd.rw !== S.landEnd.rw);
run(S, 5);
let arr = S.ac.find(a => a.kind === "arr");
t("twr: arrival spawned on final", arr && arr.state === "final" && S.along(arr, S.landEnd) > 10);
let r = S.cmd(arr.id, { type: "land" }); t("twr: cleared to land accepted", r.ok && /cleared to land/.test(r.say));
r = S.cmd(arr.id, { type: "hdg", deg: 90 }); t("twr: heading breaks the ILS", r.ok && arr.state === "air");
S = E.createSim({ airport: ap, role: "twr", seed: 7, wind: { dir: 0, spd: 10 } }); run(S, 5); arr = S.ac.find(a => a.kind === "arr");
S.cmd(arr.id, { type: "land" });
const id0 = arr.id; run(S, 400);
t("twr: arrival cleared to land touches down (+13)", S.lands >= 1 && S.events.some(e => e.type === "land" && e.pts === 13));
// no landing clearance -> automatic go-around at 2 nm
S = E.createSim({ airport: ap, role: "twr", seed: 11, wind: { dir: 0, spd: 10 } }); run(S, 5); arr = S.ac.find(a => a.kind === "arr");
run(S, 300);
t("twr: no clearance -> go-around, -2", S.goArounds >= 1 && S.score <= -2 && S.events.concat([]).length >= 0);
// departure: line up -> takeoff -> handoff
S = E.createSim({ airport: ap, role: "twr", seed: 5, wind: { dir: 0, spd: 10 } }); run(S, 8);
let dep = S.ac.find(a => a.kind === "dep"); t("twr: departure waits at the holding point", dep && dep.state === "hold");
r = S.cmd(dep.id, { type: "takeoff" }); t("twr: takeoff before line-up refused", !r.ok && /not lined up/.test(r.err));
r = S.cmd(dep.id, { type: "lineup" }); t("twr: line up ok", r.ok && dep.state === "lineup");
r = S.cmd(dep.id, { type: "takeoff" }); t("twr: takeoff ok", r.ok && dep.state === "roll");
const sc0 = S.score; for (let i = 0; i < 400 && !S.deps; i++) { S.step(1); if (S.over) break; const x = S.ac.find(a => a.kind === "arr" && a.state === "final" && !a.cleared); }
t("twr: departure handed off (+10)", S.deps === 1 && S.handled >= 1);
// runway occupied: second arrival on the same runway as a lined-up aircraft -> go-around + incursion
S = E.createSim({ airport: ap, role: "twr", seed: 5, wind: { dir: 0, spd: 10 }, depRwy: "36L", landRwy: "36L" }); run(S, 8);
dep = S.ac.find(a => a.kind === "dep"); arr = S.ac.find(a => a.kind === "arr");
S.cmd(dep.id, { type: "lineup" }); S.cmd(arr.id, { type: "land" });
run(S, 400);
t("twr: landing on an occupied runway -> go-around and incursion strike", S.goArounds >= 1 && S.strikes >= 1 && S.events.some(e => e.type === "incursion"));

// ---- APP
S = E.createSim({ airport: ap, role: "app", seed: 3, wind: { dir: 0, spd: 5 } }); run(S, 5);
arr = S.ac.find(a => a.kind === "arr");
t("app: arrival spawns on the ring heading to the IAF", arr && Math.hypot(arr.x, arr.y) > 45 && arr.route[0] === S.iaf);
arr.alt = 8000; r = S.cmd(arr.id, { type: "spd", kt: 300 }); t("app: 300 kt below FL100 refused", !r.ok);
r = S.cmd(arr.id, { type: "alt", ft: 1000 }); t("app: altitude below 2000 refused", !r.ok);
r = S.cmd(arr.id, { type: "direct", fix: "NOPE" }); t("app: unknown fix refused", !r.ok);
r = S.cmd(arr.id, { type: "land" }); t("app: land command not available", !r.ok);
// vector one arrival onto the localizer by hand: put it 16 nm out, 4 nm right of the centre line, heading 300 (30 deg intercept), 4000 ft
const e = S.landEnd, u = { x: Math.sin(e.hdg * Math.PI / 180), y: Math.cos(e.hdg * Math.PI / 180) }, rt = { x: Math.cos(e.hdg * Math.PI / 180), y: -Math.sin(e.hdg * Math.PI / 180) };
arr.x = e.thr.x - u.x * 14 + rt.x * 4; arr.y = e.thr.y - u.y * 14 + rt.y * 4; arr.hdg = E.n360(e.hdg - 35); arr.tgtHdg = arr.hdg; arr.route = []; arr.alt = 4000; arr.tgtAlt = 4000; arr.spd = 200; arr.vs = 0;
r = S.cmd(arr.id, { type: "ils", rwy: e.id }); t("app: ILS clearance accepted", r.ok && /cleared ILS/.test(r.say));
let est = false; for (let i = 0; i < 200; i++) { S.step(1); if (arr.state === "final") { est = true; break; } if (S.over) break; }
t("app: intercepts the localizer", est);
const lands0 = S.lands; run(S, 400);
t("app: lands after ILS (+13) and vacates", S.lands > lands0 && !S.ac.includes(arr));
// too high for the glide path: not captured
S = E.createSim({ airport: ap, role: "app", seed: 3, wind: { dir: 0, spd: 5 } }); run(S, 5); arr = S.ac.find(a => a.kind === "arr");
arr.x = S.landEnd.thr.x - u.x * 14 + rt.x * 2; arr.y = S.landEnd.thr.y - u.y * 14 + rt.y * 2; arr.hdg = E.n360(S.landEnd.hdg - 30); arr.tgtHdg = arr.hdg; arr.route = []; arr.alt = 9000; arr.tgtAlt = 9000;
S.cmd(arr.id, { type: "ils", rwy: S.landEnd.id }); run(S, 60);
t("app: too high to capture (stays airborne, pilot says so)", arr.state === "air" && S.events.some(x => /too high/.test(x.text)));
// departure reaches the exit: needs altitude
S = E.createSim({ airport: ap, role: "app", seed: 9, wind: { dir: 0, spd: 5 } }); run(S, 40);
dep = S.ac.find(a => a.kind === "dep"); t("app: departure airborne with an exit fix", dep && dep.ex && dep.route.length === 2);
S.cmd(dep.id, { type: "alt", ft: 11000 });
for (let i = 0; i < 900 && S.ac.includes(dep) && !S.over; i++) S.step(1);
t("app: departure climbed to the exit counts (+10)", S.deps >= 1 || S.events.some(x => x.type === "handoff"));
S = E.createSim({ airport: ap, role: "app", seed: 9, wind: { dir: 0, spd: 5 } }); run(S, 40); dep = S.ac.find(a => a.kind === "dep");
for (let i = 0; i < 900 && S.ac.includes(dep) && !S.over; i++) S.step(1);
t("app: departure left at 5000 ft = too low (-3)", S.events.some(x => x.type === "bad"));

// ---- separation and collision
S = E.createSim({ airport: ap, role: "app", seed: 21 }); run(S, 4);
let a1 = S.ac[0]; let a2 = S.ac.length > 1 ? S.ac[1] : null;
if (!a2) { run(S, 30); a1 = S.ac[0]; a2 = S.ac[1]; }
a1.x = 20; a1.y = 20; a1.alt = 6000; a1.tgtAlt = 6000; a1.hdg = 90; a1.tgtHdg = 90; a1.route = []; a2.x = 22.5; a2.y = 20; a2.alt = 6000; a2.tgtAlt = 6000; a2.hdg = 270; a2.tgtHdg = 270; a2.route = [];
const stk = S.strikes; S.step(1); t("sep: 2.5 nm at the same level = loss (strike +1, -5)", S.strikes === stk + 1 && S.events.some(x => x.type === "sep"));
S.step(1); t("sep: one strike per episode", S.strikes === stk + 1);
a1.x = 20; a2.x = 20.1; a2.y = 20; a1.alt = a2.alt = 6000; S.step(1); t("collision ends the session", S.over && S.over.reason === "collision");
t("over: commands refused", !S.cmd(a1.id, { type: "hdg", deg: 10 }).ok);
S = E.createSim({ airport: ap, role: "twr", seed: 2 }); for (let i = 0; i < 6; i++) { S.strikes = i; } 
t("report fields", (() => { const q = S.report(); return q.role === "twr" && q.apt === "EHAM" && typeof q.ops === "number"; })());
console.log(fails ? fails + " FAIL" : "0 FAIL"); process.exit(fails ? 1 : 0);
