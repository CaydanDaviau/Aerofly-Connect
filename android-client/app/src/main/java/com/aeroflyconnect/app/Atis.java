package com.aeroflyconnect.app;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

/** Pilot-side ATIS: GET /api/atis for one airport and a short text for the overlay. Blocking, call from a background thread. */
final class Atis {
    private Atis() {}

    static final class Result {
        String letter = "";     // "" when there is no ATIS
        String text;            // ready to show
    }

    static Result fetch(Context c, String icao) {
        Result r = new Result();
        icao = icao == null ? "" : icao.trim().toUpperCase();
        if (icao.isEmpty()) { r.text = Api.t(c, "Set the departure and arrival airports in the app first.", "Defina antes os aeroportos de partida e chegada no app."); return r; }
        try {
            Api.Resp resp = Api.request("GET", "/api/atis?name=" + java.net.URLEncoder.encode(icao, "UTF-8"), null, Api.key(c));
            if (resp.code == 404) { r.text = Api.t(c, "No ATIS: no tower is open at " + icao + ".", "Sem ATIS: nenhuma torre aberta em " + icao + "."); return r; }
            if (resp.code != 200) { r.text = Api.t(c, "ATIS unavailable (HTTP " + resp.code + ").", "ATIS indisponível (HTTP " + resp.code + ")."); return r; }
            JSONObject j = new JSONObject(resp.body);
            r.letter = j.optString("letter", "A");
            StringBuilder sb = new StringBuilder();
            sb.append("ATIS ").append(r.letter).append(" · ").append(zulu(j.optLong("updated"))).append("\n");
            String rw = j.optString("runways", ""), fq = j.optString("frequencies", ""), rem = j.optString("remarks", "");
            if (!rw.isEmpty()) sb.append(Api.t(c, "Runways ", "Pistas ")).append(rw).append("\n");
            if (!fq.isEmpty()) sb.append(fq).append("\n");
            JSONObject w = j.optJSONObject("weather");
            if (w == null) sb.append(Api.t(c, "Weather not available", "Tempo indisponível")).append("\n");
            else {
                sb.append(wx(c, w)).append("\n");
                if (rw.isEmpty()) { String b = best(c, icao, w); if (!b.isEmpty()) sb.append(b).append("\n"); }
            }
            if (!rem.isEmpty()) sb.append(rem).append("\n");
            r.text = sb.toString().trim();
        } catch (Exception e) {
            r.text = Api.t(c, "ATIS: no connection.", "ATIS: sem conexão.");
        }
        return r;
    }

    private static String zulu(long ms) {
        java.text.SimpleDateFormat f = new java.text.SimpleDateFormat("HH:mm'Z'", java.util.Locale.US);
        f.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
        return f.format(new java.util.Date(ms > 0 ? ms : System.currentTimeMillis()));
    }

    private static String wx(Context c, JSONObject w) {
        StringBuilder sb = new StringBuilder();
        JSONObject wd = w.optJSONObject("wind");
        if (wd != null) {
            sb.append(Api.t(c, "Wind ", "Vento "));
            if (wd.isNull("dir")) sb.append("VRB"); else sb.append(String.format(java.util.Locale.US, "%03d°", wd.optInt("dir")));
            sb.append(" ").append(wd.optInt("spd")).append(" kt");
            if (!wd.isNull("gst")) sb.append(" G").append(wd.optInt("gst"));
            sb.append("\n");
        }
        if (!w.isNull("vis_m")) {
            int v = w.optInt("vis_m");
            sb.append("Vis ").append(v >= 9999 ? "10 km+" : v >= 1000 ? String.format(java.util.Locale.US, "%.1f km", v / 1000.0).replace(".0", "") : v + " m").append("\n");
        }
        if (w.optBoolean("cavok")) sb.append("CAVOK\n");
        else {
            JSONArray cl = w.optJSONArray("clouds");
            if (cl != null && cl.length() > 0) {
                for (int i = 0; i < cl.length(); i++) { JSONObject o = cl.optJSONObject(i); if (o != null) sb.append(o.optString("cover")).append(" ").append(o.optInt("base_ft")).append(i + 1 < cl.length() ? "  " : ""); }
                sb.append("\n");
            }
        }
        if (!w.isNull("temp")) sb.append("Temp ").append(w.optInt("temp")).append(w.isNull("dew") ? "" : "/" + w.optInt("dew")).append("°C  ");
        if (!w.isNull("qnh")) sb.append("QNH ").append(w.optInt("qnh"));
        return sb.toString().trim();
    }

    /** Runway end with the strongest headwind, from the cached OurAirports data (no download here: only if already loaded or cached). */
    private static String best(Context c, String icao, JSONObject w) {
        try {
            JSONObject wd = w.optJSONObject("wind");
            if (wd == null || wd.isNull("dir") || wd.optInt("spd") < 3) return "";
            Airports.Apt a = Airports.load(c, icao);
            if (a == null) return "";
            String id = ""; double bhw = -1e9, bxw = 0;
            for (Airports.Rwy r : a.rwys) {
                double hd = bearing(r.aLat, r.aLon, r.bLat, r.bLon);
                for (int k = 0; k < 2; k++) {
                    double h = k == 0 ? hd : (hd + 180) % 360;
                    double d = Math.toRadians(wd.optInt("dir") - h);
                    double hw = wd.optInt("spd") * Math.cos(d), xw = Math.abs(wd.optInt("spd") * Math.sin(d));
                    if (hw > bhw) { bhw = hw; bxw = xw; id = k == 0 ? r.a : r.b; }
                }
            }
            if (id == null || id.isEmpty()) return "";
            return Api.t(c, "Best into wind: ", "Melhor contra o vento: ") + id + " (HW " + Math.round(bhw) + ", XW " + Math.round(bxw) + ")";
        } catch (Exception e) {
            return "";
        }
    }

    private static double bearing(double la1, double lo1, double la2, double lo2) {
        double p1 = Math.toRadians(la1), p2 = Math.toRadians(la2), dl = Math.toRadians(lo2 - lo1);
        double y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
        return (Math.toDegrees(Math.atan2(y, x)) + 360) % 360;
    }
}
