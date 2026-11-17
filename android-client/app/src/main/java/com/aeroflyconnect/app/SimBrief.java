package com.aeroflyconnect.app;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;

/**
 * SimBrief import: fetches the pilot's latest OFP from the public fetcher (no API key) and fills the Flight card.
 * The route (fix list) is kept in the preferences and uploaded once after Start, only if dep/arr still match.
 */
final class SimBrief {
    private SimBrief() {}

    static final int MAX_POINTS = 150;

    /** Parsed plan. error != null means nothing usable (see ERR_* codes). */
    static final class Plan {
        String error;
        String callsign = "", dep = "", arr = "", depRwy = "", arrRwy = "", model = "", reg = "", cruise = "", route = "";
        JSONArray points = new JSONArray();   // [[lat, lon, alt_ft, ident], ...]
    }

    static final String ERR_NET = "net", ERR_USER = "user", ERR_NOPLAN = "noplan", ERR_BAD = "bad";

    interface Cb { void done(Plan p); }

    /** Fetches on a background thread; cb runs on that thread (post to the UI yourself). */
    static void fetch(final String userOrId, final Cb cb) {
        new Thread(new Runnable() {
            @Override public void run() {
                Plan p;
                try { p = parse(download(userOrId)); }
                catch (Exception e) { p = new Plan(); p.error = ERR_NET; }
                cb.done(p);
            }
        }).start();
    }

    private static String download(String u) throws Exception {
        u = u.trim();
        String q = u.matches("\\d+") ? "userid=" + u : "username=" + URLEncoder.encode(u, "UTF-8");
        HttpURLConnection c = (HttpURLConnection) new URL("https://www.simbrief.com/api/xml.fetcher.php?" + q + "&json=1").openConnection();
        try {
            c.setConnectTimeout(8000);
            c.setReadTimeout(15000);
            int code = c.getResponseCode();
            InputStream in = code < 400 ? c.getInputStream() : c.getErrorStream();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            if (in != null) {
                byte[] b = new byte[8192];
                int n;
                while ((n = in.read(b)) > 0 && out.size() < 4_000_000) out.write(b, 0, n);
                in.close();
            }
            return out.toString("UTF-8");
        } finally {
            c.disconnect();
        }
    }

    static Plan parse(String json) {
        Plan p = new Plan();
        try {
            JSONObject o = new JSONObject(json);
            JSONObject fetch = o.optJSONObject("fetch");
            String st = fetch == null ? "" : fetch.optString("status", "");
            if (!st.isEmpty() && !st.toLowerCase().startsWith("success")) {
                String l = st.toLowerCase();
                p.error = l.contains("user") || l.contains("pilot") || l.contains("id") ? ERR_USER : ERR_NOPLAN;
                if (l.contains("no flight") || l.contains("no plan")) p.error = ERR_NOPLAN;
                return p;
            }
            JSONObject origin = o.optJSONObject("origin"), dest = o.optJSONObject("destination");
            JSONObject gen = o.optJSONObject("general"), atc = o.optJSONObject("atc"), ac = o.optJSONObject("aircraft");
            if (origin == null || dest == null) { p.error = ERR_NOPLAN; return p; }
            p.dep = origin.optString("icao_code", "").toUpperCase();
            p.arr = dest.optString("icao_code", "").toUpperCase();
            p.depRwy = origin.optString("plan_rwy", "").toUpperCase();
            p.arrRwy = dest.optString("plan_rwy", "").toUpperCase();
            if (atc != null) p.callsign = atc.optString("callsign", "").toUpperCase();
            if (gen != null) {
                if (p.callsign.isEmpty()) p.callsign = (gen.optString("icao_airline", "") + gen.optString("flight_number", "")).toUpperCase();
                p.cruise = gen.optString("initial_altitude", "");
                p.route = gen.optString("route", "");
            }
            if (ac != null) { p.model = ac.optString("icaocode", "").toUpperCase(); p.reg = ac.optString("reg", "").toUpperCase(); }
            if (p.dep.isEmpty() || p.arr.isEmpty()) { p.error = ERR_NOPLAN; return p; }

            JSONObject nav = o.optJSONObject("navlog");
            Object fx = nav == null ? null : nav.opt("fix");
            JSONArray fixes = fx instanceof JSONArray ? (JSONArray) fx : new JSONArray();
            if (fx instanceof JSONObject) fixes.put(fx);
            JSONArray all = new JSONArray();
            for (int i = 0; i < fixes.length(); i++) {
                JSONObject f = fixes.optJSONObject(i);
                if (f == null) continue;
                double la = f.optDouble("pos_lat", Double.NaN), lo = f.optDouble("pos_long", Double.NaN);
                if (Double.isNaN(la) || Double.isNaN(lo)) continue;
                JSONArray pt = new JSONArray();
                pt.put(la); pt.put(lo); pt.put(f.optInt("altitude_feet", 0)); pt.put(f.optString("ident", ""));
                all.put(pt);
            }
            p.points = thin(all, MAX_POINTS);
        } catch (Exception e) {
            p.error = ERR_BAD;
        }
        return p;
    }

    /** Keeps at most max points, spread evenly, always including the first and the last. */
    static JSONArray thin(JSONArray all, int max) {
        int n = all.length();
        if (n <= max) return all;
        JSONArray out = new JSONArray();
        for (int i = 0; i < max; i++) out.put(all.opt((int) Math.round(i * (n - 1) / (double) (max - 1))));
        return out;
    }

    // ---- stored route (uploaded after Start) ----

    static void store(Context c, Plan p) {
        Api.prefs(c).edit().putString("sb_route", p.points.toString()).putString("sb_dep", p.dep).putString("sb_arr", p.arr)
                .putString("sb_text", p.route).apply();
    }

    /** JSON body for PUT /api/flightplan/route, or null if there is no stored route or it is for another dep/arr. */
    static String pendingBody(Context c) {
        try {
            String pts = Api.prefs(c).getString("sb_route", "");
            if (pts.isEmpty()) return null;
            if (!Api.prefs(c).getString("sb_dep", "").equalsIgnoreCase(Api.field(c, "dep").trim())
                    || !Api.prefs(c).getString("sb_arr", "").equalsIgnoreCase(Api.field(c, "arr").trim())) return null;
            JSONArray a = new JSONArray(pts);
            if (a.length() < 2) return null;
            JSONObject o = new JSONObject();
            o.put("points", a);
            o.put("route", Api.prefs(c).getString("sb_text", ""));
            return o.toString();
        } catch (Exception e) {
            return null;
        }
    }
}
