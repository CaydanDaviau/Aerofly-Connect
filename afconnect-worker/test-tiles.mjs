import zlib from "node:zlib";
import worker, { Hub } from "./src/index.js";
import { decodeTile, graphFromTiles, nearest, holdNode, route, legs, dist } from "./src/taxi.js";
const T = (n, v) => console.log("tiles " + n + ":", v ? "PASS" : "FAIL");
// ---- tiny MVT encoder
const vi = n => { const o = []; while (n > 127) { o.push((n % 128) | 128); n = Math.floor(n / 128); } o.push(n); return o; };
const tg = (f, w) => vi(f * 8 + w), lenf = (f, b) => [...tg(f, 2), ...vi(b.length), ...b], zz = n => n < 0 ? -2 * n - 1 : 2 * n, sb = s => [...Buffer.from(s)];
const Z = 14, WORLD = 2 ** Z * 4096;
const px = (la, lo) => { const s = Math.sin(la * Math.PI / 180); return [Math.round((lo + 180) / 360 * WORLD), Math.round((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * WORLD)]; };
function encodeTile(tx, ty, feats) {
  const keys = ["class", "ref"], vals = [], vi2 = new Map();
  const val = s => { if (!vi2.has(s)) { vi2.set(s, vals.length); vals.push(s); } return vi2.get(s); };
  const fb = feats.map(f => {
    let cx = 0, cy = 0, g = [];
    for (const line of f.lines) {
      line.forEach((p, i) => { const x = p[0] - tx * 4096, y = p[1] - ty * 4096; if (i === 0) g.push(9, zz(x - cx), zz(y - cy)); else { if (i === 1) g.push(2 | ((line.length - 1) << 3)); g.push(zz(x - cx), zz(y - cy)); } cx = x; cy = y; });
    }
    const tags = [0, val(f.cls)]; if (f.ref) tags.push(1, val(f.ref));
    const tb = tags.flatMap(t => vi(t)), gb = g.flatMap(t => vi(t));
    return lenf(2, [...tg(2, 2), ...vi(tb.length), ...tb, ...tg(3, 0), f.type, ...tg(4, 2), ...vi(gb.length), ...gb]);
  });
  const layer = [...lenf(1, sb("aeroway")), ...fb.flat(), ...keys.flatMap(k => lenf(3, sb(k))), ...vals.flatMap(v => lenf(4, lenf(1, sb(v)))), ...tg(5, 0), ...vi(4096), ...tg(15, 0), 2];
  return Buffer.from(lenf(3, layer));
}
// ---- synthetic airport, simplified like real tiles: runway has no vertex at the crossing, A has none at the D junction, D is one straight segment through the runway
const B0 = [-15.87, -47.92], P = (la, lo) => px(B0[0] + la, B0[1] + lo);
const feats = [
  { type: 2, cls: "runway", ref: "9/27", lines: [[P(0, -.01), P(0, .01)]] },
  { type: 2, cls: "taxiway", ref: "A", lines: [[P(.0008, -.01), P(.0008, .01)]] },
  { type: 2, cls: "taxiway", ref: "B", lines: [[P(.0008, .01), P(.0004, .01), P(0, .01)]] },
  { type: 2, cls: "taxiway", ref: "C", lines: [[P(0, -.01), P(.0004, -.01), P(.0008, -.01)]] },
  { type: 2, cls: "taxiway", ref: "D", lines: [[P(.0008, .005), P(-.0008, .005)]] },
  { type: 2, cls: "taxiway", ref: "S", lines: [[P(-.0008, .005), P(-.0008, 0)]] },
  { type: 1, cls: "gate", ref: "G1", lines: [[P(.0008, -.01)]] },
  { type: 1, cls: "gate", ref: "S9", lines: [[P(-.0008, 0)]] },
];
// every tile in the window gets every feature (like the tile buffers overlapping): duplicates must not matter
const [tx0, ty0] = P(0, 0).map(v => Math.floor(v / 4096));
const tiles = []; for (let x = tx0 - 1; x <= tx0 + 1; x++) for (let y = ty0 - 1; y <= ty0 + 1; y++) tiles.push([x, y]);
const bin = {}; for (const [x, y] of tiles) bin[x + "/" + y] = zlib.gzipSync(encodeTile(x, y, feats));
const dec = decodeTile(encodeTile(tx0, ty0, feats));
T("decoder reads layer, features, props", dec.aeroway && dec.aeroway[0].features.length === 8 && dec.aeroway[0].features[0].props.class === "runway" && dec.aeroway[0].features[0].props.ref === "9/27" && dec.aeroway[0].features[0].parts[0].length === 2);
const g = graphFromTiles(tiles.map(([x, y]) => ({ x, y, layers: decodeTile(encodeTile(x, y, feats)) })), Z, B0[0], B0[1]);
const at = (la, lo) => nearest(g, B0[0] + la, B0[1] + lo, 3);
T("graph built, 2 stands, 1 runway", g && g.stands.length === 2 && g.runways.length === 1 && g.runways[0].refs.join() === "09,27".replace(",", "/") .split("/").join() || (g.runways[0].refs.join() === "09,27"));
T("junction A/D rebuilt (T)", at(.0008, .005) && at(.0008, .005).adj.length >= 3);
T("crossing D/runway rebuilt (X)", at(0, .005) && at(0, .005).adj.length === 4);
const h = holdNode(g, "27");
T("hold short node on connector B", h && dist(h.lat, h.lon, B0[0] + .0004, B0[1] + .01) < 3);
const a1 = at(.0008, -.01);
let lg = legs(route(g, a1.id, h.id), g);
T("taxi-out legs Alpha then Bravo", lg.map(l => l.name).join(",") === "A,B");
const s9 = g.stands.find(s => s.ref === "S9");
lg = legs(route(g, a1.id, s9.node), g);
T("route to S9 crosses runway", lg.map(l => l.name).join(",") === "A,D,09/27,D,S" && lg.some(l => l.kind === "rwy" && l.cross));
// ---- Hub integration: tiles served (gzip, TileJSON), Overpass would fail
const store = new Map();
const ctx = { storage: { get: async k => store.get(k), put: async (k, v) => store.set(k, v), delete: async k => store.delete(k), list: async ({ prefix }) => new Map([...store].filter(([k]) => k.startsWith(prefix))) }, blockConcurrencyWhile: async f => f() };
const hub = new Hub(ctx);
const env = { HUB: { idFromName: () => 1, get: () => ({ fetch: (r, init) => hub.fetch(init && init.headers ? new Request(r, { headers: init.headers }) : r) }) } };
const call = async (method, path, body, key) => { const r = await worker.fetch(new Request("https://x" + path, { method, body: body && JSON.stringify(body), headers: { "X-API-Key": key } }), env); return JSON.parse((await r.text()) || "{}"); };
const realFetch = globalThis.fetch; let nTile = 0, nOver = 0;
globalThis.fetch = async (u, o) => {
  u = String(u);
  if (u === "https://tiles.openfreemap.org/planet") return new Response(JSON.stringify({ tiles: ["https://tiles.openfreemap.org/planet/20261101_001001_pt/{z}/{x}/{y}.pbf"] }));
  const m = u.match(/planet\/[^/]+\/14\/(\d+)\/(\d+)\.pbf/);
  if (m) { nTile++; const b = bin[m[1] + "/" + m[2]]; return b ? new Response(b, { headers: { "content-type": "application/x-protobuf" } }) : new Response("", { status: 404 }); }
  if (u.includes("overpass")) { nOver++; throw new Error("overpass down"); }
  return realFetch(u, o);
};
const pos = (k, o) => call("PUT", "/api/position", { latitude: B0[0] + .0008, longitude: B0[1] - .01, altitude_ft: 3500, ground_speed: 0, freq: "118.000", phase: "ground", ...o }, k);
await call("PUT", "/api/flightplan", { callsign: "TT1", departure_airport: "SBBR", departure_runway: "27", arrival_airport: "SBBR", arrival_runway: "27" }, "tt1");
await pos("tt1"); await new Promise(r => setTimeout(r, 80));
T("tiles used, Overpass not needed", nTile > 0 && nOver === 0);
hub.clients.get("tt1").lastReq = 0;
const r = await call("PUT", "/api/atc/request", { type: "taxi" }, "tt1");
T("routed taxi text from tiles", r.messages[0].text === "Taxi to runway 27 via Alpha, Bravo, hold short runway 27");
const tx = await call("GET", "/api/taxi?icao_address=" + hub.clients.get("tt1").pos.icao_address, null, "tt1");
T("taxi line stored: points + hold-short end", Array.isArray(tx.points) && tx.points.length >= 3 && tx.end && /^HOLD 27/.test(tx.end.label) && tx.kind === "out");
const tl = await call("GET", "/api/traffic?lat=" + B0[0] + "&lon=" + B0[1] + "&radius_miles=50", null, "tt1");
T("traffic flags has_taxi", tl.aircraft.some(a => a.callsign === "TT1" && a.has_taxi === true));
await pos("tt1", { phase: "air", ground_speed: 150 });
const tl2 = await call("GET", "/api/traffic?lat=" + B0[0] + "&lon=" + B0[1] + "&radius_miles=50", null, "tt1");
T("taxi line cleared when airborne", tl2.aircraft.every(a => !a.has_taxi));
// ---- controller-drawn taxi route (needs a live role at the airport)
await pos("tt1", { phase: "ground", ground_speed: 0 });
const ic = hub.clients.get("tt1").pos.icao_address;
const txr = (b, m = "PUT") => call(m, "/api/atc/taxiroute" + (m === "DELETE" ? "?" + new URLSearchParams(b) : ""), m === "DELETE" ? null : b, "ctl1");
const dest = { lat: B0[0] - .0008, lon: B0[1] + 0 };
T("ctl taxiroute: no role refused", (await txr({ icao_address: ic, holder: "h1", ...dest })).error === "division_required");
await call("PUT", "/api/atc/tower", { name: "SBBR_GND", latitude: B0[0], longitude: B0[1], holder: "h1", freq: "118.000" }, "ctl1");
const pv = await txr({ icao_address: ic, holder: "h1", freq: "118.000", preview: true, ...dest });
T("ctl taxiroute: preview returns path + end", pv.success && pv.preview && pv.points.length >= 3 && pv.end && typeof pv.end.label === "string");
T("ctl taxiroute: preview does not store", !hub.clients.get("tt1").taxi || hub.clients.get("tt1").taxi.kind !== "ctl");
const sv = await txr({ icao_address: ic, holder: "h1", freq: "118.000", ...dest });
T("ctl taxiroute: send stores line, has_taxi in traffic", sv.success && hub.clients.get("tt1").taxi.kind === "ctl" && (await call("GET", "/api/traffic?lat=" + B0[0] + "&lon=" + B0[1] + "&radius_miles=50", null, "tt1")).aircraft.some(a => a.callsign === "TT1" && a.has_taxi));
T("ctl taxiroute: far click = no_destination", (await txr({ icao_address: ic, holder: "h1", freq: "118.000", lat: B0[0] + .05, lon: B0[1] + .05 })).error === "no_destination");
T("ctl taxiroute: wrong frequency refused", (await txr({ icao_address: ic, holder: "h1", freq: "121.500", ...dest })).error === "not_tuned");
await txr({ icao_address: ic, holder: "h1", freq: "118.000" }, "DELETE");
T("ctl taxiroute: delete clears", !hub.clients.get("tt1").taxi);
const dbg = await call("GET", "/api/debug?key=x", null, "x");
T("debug lists ground data source", dbg.ground && dbg.ground[0] && dbg.ground[0].src === "tiles" && dbg.ground[0].edges > 5);
// ---- profile nickname as label (public section only)
await call("PUT", "/api/profile", { nick: "Ana" }, "tt1");
let tr = await call("GET", "/api/traffic?lat=-15.87&lon=-47.92&radius_miles=50", null, "tt1");
T("public pilot carries nick", tr.aircraft.find(a => a.callsign === "TT1")?.nick === "Ana");
await call("PUT", "/api/atc/tower", { name: "SBBR", latitude: -15.87, longitude: -47.92, owner: "h1" }, "tt1");
await call("PUT", "/api/atc/tower", { name: "SBBR_GND", latitude: -15.87, longitude: -47.92, holder: "h1", freq: "121.900" }, "tt1");
tr = await call("GET", "/api/traffic?lat=-15.87&lon=-47.92&radius_miles=50", null, "tt1");
const apt = tr.aircraft.find(a => a.virtual_tower);
T("claimed role carries controller nick", apt && apt.positions.find(p => p.pos === "GND")?.nick === "Ana");
// tiles down + Overpass down -> generic reply, diagnostics keep the reason
store.clear();
const hub2 = new Hub(ctx); hub2.fetch; 
globalThis.fetch = async () => { throw new Error("offline"); };
const { fetchGraph, diag } = await import("./src/taxi.js");
const none = await fetchGraph(B0[0], B0[1]);
T("both sources down -> null + reason", none === null && /offline/.test(diag.tiles) && /offline/.test(diag.overpass));
globalThis.fetch = realFetch;
