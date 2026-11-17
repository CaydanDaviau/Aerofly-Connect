// Flight phase from the sim position + runway data of the departure/arrival airport. Port of Android Phase.java.
const NM = 1852.0, rad = d => d * Math.PI / 180;
const dxM = (la1, lo1, la2, lo2) => (lo2 - lo1) * 111320.0 * Math.cos(rad((la1 + la2) / 2));
const dyM = (la1, la2) => (la2 - la1) * 110540.0;
const distNm = (la1, lo1, la2, lo2) => Math.hypot(dxM(la1, lo1, la2, lo2), dyM(la1, la2)) / NM;
const bearing = (la1, lo1, la2, lo2) => (Math.atan2(dxM(la1, lo1, la2, lo2), dyM(la1, la2)) * 180 / Math.PI + 360) % 360;
const angDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
function distToSegM(pla, plo, ala, alo, bla, blo) {
  const bx = dxM(ala, alo, bla, blo), by = dyM(ala, bla), px = dxM(ala, alo, pla, plo), py = dyM(ala, pla), len2 = bx * bx + by * by;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  return Math.hypot(px - t * bx, py - t * by);
}

class Phase {
  constructor() { this.depIcao = ""; this.arrIcao = ""; this.dep = null; this.arr = null; this.reset(); }
  reset() {
    this.init = false; this.airborne = false; this.cleared = false; this.slowSince = 0;
    this.clearance = this.taxi = this.takeoff = this.land = this.terminal = false;
    this.etaMin = -1; this.landFpm = 0; this.landUntil = 0; this.candAt = 0; this.candFpm = 0;
    this.phaseName = "ground"; this.rwyOn = ""; this.onRwy = ""; this.rwyApt = ""; this.arrNm = -1;
    this.groundAlt = 0; this.lat = 0; this.lon = 0; this.hdg = 0;
  }
  setIcao(d, a) { this.depIcao = String(d || "").trim().toUpperCase(); this.arrIcao = String(a || "").trim().toUpperCase(); }
  setAirports(d, a) { this.dep = d || null; this.arr = a || null; }
  markCleared() { this.cleared = true; this.clearance = false; }
  landingShown(now) { return now < this.landUntil; }

  localGround(la, lo) {
    if (this.dep && Number.isFinite(this.dep.elev) && distNm(la, lo, this.dep.lat, this.dep.lon) <= 5) return this.dep.elev;
    if (this.arr && Number.isFinite(this.arr.elev) && distNm(la, lo, this.arr.lat, this.arr.lon) <= 5) return this.arr.elev;
    return NaN;
  }

  // Returns true when the set of offered requests changed.
  update(la, lo, altFt, gsKt, hdgTrue, vs, now) {
    const dep = this.dep, arr = this.arr;
    this.lat = la; this.lon = lo; this.hdg = hdgTrue;
    if (!this.init) { this.init = true; this.groundAlt = altFt; this.airborne = gsKt >= 80; }
    if (gsKt < 30) {
      if (this.slowSince === 0) this.slowSince = now;
      const lg = this.localGround(la, lo), low = Number.isNaN(lg) || altFt - lg < 300;
      if (now - this.slowSince > 20000 && low) { this.airborne = false; this.groundAlt = altFt; }
    } else this.slowSince = 0;
    if (!this.airborne && gsKt >= 60 && altFt - this.groundAlt > 250) this.airborne = true;
    if (this.airborne) this.cleared = false;

    const nearDep = !dep || distNm(la, lo, dep.lat, dep.lon) <= 5;
    const lined = !!dep && nearDep && this.linedUp() !== null;
    const cl = !this.airborne && !this.cleared && gsKt < 40 && nearDep && !lined;
    const t = !this.airborne && gsKt < 40 && nearDep && !lined;
    // Take off is offered lined up AND holding short (near a runway, slow), so the clearance can be asked before entering it.
    const o = !this.airborne && gsKt < 60 && nearDep && (!dep || lined || (gsKt < 40 && this.holdShort() !== null));
    const l = this.airborne && (!arr || distNm(la, lo, arr.lat, arr.lon) <= 30);

    if (this.airborne && arr && gsKt >= 60) this.etaMin = Math.min(5999, Math.round(distNm(la, lo, arr.lat, arr.lon) / gsKt * 60));
    else this.etaMin = -1;
    if (this.airborne && arr && Number.isFinite(arr.elev) && distNm(la, lo, arr.lat, arr.lon) <= 5) {
      const agl = altFt - arr.elev;
      if (agl < 200 && vs < -50) { this.candFpm = vs; this.candAt = now; }
      const touched = agl <= 25 || (this.candAt !== 0 && vs > -50 && agl < 100);
      if (touched && this.candAt !== 0 && now - this.candAt < 15000) { this.landFpm = Math.round(this.candFpm); this.landUntil = now + 120000; this.candAt = 0; }
    }
    if (this.airborne && arr && Number.isFinite(arr.elev) && distNm(la, lo, arr.lat, arr.lon) <= 5 && altFt - arr.elev <= 40 && vs > -2500) {
      this.airborne = false; this.groundAlt = altFt; this.slowSince = 0;
    }
    this.arrNm = arr ? Math.round(distNm(la, lo, arr.lat, arr.lon) * 10) / 10 : -1;
    let pair = "", lined2 = "", apt = "";
    if (!this.airborne) {
      const aps = [dep, arr], ic = [this.depIcao, this.arrIcao];
      scan: for (let i = 0; i < 2; i++) {
        if (!aps[i]) continue;
        for (const r of aps[i].rwys) {
          if (distToSegM(la, lo, r.aLat, r.aLon, r.bLat, r.bLon) > 60) continue;
          pair = r.a + "/" + r.b; apt = ic[i];
          for (let e = 0; e < 2; e++) {
            const tl = e === 0 ? r.aLat : r.bLat, tn = e === 0 ? r.aLon : r.bLon, ol = e === 0 ? r.bLat : r.aLat, on = e === 0 ? r.bLon : r.aLon;
            if (angDiff(bearing(tl, tn, ol, on), hdgTrue) <= 25) { lined2 = e === 0 ? r.a : r.b; break; }
          }
          break scan;
        }
      }
    }
    this.rwyOn = pair; this.onRwy = lined2; this.rwyApt = apt;
    this.phaseName = this.airborne ? "air" : (pair ? "runway" : "ground");
    this.terminal = (!!dep && distNm(la, lo, dep.lat, dep.lon) <= 6) || (!!arr && distNm(la, lo, arr.lat, arr.lon) <= 8);
    const changed = cl !== this.clearance || t !== this.taxi || o !== this.takeoff || l !== this.land;
    this.clearance = cl; this.taxi = t; this.takeoff = o; this.land = l;
    return changed;
  }

