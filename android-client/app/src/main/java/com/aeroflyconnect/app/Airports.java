package com.aeroflyconnect.app;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;

/**
 * Runways of the departure / arrival airport, from the OurAirports runways.csv (the same file the
 * radar page uses). Only the one or two airports of the flight are kept, cached in the preferences
 * for 30 days, so the big file is downloaded at most once per airport.
 */
final class Airports {
    private Airports() {}

    private static final String[] URLS = {
            "https://davidmegginson.github.io/ourairports-data/runways.csv",
            "https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/runways.csv"};
    private static final long CACHE_MS = 30L * 24 * 3600 * 1000;

    /** One runway: end A and end B (threshold position and elevation in ft, NaN when unknown). */
    static final class Rwy {
        String a, b;
        double aLat, aLon, bLat, bLon, aElev, bElev;
    }

    static final class Apt {
        final ArrayList<Rwy> rwys = new ArrayList<>();
        double lat, lon, elev = Double.NaN;

        void finish() {
            double sl = 0, sn = 0, se = 0; int n = 0, ne = 0;
            for (Rwy r : rwys) {
                sl += r.aLat + r.bLat; sn += r.aLon + r.bLon; n += 2;
                if (!Double.isNaN(r.aElev)) { se += r.aElev; ne++; }
                if (!Double.isNaN(r.bElev)) { se += r.bElev; ne++; }
            }
            if (n > 0) { lat = sl / n; lon = sn / n; }
            if (ne > 0) elev = se / ne;
        }
    }

    private static final HashMap<String, Apt> mem = new HashMap<>();
    private static final HashSet<String> failed = new HashSet<>();   // no second download attempt in this run

    /** Blocking: memory, then cache, then download. Returns null when unknown or offline. Call from a background thread. */
    static synchronized Apt load(Context c, String icao) {
        icao = icao == null ? "" : icao.trim().toUpperCase();
        if (icao.isEmpty()) return null;
        Apt a = mem.get(icao);
        if (a != null) return a;
        a = fromCache(c, icao);
        if (a == null && !failed.contains(icao)) {
            a = download(c, icao);
            if (a == null) failed.add(icao);
        }
        if (a != null) mem.put(icao, a);
        return a;
    }

    private static Apt fromCache(Context c, String icao) {
        try {
            String s = Api.prefs(c).getString("apt_" + icao, null);
            if (s == null) return null;
            JSONObject o = new JSONObject(s);
            if (System.currentTimeMillis() - o.optLong("ts") > CACHE_MS) return null;
            Apt a = new Apt();
            JSONArray arr = o.getJSONArray("r");
            for (int i = 0; i < arr.length(); i++) {
                JSONArray x = arr.getJSONArray(i);
                Rwy r = new Rwy();
                r.a = x.getString(0); r.aLat = x.getDouble(1); r.aLon = x.getDouble(2); r.aElev = x.optDouble(3, Double.NaN);
                r.b = x.getString(4); r.bLat = x.getDouble(5); r.bLon = x.getDouble(6); r.bElev = x.optDouble(7, Double.NaN);
                a.rwys.add(r);
            }
            a.finish();
            return a.rwys.isEmpty() ? null : a;
        } catch (Exception e) {
            return null;
        }
    }

    private static void toCache(Context c, String icao, Apt a) {
        try {
            JSONArray arr = new JSONArray();
            for (Rwy r : a.rwys) {
                JSONArray x = new JSONArray();
                x.put(r.a).put(r.aLat).put(r.aLon).put(Double.isNaN(r.aElev) ? JSONObject.NULL : r.aElev);
                x.put(r.b).put(r.bLat).put(r.bLon).put(Double.isNaN(r.bElev) ? JSONObject.NULL : r.bElev);
                arr.put(x);
            }
            JSONObject o = new JSONObject().put("ts", System.currentTimeMillis()).put("r", arr);
            Api.prefs(c).edit().putString("apt_" + icao, o.toString()).apply();
        } catch (Exception ignored) { }
    }

    private static Apt download(Context c, String icao) {
        for (String u : URLS) {
            HttpURLConnection cn = null;
            try {
                cn = (HttpURLConnection) new URL(u).openConnection();
                cn.setConnectTimeout(15000);
                cn.setReadTimeout(30000);
                BufferedReader in = new BufferedReader(new InputStreamReader(cn.getInputStream(), "UTF-8"));
                String head = in.readLine();
                if (head == null) continue;
                String[] hn = split(head);
                int iAp = idx(hn, "airport_ident"), iCl = idx(hn, "closed");
                int iLeId = idx(hn, "le_ident"), iLeLa = idx(hn, "le_latitude_deg"), iLeLo = idx(hn, "le_longitude_deg"), iLeEl = idx(hn, "le_elevation_ft");
                int iHeId = idx(hn, "he_ident"), iHeLa = idx(hn, "he_latitude_deg"), iHeLo = idx(hn, "he_longitude_deg"), iHeEl = idx(hn, "he_elevation_ft");
                if (iAp < 0 || iLeLa < 0 || iHeLa < 0) continue;
                String needle = "\"" + icao + "\"";
                Apt a = new Apt();
                String ln;
                while ((ln = in.readLine()) != null) {
                    if (!ln.contains(needle)) continue;   // cheap filter before parsing the line
                    String[] f = split(ln);
                    if (f.length <= iHeLo || !icao.equals(f[iAp]) || (iCl >= 0 && "1".equals(f[iCl]))) continue;
                    Rwy r = new Rwy();
                    r.a = f[iLeId]; r.b = f[iHeId];
                    r.aLat = num(f[iLeLa]); r.aLon = num(f[iLeLo]); r.bLat = num(f[iHeLa]); r.bLon = num(f[iHeLo]);
                    r.aElev = iLeEl >= 0 && iLeEl < f.length ? num(f[iLeEl]) : Double.NaN;
                    r.bElev = iHeEl >= 0 && iHeEl < f.length ? num(f[iHeEl]) : Double.NaN;
                    if (Double.isNaN(r.aLat) || Double.isNaN(r.aLon) || Double.isNaN(r.bLat) || Double.isNaN(r.bLon)) continue;
                    a.rwys.add(r);
                }
                in.close();
                if (a.rwys.isEmpty()) return null;   // file read fine but no such airport: do not try the mirror
                a.finish();
                toCache(c, icao, a);
                return a;
            } catch (Exception ignored) {
                // try the next URL
            } finally {
                if (cn != null) cn.disconnect();
            }
        }
        return null;
    }

    private static int idx(String[] h, String n) {
        for (int i = 0; i < h.length; i++) if (h[i].equals(n)) return i;
        return -1;
    }

    private static double num(String s) {
        try { return s.isEmpty() ? Double.NaN : Double.parseDouble(s); } catch (Exception e) { return Double.NaN; }
    }

    /** CSV line to fields (quotes, doubled quotes, no multi-line fields). */
    static String[] split(String l) {
        ArrayList<String> out = new ArrayList<>();
        StringBuilder f = new StringBuilder();
        boolean q = false;
        for (int i = 0; i < l.length(); i++) {
            char ch = l.charAt(i);
            if (q) {
                if (ch == '"') {
                    if (i + 1 < l.length() && l.charAt(i + 1) == '"') { f.append('"'); i++; } else q = false;
                } else f.append(ch);
            } else if (ch == '"') q = true;
            else if (ch == ',') { out.add(f.toString()); f.setLength(0); }
            else f.append(ch);
        }
        out.add(f.toString());
        return out.toArray(new String[0]);
    }
}
