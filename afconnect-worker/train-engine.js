/* Aerofly Connect ATC training: local traffic simulation (no server). Used by train.html (inlined by build.py) and tested in node (test-train.mjs).
   Units: x east / y north in nm around the airport, altitude ft, speed kt, headings degrees TRUE inside the sim (the UI converts with ap.magvar). */
(function (root) {
"use strict";
var D2R = Math.PI / 180, R2D = 180 / Math.PI;
function n360(a) { return ((a % 360) + 360) % 360; }
function n180(a) { a = n360(a); return a > 180 ? a - 360 : a; }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function brg(a, b) { return n360(Math.atan2(b.x - a.x, b.y - a.y) * R2D); }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function mulberry(seed) { var s = seed >>> 0; return function () { s += 0x6D2B79F5; var t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

var AIRLINES = [["KLM", "KLM"], ["DLH", "Lufthansa"], ["BAW", "Speedbird"], ["AFR", "Air France"], ["RYR", "Ryanair"], ["EZY", "Easy"], ["TAP", "Air Portugal"], ["UAE", "Emirates"], ["AAL", "American"], ["DAL", "Delta"], ["UAL", "United"], ["SWA", "Southwest"], ["AZU", "Azul"], ["TAM", "Tam"], ["GLO", "Gol"]];
var TYPES = [{ n: "B738", c: "M", v: 138 }, { n: "A320", c: "M", v: 135 }, { n: "A321", c: "M", v: 142 }, { n: "E190", c: "L", v: 128 }, { n: "B77W", c: "H", v: 152 }, { n: "A333", c: "H", v: 146 }, { n: "B789", c: "H", v: 145 }];
var FIXES = ["ABLOK", "BERGI", "CLARA", "DOSVA", "ELBAN", "FOXAR", "GIMLO", "HALDO", "IRKUT", "JOLAN", "KEPRO", "LUSBA", "MOTEN", "NIRAL", "OBASA", "PEDUK", "RIVAN", "SOLBA", "TUNAS", "UVOLI", "VELKO", "WIRAN", "XOBAT", "YAMIR", "ZEDAL"];
var WORDS = { en: ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"], pt: ["zero", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove"] };
var SEP_H = 3, SEP_TERM = 2.5, SEP_V = 1000, TERM_NM = 12, RING = 50;

function normRwy(s) { return String(s || "").toUpperCase().replace(/^0+(?=\d)/, "").replace(/\s+/g, ""); }
function digits(s, lang) { var w = WORDS[lang === "pt" ? "pt" : "en"]; return String(s).replace(/\d/g, function (d) { return " " + w[+d]; }).replace(/\s+/g, " ").trim(); }
// "FL100" / "270" / "runway 18R" -> words for text to speech
function speak(t, lang) {
  var pt = lang === "pt";
  return String(t).replace(/\bFL\s?(\d+)/g, function (m, n) { return (pt ? "nível de voo " : "flight level ") + digits(n, lang); })
    .replace(/(\d+)\s?ft\b/g, function (m, n) { return n + (pt ? " pés" : " feet"); })
    .replace(/\d+/g, function (n) { return digits(n, lang); })
    .replace(/\b([A-Z])\b/g, function (m, c) { return { L: pt ? "esquerda" : "left", R: pt ? "direita" : "right", C: pt ? "central" : "center" }[c] || c; });
}
function parseAlt(v) { var s = String(v || "").toUpperCase().replace(/\s|FT|FL/g, ""); var n = Number(s); if (!isFinite(n) || n <= 0) return NaN; return n < 1000 ? n * 100 : n; }
function altText(ft, lang) { return ft >= 5000 ? "FL" + String(Math.round(ft / 100)).padStart(3, "0") : Math.round(ft) + " ft"; }

// rows = [airport_ident, le_ident, le_lat, le_lon, he_ident, he_lat, he_lon, width] (same format as the radar page's runway list)
function buildAirport(icao, rows) {
  icao = String(icao || "").toUpperCase();
  var rs = rows.filter(function (r) { return r[0] === icao && /^\d{1,2}[LRC]?$/.test(r[1]) && /^\d{1,2}[LRC]?$/.test(r[4]); });
  if (!rs.length) throw new Error("no runway data for " + icao);
  var sl = 0, so = 0; rs.forEach(function (r) { sl += r[2] + r[5]; so += r[3] + r[6]; });
  var lat0 = sl / (2 * rs.length), lon0 = so / (2 * rs.length), cl = Math.cos(lat0 * D2R);
  var toXY = function (la, lo) { return { x: (lo - lon0) * 60 * cl, y: (la - lat0) * 60 }; };
  var ends = [], rwys = [];
  rs.forEach(function (r) {
    var a = toXY(r[2], r[3]), b = toXY(r[5], r[6]), len = dist(a, b);
    if (len < 0.45) return;
    var i = rwys.length; rwys.push({ i: i, len: len, a: a, b: b });
    ends.push({ id: r[1], key: normRwy(r[1]), thr: a, hdg: brg(a, b), len: len, rw: i }, { id: r[4], key: normRwy(r[4]), thr: b, hdg: brg(b, a), len: len, rw: i });
  });
  if (!ends.length) throw new Error("no usable runways for " + icao);
  var s = 0, c = 0; ends.forEach(function (e) { var d = (parseInt(e.id, 10) * 10 - e.hdg) * D2R; s += Math.sin(d); c += Math.cos(d); });
  return { icao: icao, lat0: lat0, lon0: lon0, ends: ends, rwys: rwys, magvar: Math.atan2(s, c) * R2D, toXY: toXY, toLL: function (x, y) { return { lat: lat0 + y / 60, lon: lon0 + x / (60 * cl) }; } };
}

function createSim(o) {
  var ap = o.airport, role = o.role === "app" ? "app" : "twr", lang = o.lang === "pt" ? "pt" : "en", rnd = mulberry(o.seed == null ? (Math.random() * 4294967296) | 0 : o.seed);
  var T = function (en, pt) { return lang === "pt" ? pt : en; };
  var S = { t: 0, role: role, ap: ap, lang: lang, ac: [], fixes: [], events: [], score: 0, handled: 0, lands: 0, deps: 0, strikes: 0, goArounds: 0, over: null, level: 1, ring: RING, conflicts: [] };
  var wdir = o.wind ? o.wind.dir : Math.floor(rnd() * 36) * 10, wspd = o.wind ? o.wind.spd : 5 + Math.floor(rnd() * 14);
  S.wind = { dir: wdir, spd: wspd };
  function head(e) { return Math.cos((e.hdg + ap.magvar - wdir) * D2R); }     // wind compares with the magnetic runway heading
  var best = ap.ends.slice().sort(function (a, b) { return head(b) - head(a) || b.len - a.len; });
  var landEnd = o.landRwy ? (ap.ends.find(function (e) { return e.key === normRwy(o.landRwy); }) || best[0]) : best[0];
  var depEnd = o.depRwy ? (ap.ends.find(function (e) { return e.key === normRwy(o.depRwy); }) || landEnd) : landEnd;
  if (!o.depRwy) { var par = best.find(function (e) { return e.rw !== landEnd.rw && Math.abs(n180(e.hdg - landEnd.hdg)) < 25; }); if (par) depEnd = par; }
  S.landEnd = landEnd; S.depEnd = depEnd;
  var used = {}, ids = 0, nextArr = 3, nextDep = role === "twr" ? 6 : 25, pool = FIXES.slice();
  function pickFix() { var i = Math.floor(rnd() * pool.length); return pool.splice(i, 1)[0] || ("FIX" + (++ids)); }
  function unit(h) { return { x: Math.sin(h * D2R), y: Math.cos(h * D2R) }; }
  function add(p, u, d) { return { x: p.x + u.x * d, y: p.y + u.y * d }; }
  // fixes
  var u0 = unit(landEnd.hdg), iaf = add(landEnd.thr, u0, -16); S.fixes.push({ name: pickFix(), x: iaf.x, y: iaf.y, kind: "IAF" });
  S.iaf = S.fixes[0];
  var bs = rnd() * 360; S.entries = []; S.exits = [];
  for (var k = 0; k < 4; k++) { var b = bs + k * 90 + (rnd() - .5) * 30, p = { x: Math.sin(b * D2R) * RING, y: Math.cos(b * D2R) * RING }, f = { name: pickFix(), x: p.x, y: p.y, kind: k < 2 ? "ENTRY" : "EXIT", brg: n360(b) }; S.fixes.push(f); (k < 2 ? S.entries : S.exits).push(f); }
  function fixByName(n) { n = String(n || "").toUpperCase().trim(); return S.fixes.find(function (f) { return f.name === n; }); }
  S.fixByName = fixByName;

  function say(a, en, pt) { return T(en, pt) + ", " + a.sp; }
  function ev(type, text, a, extra) { var e = { t: S.t, type: type, text: text || "", cs: a ? a.cs : "" }; if (extra) for (var k in extra) e[k] = extra[k]; S.events.push(e); return e; }
  function callsign() {
    for (var n = 0; n < 50; n++) { var al = AIRLINES[Math.floor(rnd() * AIRLINES.length)], num = 1 + Math.floor(rnd() * (rnd() < .5 ? 99 : 9999)), cs = al[0] + num; if (!used[cs]) { used[cs] = 1; return { cs: cs, sp: al[1] + " " + digits(num, lang) }; } }
    var cs = "TRN" + (++ids); used[cs] = 1; return { cs: cs, sp: cs };
  }
  function mk(kind, extra) {
    var c = callsign(), ty = TYPES[Math.floor(rnd() * TYPES.length)];
    var a = { id: ++ids, cs: c.cs, sp: c.sp, type: ty.n, cls: ty.c, vapp: ty.v, kind: kind, state: "air", x: 0, y: 0, hdg: 0, spd: 250, alt: 5000, vs: 0, tgtHdg: null, turnDir: null, tgtAlt: 5000, tgtSpd: null, route: [], hold: false, ils: null, cleared: false, rw: null, born: S.t, ga: 0, trail: [], trT: 0, td: 0, ex: null, delay: 0, said: {}, sepMsg: 0 };
    for (var k in extra) a[k] = extra[k];
    S.ac.push(a); return a;
  }
  var stripNo = function () { return ids; };
  function along(a, e) { var u = unit(e.hdg); return -((a.x - e.thr.x) * u.x + (a.y - e.thr.y) * u.y); }   // nm before the threshold (positive = on the approach side)
  function cross(a, e) { var u = unit(e.hdg); return (a.x - e.thr.x) * u.y - (a.y - e.thr.y) * u.x; }  // positive = right of the centre line
  function gsAlt(d) { return 319 * Math.max(d, 0); }
  function occupant(rw, except) { for (var i = 0; i < S.ac.length; i++) { var a = S.ac[i]; if (a !== except && a.rw === rw && (a.state === "lineup" || a.state === "roll" || a.state === "rollout")) return a; } return null; }
  function counts() { var n = { air: 0, hold: 0 }; S.ac.forEach(function (a) { if (a.state === "hold") n.hold++; else n.air++; }); return n; }
  S.occupant = occupant; S.along = along; S.cross = cross;

  // ---- spawning ----
  function spawnArrival() {
    var a;
    if (role === "twr") {
      var d = 11 + rnd() * 3, e = landEnd;
      for (var i = 0; i < S.ac.length; i++) { var o2 = S.ac[i]; if (o2.state === "final" && o2.ils === e && Math.abs(along(o2, e) - d) < 4.2) return false; }
      var u = unit(e.hdg), p = add(e.thr, u, -d);
      a = mk("arr", { x: p.x, y: p.y, hdg: e.hdg, spd: 170, alt: gsAlt(d), state: "final", ils: e, rw: e.rw, tgtAlt: 0 });
      a.said.in = true; ev("call", say(a, "established ILS runway " + e.id + ", " + Math.round(d) + " miles", "estabilizado ILS pista " + e.id + ", " + Math.round(d) + " milhas"), a);
    } else {
      var en = S.entries[Math.floor(rnd() * S.entries.length)], p2 = { x: en.x + (rnd() - .5) * 6, y: en.y + (rnd() - .5) * 6 };
      for (var j = 0; j < S.ac.length; j++) if (dist(S.ac[j], p2) < 7) return false;
      var alts = [8000, 9000, 10000, 11000, 12000], al = alts[Math.floor(rnd() * alts.length)];
      a = mk("arr", { x: p2.x, y: p2.y, hdg: brg(p2, S.iaf), spd: al > 10000 ? 280 : 250, alt: al, tgtAlt: al, route: [S.iaf] });
      ev("call", say(a, altText(al, lang) + ", inbound " + S.iaf.name, altText(al, lang) + ", em direção a " + S.iaf.name), a);
    }
    return true;
  }
  function spawnDeparture() {
    var e = depEnd, u = unit(e.hdg);
    if (role === "twr") {
      var holds = S.ac.filter(function (x) { return x.state === "hold"; }); if (holds.length >= 3) return false;
      var right = { x: Math.cos(e.hdg * D2R), y: -Math.sin(e.hdg * D2R) }, p = add(add(e.thr, right, 0.2), u, -0.15 * holds.length);
      var a = mk("dep", { x: p.x, y: p.y, hdg: e.hdg, spd: 0, alt: 0, state: "hold", rw: e.rw, ends: e, tgtAlt: 3000, holdSince: S.t });
      a.said.rdy = true; ev("call", say(a, "holding point runway " + e.id + ", ready for departure", "ponto de espera pista " + e.id + ", pronto para a partida"), a);
    } else {
      var p3 = add(e.thr, u, e.len + 0.3), ex = S.exits[Math.floor(rnd() * S.exits.length)];
      for (var j = 0; j < S.ac.length; j++) if (dist(S.ac[j], p3) < 3 && Math.abs(S.ac[j].alt - 1500) < 1500) return false;
      var b = mk("dep", { x: p3.x, y: p3.y, hdg: e.hdg, spd: 190, alt: 1500, vs: 1800, tgtAlt: 5000, ex: ex, route: [add(e.thr, u, e.len + 3.5), ex] });
      ev("call", say(b, "airborne, climbing 5000 ft, exit " + ex.name, "decolou, subindo 5000 ft, saída " + ex.name), b);
    }
    return true;
  }
  function spawns() {
    var lv = S.level, maxN = role === "twr" ? Math.min(14, 6 + lv * 2) : Math.min(18, 8 + lv * 2);
    if (S.t >= nextArr && S.ac.length < maxN) { if (spawnArrival()) nextArr = S.t + Math.max(40, 110 - (lv - 1) * 10) * (.75 + rnd() * .5); else nextArr = S.t + 8; }
    if (S.t >= nextDep && S.ac.length < maxN) { if (spawnDeparture()) nextDep = S.t + Math.max(45, 100 - (lv - 1) * 8) * (.75 + rnd() * .5); else nextDep = S.t + 8; }
  }

  // ---- dynamics ----
  function turn(a, des, dt) {
    var rate = (a.spd > 250 ? 2 : 3) * dt, d = n180(des - a.hdg);
    if (a.turnDir === "L" && d > 1) d -= 360; else if (a.turnDir === "R" && d < -1) d += 360;
    if (Math.abs(d) < 1.5 && a.turnDir) a.turnDir = null;
    a.hdg = n360(a.hdg + clamp(d, -rate, rate));
  }
  function spdTarget(a, d) {
    var t;
    if (a.state === "final") { t = a.vapp + clamp((d - 4) * 6, 0, 70); if (a.tgtSpd) t = Math.min(t, Math.max(a.tgtSpd, a.vapp)); return t; }
    if (a.tgtSpd) t = a.tgtSpd;
    else if (a.kind === "dep") t = a.alt < 3000 ? 200 : a.alt < 10000 ? 250 : 290;
    else t = a.alt > 10000 ? 280 : a.alt < 4000 ? 200 : 250;
    if (a.alt < 10000) t = Math.min(t, 250);
    return t;
  }
  function moveSpeed(a, t, dt) { a.spd += clamp(t - a.spd, -2.5 * dt, 2 * dt); }
  function climb(a, dt, tgt) {
    var up = a.alt > 10000 ? 1600 : 2200, dn = 2000, want = clamp((tgt - a.alt) * 4, -dn, up);
    if (Math.abs(tgt - a.alt) < 30) want = 0;
    a.vs += clamp(want - a.vs, -500 * dt, 500 * dt); a.alt += a.vs * dt / 60;
    if ((a.vs > 0 && a.alt > tgt) || (a.vs < 0 && a.alt < tgt)) { a.alt = tgt; a.vs = 0; }
  }
  function fwd(a, dt) { a.x += Math.sin(a.hdg * D2R) * a.spd / 3600 * dt; a.y += Math.cos(a.hdg * D2R) * a.spd / 3600 * dt; }
  function goAround(a, why, byCtl) {
    var e = a.ils; a.state = "air"; a.ils = null; a.cleared = false; a.tgtHdg = e ? e.hdg : a.hdg; a.tgtAlt = 3000; a.tgtSpd = 200; a.route = []; a.hold = false; a.ga++; a.gaAt = S.t; a.gaEnd = e; S.goArounds++;
    S.score -= byCtl ? 1 : 2; ev("ga", say(a, "going around" + (why ? ", " + why : ""), "arremetendo" + (why ? ", " + why : "")), a, { pts: byCtl ? -1 : -2 });
    return true;
  }
  function strike(n, pts, type, text, a) { S.strikes += n; S.score -= pts; ev(type, text, a, { pts: -pts }); if (S.strikes >= 6 && !S.over) over("strikes"); }
  function over(why) { S.over = { reason: why, t: S.t }; ev("over", why, null); }
  function remove(a) { a.gone = true; if (a.rw != null && S.occ) delete S.occ[a.rw]; }

  function updateAc(a, dt) {
    var e;
    if (a.state === "hold") {
      if (S.t - a.holdSince > 300 && Math.floor((S.t - a.holdSince - 300) / 60) >= a.delay + 1 && a.delay < 5) { a.delay++; S.score -= 1; ev("delay", say(a, "still holding, delay", "ainda aguardando, atraso"), a, { pts: -1 }); }
      return;
    }
    if (a.state === "lineup") return;
    if (a.state === "roll") {
      a.spd += 4 * dt; fwd(a, dt);
      if (a.spd >= 145) { a.state = "air"; a.alt = 20; a.vs = 1500; a.tgtHdg = a.hdg; a.tgtSpd = null; a.rw = null; ev("info", say(a, "airborne", "decolou"), a); }
      return;
    }
    if (a.state === "rollout") {
      a.spd = Math.max(25, a.spd - 3 * dt); fwd(a, dt);
      if (S.t - a.td >= (role === "twr" ? 40 : 22)) { ev("info", say(a, "vacating the runway", "livrando a pista"), a); remove(a); }
      return;
    }
    if (a.state === "final") {
      e = a.ils; var d = along(a, e), x = cross(a, e);
      var des = e.hdg - clamp(x * 35, -25, 25); turn(a, des, dt);
      moveSpeed(a, spdTarget(a, d), dt);
      var g = gsAlt(d), wantVs;
      if (a.alt > g + 100) wantVs = -clamp((a.alt - g) * 3, 700, 1500); else if (a.alt < g - 250) wantVs = 0; else wantVs = -a.spd * 5.3;
      a.vs += clamp(wantVs - a.vs, -300 * dt, 300 * dt); a.alt = Math.max(0, a.alt + a.vs * dt / 60);
      fwd(a, dt);
      if (!a.said.est && Math.abs(x) < 0.25) { a.said.est = true; ev("call", say(a, "established ILS runway " + e.id, "estabilizado ILS pista " + e.id), a); }
      var oc = occupant(e.rw, a);
      if (along(a, e) <= 0.9 && oc) { var bad = oc.state === "lineup" || oc.state === "roll"; goAround(a, T("runway occupied", "pista ocupada")); if (bad) strike(1, 5, "incursion", say(oc, "runway incursion: " + oc.cs + " on the runway with traffic landing", "incursão de pista: " + oc.cs + " na pista com pouso"), oc); return; }
      if (role === "twr" && d <= 2 && !a.cleared) { goAround(a, T("no landing clearance", "sem autorização de pouso")); return; }
      if (d <= 0.25 || a.alt <= 5) {
        a.state = "rollout"; a.alt = 0; a.vs = 0; a.td = S.t; a.rw = e.rw; a.hdg = e.hdg; S.handled++; S.lands++;
        var pts = 10 + (a.ga === 0 ? 3 : 0); S.score += pts; ev("land", say(a, "landed runway " + e.id, "pousou na pista " + e.id), a, { pts: pts });
      }
      return;
    }
    // airborne (air)
    var des2 = a.hdg;
    if (a.hold) des2 = a.hdg + 30;
    else if (a.tgtHdg != null) des2 = a.tgtHdg;
    else if (a.route.length) { var p = a.route[0]; des2 = brg(a, p); if (dist(a, p) < Math.max(0.8, a.spd / 3600 * 9)) { a.route.shift(); if (!a.route.length && a.kind === "arr" && !a.ils) { a.hold = true; if (!a.said.hold) { a.said.hold = 1; ev("call", say(a, "holding at " + p.name + ", request vectors", "em espera em " + p.name + ", solicita vetores"), a); } } } }
    turn(a, des2, dt);
    // ILS capture
    if (a.ils && a.kind === "arr") {
      e = a.ils; var dd = along(a, e), xx = cross(a, e), rel = n180(a.hdg - e.hdg), rr = a.spd / 188.5;
      var near = Math.abs(xx) <= rr * (1 - Math.cos(Math.abs(rel) * D2R)) + 0.35 && (xx * Math.sin(rel * D2R) <= 0 || Math.abs(xx) < 0.4);
      if (dd > 2.5 && dd < 25 && near && Math.abs(rel) <= 45) {
        if (a.alt <= gsAlt(dd) + 1500) { a.state = "final"; a.rw = e.rw; a.tgtHdg = null; a.hold = false; a.route = []; a.turnDir = null; }
        else if (S.t - (a.said.high || -99) > 45) { a.said.high = S.t; ev("call", say(a, "unable to descend to the glide path, too high", "não consegue interceptar a rampa, muito alto"), a); }
      } else if (Math.abs(xx) < 0.8 && Math.abs(rel) > 50 && dd > 2 && dd < 25 && S.t - (a.said.angle || -99) > 60) { a.said.angle = S.t; ev("call", say(a, "unable to intercept the localizer, say heading", "não consegue interceptar o localizador, diga a proa"), a); }
    }
    moveSpeed(a, spdTarget(a, 0), dt);
    climb(a, dt, a.tgtAlt);
    fwd(a, dt);
    // go-around climb-out
    if (a.gaEnd) {
      if (role === "twr" && a.alt >= 2800 && dist(a, a.gaEnd.thr) > 3) { ev("info", say(a, "contact approach", "chamando aproximação"), a); remove(a); return; }
      if (a.alt >= 2900) { a.gaEnd = null; a.tgtSpd = null; }
    }
    if (a.kind === "dep") {
      if (role === "twr") { var de = depEnd; if (dist(a, de.thr) > 6 && a.alt >= 1500) { S.handled++; S.deps++; S.score += 10; ev("handoff", say(a, "contacting departure", "chamando saída"), a, { pts: 10 }); remove(a); } }
      else if (Math.hypot(a.x, a.y) >= RING - 2) {
        var okAlt = a.alt >= 9000, okBrg = Math.abs(n180(brg({ x: 0, y: 0 }, a) - a.ex.brg)) <= 25;
        if (okAlt && okBrg) { S.handled++; S.deps++; S.score += 10; ev("handoff", say(a, "contacting center", "chamando centro"), a, { pts: 10 }); }
        else { S.score -= 3; ev("bad", say(a, okAlt ? "left the sector through the wrong exit" : "left the sector too low", okAlt ? "saiu do setor pela saída errada" : "saiu do setor muito baixo"), a, { pts: -3 }); }
        remove(a);
      }
    } else if (Math.hypot(a.x, a.y) > RING + 25) { remove(a); }   // arrival that flew away
  }

  S.step = function (dt) {
    if (S.over) return S.events;
    dt = dt || 1; S.t += dt;
    spawns();
    S.ac.forEach(function (a) { if (!a.gone) updateAc(a, dt); });
    S.ac = S.ac.filter(function (a) { return !a.gone; });
    S.ac.forEach(function (a) { if (S.t - a.trT >= 6 && a.state !== "hold" && a.state !== "lineup") { a.trT = S.t; a.trail.push({ x: a.x, y: a.y }); if (a.trail.length > 8) a.trail.shift(); } });
    // separation + collision
    S.conflicts = []; S.sepSt = S.sepSt || {};
    var air = S.ac.filter(function (a) { return a.alt >= 150 && (a.state === "air" || a.state === "final"); });
    for (var i = 0; i < air.length; i++) for (var j = i + 1; j < air.length; j++) {
      var p = air[i], q = air[j], h = dist(p, q), v = Math.abs(p.alt - q.alt), key = Math.min(p.id, q.id) + "|" + Math.max(p.id, q.id);
      var term = Math.hypot(p.x, p.y) < TERM_NM && Math.hypot(q.x, q.y) < TERM_NM, min = term ? SEP_TERM : SEP_H, st = S.sepSt[key];
      if (h < 0.2 && v < 300) { over("collision"); ev("collision", p.cs + " / " + q.cs, p); return S.events; }
      if (h < min && v < SEP_V) {
        S.conflicts.push({ a: p.id, b: q.id, viol: true, min: min });
        if (!st || S.t - st.last > 30) { strike(1, 5, "sep", say(p, "loss of separation with " + q.cs, "perda de separação com " + q.cs), p); }
        S.sepSt[key] = { last: S.t };
      } else if (h < min * 1.6 && v < SEP_V) S.conflicts.push({ a: p.id, b: q.id, viol: false, min: min });
    }
    S.level = 1 + Math.floor(S.handled / 6);
    return S.events;
  };

  // ---- commands ----
  S.find = function (id) { return S.ac.find(function (a) { return a.id === id || a.cs === id; }); };
  function err(a, en, pt) { return { ok: false, err: say(a, "unable, " + en, "não consigo, " + pt) }; }
  S.cmd = function (id, c) {
    var a = S.find(id); if (!a) return { ok: false, err: T("Aircraft not found", "Aeronave não encontrada") };
    if (S.over) return { ok: false, err: T("Session over", "Sessão encerrada") };
    var onGnd = a.state === "hold" || a.state === "lineup" || a.state === "roll" || a.state === "rollout";
    var r = { ok: true, say: "" };
    switch (c.type) {
      case "hdg": {
        if (onGnd) return err(a, "on the ground", "no solo");
        var m = Number(c.deg); if (!isFinite(m) || m < 1 || m > 360) return err(a, "bad heading", "proa inválida");
        var tr = n360(m - ap.magvar); a.tgtHdg = tr; a.turnDir = c.dir === "L" || c.dir === "R" ? c.dir : null; a.route = []; a.hold = false;
        if (a.state === "final") { a.state = "air"; a.ils = null; a.cleared = false; }
        else if (a.ils) { /* keeps the ILS clearance, may capture later */ }
        r.say = say(a, (a.turnDir === "L" ? "turn left heading " : a.turnDir === "R" ? "turn right heading " : "fly heading ") + String(Math.round(m)).padStart(3, "0"), (a.turnDir === "L" ? "vire à esquerda proa " : a.turnDir === "R" ? "vire à direita proa " : "voe proa ") + String(Math.round(m)).padStart(3, "0")); break;
      }
      case "alt": {
        if (onGnd) return err(a, "on the ground", "no solo");
        if (a.state === "final") return err(a, "established on the localizer", "estabilizado no localizador");
        var ft = Math.round(Number(c.ft) / 100) * 100; if (!isFinite(ft) || ft < 2000 || ft > 40000) return err(a, "bad altitude", "altitude inválida");
        var up = ft > a.alt; a.tgtAlt = ft;
        r.say = say(a, (up ? "climb and maintain " : "descend and maintain ") + altText(ft, lang), (up ? "suba e mantenha " : "desça e mantenha ") + altText(ft, lang)); break;
      }
      case "spd": {
        if (onGnd) return err(a, "on the ground", "no solo");
        var kt = Math.round(Number(c.kt)); if (!isFinite(kt) || kt < 140 || kt > 320) return err(a, "bad speed", "velocidade inválida");
        if (a.alt < 10000 && kt > 250) return err(a, "250 knots below 10000", "250 nós abaixo de 10000");
        a.tgtSpd = kt; r.say = say(a, "speed " + kt, "velocidade " + kt); break;
      }
      case "direct": {
        if (onGnd || a.state === "final") return err(a, "not available now", "não disponível agora");
        var f = fixByName(c.fix); if (!f) return err(a, "unknown fix", "fixo desconhecido");
        a.route = [f]; a.tgtHdg = null; a.hold = false; a.turnDir = null; r.say = say(a, "direct " + f.name, "direto " + f.name); break;
      }
      case "ils": {
        if (a.kind !== "arr" || a.state !== "air") return err(a, "not available now", "não disponível agora");
        var e = ap.ends.find(function (x) { return x.key === normRwy(c.rwy); }); if (!e) return err(a, "unknown runway", "pista desconhecida");
        a.ils = e; if (a.hold) { a.hold = false; if (a.tgtHdg == null) a.tgtHdg = a.hdg; }
        r.say = say(a, "cleared ILS runway " + e.id, "autorizado ILS pista " + e.id); break;
      }
      case "land": {
        if (role !== "twr") return err(a, "not available now", "não disponível agora");
        if (a.state !== "final") return err(a, "not established on final", "não estabilizado na final");
        a.cleared = true; r.say = say(a, "cleared to land runway " + a.ils.id, "autorizado a pousar pista " + a.ils.id); break;
      }
      case "goaround": {
        if (a.state !== "final") return err(a, "not on final", "fora da final");
        goAround(a, "", true); r.say = ""; break;
      }
      case "lineup": {
        if (a.state !== "hold") return err(a, "not holding short", "não está no ponto de espera");
        if (occupant(a.rw, a)) return err(a, "runway occupied", "pista ocupada");
        var en = a.ends, u = unit(en.hdg), p = add(en.thr, u, 0.04); a.x = p.x; a.y = p.y; a.hdg = en.hdg; a.state = "lineup";
        r.say = say(a, "line up and wait runway " + en.id, "alinhar e aguardar pista " + en.id); break;
      }
      case "takeoff": {
        if (a.state !== "lineup") return err(a, "not lined up", "não está alinhado");
        a.state = "roll"; r.say = say(a, "cleared for takeoff runway " + a.ends.id, "autorizado a decolar pista " + a.ends.id); break;
      }
      default: return { ok: false, err: "bad command" };
    }
    ev("cmd", r.say, a); return r;
  };
  // current assigned values for the UI
  S.report = function () { return { role: role, apt: ap.icao, score: Math.round(S.score), handled: S.handled, strikes: S.strikes, dur: Math.round(S.t), over: !!S.over, level: S.level, lands: S.lands, deps: S.deps, ops: role === "twr" ? S.lands + S.deps : S.lands, goArounds: S.goArounds }; };
  S.drain = function () { var e = S.events; S.events = []; return e; };
  return S;
}

var api = { createSim: createSim, buildAirport: buildAirport, parseAlt: parseAlt, speak: speak, normRwy: normRwy, altText: altText, brg: brg, dist: dist, n180: n180, n360: n360, DIGITS: digits };
if (typeof module !== "undefined" && module.exports) module.exports = api; else root.TrainEngine = api;
})(typeof window !== "undefined" ? window : this);