  // Runway ident for a request when the form field is empty ("" = unknown). type: "takeoff" | "land" | "taxi".
  runwayFor(type) {
    if (type === "takeoff") return this.linedUp() || this.holdShort() || "";
    if (type === "land" && this.arr) {
      let best = "", bd = 1e9;
      for (const r of this.arr.rwys) for (let e = 0; e < 2; e++) {
        const tl = e === 0 ? r.aLat : r.bLat, tn = e === 0 ? r.aLon : r.bLon, ol = e === 0 ? r.bLat : r.aLat, on = e === 0 ? r.bLon : r.aLon;
        const rh = bearing(tl, tn, ol, on), d = distNm(this.lat, this.lon, tl, tn);
        const aligned = angDiff(rh, this.hdg) <= 45, behind = angDiff(bearing(tl, tn, this.lat, this.lon), (rh + 180) % 360) <= 45;
        if (aligned && behind && d < bd) { bd = d; best = e === 0 ? r.a : r.b; }
      }
      return best;
    }
    return "";
  }

  // Holding short: within 200 m of a departure runway. Returns the end best aligned with the heading, or null.
  holdShort() {
    if (!this.dep) return null;
    let best = null, bd = 1e9;
    for (const r of this.dep.rwys) {
      const dm = distToSegM(this.lat, this.lon, r.aLat, r.aLon, r.bLat, r.bLon);
      if (dm <= 60 || dm > 200) continue;   // on the runway = rwyOn logic; beyond 200 m = just taxiing
      for (let e = 0; e < 2; e++) {
        const tl = e === 0 ? r.aLat : r.bLat, tn = e === 0 ? r.aLon : r.bLon, ol = e === 0 ? r.bLat : r.aLat, on = e === 0 ? r.bLon : r.aLon;
        const d = angDiff(bearing(tl, tn, ol, on), this.hdg);
        if (d < bd) { bd = d; best = e === 0 ? r.a : r.b; }
      }
    }
    return best;
  }

  linedUp() {
    if (!this.dep) return null;
    for (const r of this.dep.rwys) for (let e = 0; e < 2; e++) {
      const tl = e === 0 ? r.aLat : r.bLat, tn = e === 0 ? r.aLon : r.bLon, ol = e === 0 ? r.bLat : r.aLat, on = e === 0 ? r.bLon : r.aLon;
      if (angDiff(bearing(tl, tn, ol, on), this.hdg) <= 25 && distToSegM(this.lat, this.lon, r.aLat, r.aLon, r.bLat, r.bLon) <= 60) return e === 0 ? r.a : r.b;
    }
    return null;
  }

  // Extra fields for every position upload (same as Android PilotService).
  fields(now) {
    const o = { terminal: this.terminal, phase: this.phaseName };
    if (this.etaMin >= 0) o.eta_min = this.etaMin;
    if (this.rwyOn) { o.rwy_on = this.rwyOn; o.rwy_apt = this.rwyApt; }
    if (this.onRwy) o.on_rwy = this.onRwy;
    if (this.arrNm >= 0) o.arr_nm = this.arrNm;
    if (this.landingShown(now)) o.landing_fpm = this.landFpm;
    return o;
  }
}

module.exports = { Phase, distNm, bearing, angDiff, distToSegM };
