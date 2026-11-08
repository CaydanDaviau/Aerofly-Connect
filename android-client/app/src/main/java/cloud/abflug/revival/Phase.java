package cloud.abflug.revival;

/**
 * Flight phase from the sim line (position, altitude, ground speed, heading) and the runway data of
 * the departure / arrival airport. Decides which ATC requests make sense right now:
 * Taxi (stopped or slow on the ground), Take off (lined up on a runway), Land (airborne, near the
 * arrival airport). Without airport data it falls back to speed / altitude rules only.
 * Fed from the service thread only; the flags are read by the overlay and the notification.
 */
final class Phase {
    private Phase() {}

    static volatile boolean clearance, taxi, takeoff, land;

    private static Airports.Apt dep, arr;
    private static boolean init, airborne, cleared;
    private static double groundAlt, lat, lon, hdg;
    private static long slowSince;

    static final double NM = 1852.0;

    static synchronized void reset() {
        dep = null; arr = null; init = false; airborne = false; cleared = false; slowSince = 0;
        clearance = false; taxi = false; takeoff = false; land = false;
    }

    /** The pilot got (or asked for) the clearance: the Clearance button dims until the next departure. */
    static synchronized void markCleared() { cleared = true; clearance = false; }

    static synchronized void setAirports(Airports.Apt d, Airports.Apt a) { dep = d; arr = a; }

    /** Feeds one sample. Returns true when the set of offered requests changed. */
    static synchronized boolean update(double la, double lo, double altFt, double gsKt, double hdgTrue, long now) {
        lat = la; lon = lo; hdg = hdgTrue;
        if (!init) { init = true; groundAlt = altFt; airborne = gsKt >= 80; }

        boolean slow = gsKt < 30;
        if (slow) {
            if (slowSince == 0) slowSince = now;
            double lg = localGround(la, lo);
            boolean low = Double.isNaN(lg) || altFt - lg < 300;
            if (now - slowSince > 20000 && low) { airborne = false; groundAlt = altFt; }
        } else slowSince = 0;
        if (!airborne && gsKt >= 60 && altFt - groundAlt > 250) airborne = true;
        if (airborne) cleared = false;   // next departure starts with a new clearance

        boolean nearDep = dep == null || distNm(la, lo, dep.lat, dep.lon) <= 5;
        boolean lined = dep != null && nearDep && linedUp() != null;
        boolean cl = !airborne && !cleared && gsKt < 40 && nearDep && !lined;
        boolean t = !airborne && gsKt < 40 && nearDep && !lined;
        boolean o = !airborne && gsKt < 60 && nearDep && (dep == null || lined);
        boolean l = airborne && (arr == null || distNm(la, lo, arr.lat, arr.lon) <= 30);

        boolean changed = cl != clearance || t != taxi || o != takeoff || l != land;
        clearance = cl; taxi = t; takeoff = o; land = l;
        return changed;
    }

    /** Runway ident to put in a request when the pilot left the runway field empty ("" = unknown). */
    static synchronized String runwayFor(String type) {
        if (type.equals("takeoff")) {
            String r = linedUp();
            return r == null ? "" : r;
        }
        if (type.equals("land") && arr != null) {
            String best = ""; double bd = 1e9;
            for (Airports.Rwy r : arr.rwys) {
                for (int e = 0; e < 2; e++) {
                    double tl = e == 0 ? r.aLat : r.bLat, tn = e == 0 ? r.aLon : r.bLon;
                    double ol = e == 0 ? r.bLat : r.aLat, on = e == 0 ? r.bLon : r.aLon;
                    double rh = bearing(tl, tn, ol, on);                  // landing direction on this end
                    double d = distNm(lat, lon, tl, tn);
                    boolean aligned = angDiff(rh, hdg) <= 45;
                    boolean behind = angDiff(bearing(tl, tn, lat, lon), (rh + 180) % 360) <= 45;   // approaching from the threshold side
                    if (aligned && behind && d < bd) { bd = d; best = e == 0 ? r.a : r.b; }
                }
            }
            return best;
        }
        return "";
    }

    /** The runway end the aircraft is lined up on (on the centre line, pointing along it), or null. */
    private static String linedUp() {
        if (dep == null) return null;
        for (Airports.Rwy r : dep.rwys) {
            for (int e = 0; e < 2; e++) {
                double tl = e == 0 ? r.aLat : r.bLat, tn = e == 0 ? r.aLon : r.bLon;
                double ol = e == 0 ? r.bLat : r.aLat, on = e == 0 ? r.bLon : r.aLon;
                if (angDiff(bearing(tl, tn, ol, on), hdg) <= 25 && distToSegM(lat, lon, r.aLat, r.aLon, r.bLat, r.bLon) <= 60)
                    return e == 0 ? r.a : r.b;
            }
        }
        return null;
    }

    /** Elevation of the departure / arrival airport when the aircraft is within 5 nm of it, else NaN. */
    private static double localGround(double la, double lo) {
        if (dep != null && !Double.isNaN(dep.elev) && distNm(la, lo, dep.lat, dep.lon) <= 5) return dep.elev;
        if (arr != null && !Double.isNaN(arr.elev) && distNm(la, lo, arr.lat, arr.lon) <= 5) return arr.elev;
        return Double.NaN;
    }

    // ---------- geometry (flat-earth maths is fine at airport scale) ----------
    static double distNm(double la1, double lo1, double la2, double lo2) {
        return Math.hypot(dxM(la1, lo1, la2, lo2), dyM(la1, la2)) / NM;
    }

    private static double dxM(double la1, double lo1, double la2, double lo2) {
        return (lo2 - lo1) * 111320.0 * Math.cos(Math.toRadians((la1 + la2) / 2));
    }

    private static double dyM(double la1, double la2) { return (la2 - la1) * 110540.0; }

    static double bearing(double la1, double lo1, double la2, double lo2) {
        double b = Math.toDegrees(Math.atan2(dxM(la1, lo1, la2, lo2), dyM(la1, la2)));
        return (b + 360) % 360;
    }

    static double angDiff(double a, double b) {
        double d = Math.abs(a - b) % 360;
        return d > 180 ? 360 - d : d;
    }

    /** Distance in metres from point p to the segment a-b. */
    static double distToSegM(double pla, double plo, double ala, double alo, double bla, double blo) {
        double bx = dxM(ala, alo, bla, blo), by = dyM(ala, bla);
        double px = dxM(ala, alo, pla, plo), py = dyM(ala, pla);
        double len2 = bx * bx + by * by;
        double t = len2 == 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / len2));
        return Math.hypot(px - t * bx, py - t * by);
    }
}
