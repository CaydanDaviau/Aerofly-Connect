package com.aeroflyconnect.app;

import android.content.Context;
import android.content.SharedPreferences;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.SecureRandom;

/** Server access + persistent identity (auto-generated key, callsign). */
final class Api {
    private Api() {}

    private static final String PREFS = "revival";

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Key is created once on first run. No account needed. */
    static String key(Context c) {
        SharedPreferences p = prefs(c);
        String k = p.getString("key", null);
        if (k == null) {
            byte[] b = new byte[8];
            new SecureRandom().nextBytes(b);
            StringBuilder sb = new StringBuilder("rv");
            for (byte x : b) sb.append(String.format("%02x", x));
            k = sb.toString();
            p.edit().putString("key", k).apply();
        }
        return k;
    }

    static String callsign(Context c) {
        return prefs(c).getString("callsign", "");
    }

    static void setCallsign(Context c, String cs) {
        prefs(c).edit().putString("callsign", cs).apply();
    }

    /** Pilot form fields: dep, arr, model, livery, cruise, route. */
    /** Host of the sim link (field "simip"; empty = this phone). */
    static String simHost(Context c) { return simRemote(c) ? SimHost.normalize(field(c, "simip")) : SimHost.LOCAL; }
    static boolean simRemote(Context c) { return prefs(c).getBoolean("sim_remote", false); }
    static void setSimRemote(Context c, boolean on) { prefs(c).edit().putBoolean("sim_remote", on).apply(); }

    static String field(Context c, String name) {
        return prefs(c).getString("f_" + name, "");
    }

    static void setField(Context c, String name, String v) {
        prefs(c).edit().putString("f_" + name, v).apply();
    }

    private static String deviceLang() {
        return java.util.Locale.getDefault().getLanguage().equals("pt") ? "pt" : "en";
    }

    /** App UI language: "en" or "pt" (Português BR). Defaults to the device language. */
    static String uiLang(Context c) { return prefs(c).getString("ui_lang", deviceLang()); }
    static void setUiLang(Context c, String l) { prefs(c).edit().putString("ui_lang", l).apply(); }

    /** Language of the spoken ATC messages: "en" or "pt". */
    static String voiceLang(Context c) { return prefs(c).getString("voice_lang", deviceLang()); }
    static void setVoiceLang(Context c, String l) { prefs(c).edit().putString("voice_lang", l).apply(); }

    /** Speak ATC messages (on by default). */
    static boolean speakOn(Context c) { return prefs(c).getBoolean("speak", true); }
    static void setSpeakOn(Context c, boolean on) { prefs(c).edit().putBoolean("speak", on).apply(); }

    /** Floating ATC overlay (requests + Wilco/Unable): on by default, needs the "display over other apps" permission. */
    /** Crash timeout (hard landing): epoch ms until the pilot may fly again; 0 = none. */
    static long crashUntil(Context c) { return prefs(c).getLong("crash_until", 0); }
    static void setCrashUntil(Context c, long t) { prefs(c).edit().putLong("crash_until", t).apply(); }
    static long crashLeftMs(Context c) { return Math.max(0, crashUntil(c) - System.currentTimeMillis()); }
    static String mmss(long ms) { long s = (ms + 999) / 1000; return (s / 60) + ":" + (s % 60 < 10 ? "0" : "") + (s % 60); }

    /** Voice chat (push-to-talk, both directions); default on. */
    static boolean voiceOn(Context c) { return prefs(c).getBoolean("voice_on", true); }
    static void setVoiceOn(Context c, boolean on) { prefs(c).edit().putBoolean("voice_on", on).apply(); }

    static boolean overlayOn(Context c) { return prefs(c).getBoolean("overlay_on", true); }
    static void setOverlayOn(Context c, boolean on) { prefs(c).edit().putBoolean("overlay_on", on).apply(); }

    /** Speech speed: 0 slow, 1 normal, 2 fast. */
    private static final float[] RATES = {0.85f, 1.0f, 1.2f};
    static int rateIdx(Context c) { return Math.max(0, Math.min(2, prefs(c).getInt("rate_idx", 1))); }
    static void setRateIdx(Context c, int i) { prefs(c).edit().putInt("rate_idx", i).apply(); }
    static float speechRate(Context c) { return RATES[rateIdx(c)]; }

    /** Chosen TTS voice name for the voice language; empty = automatic. */
    static String voiceName(Context c) { return prefs(c).getString("voice_name", ""); }
    static void setVoiceName(Context c, String n) { prefs(c).edit().putString("voice_name", n).apply(); }

    /** Background radio: on/off and the chosen audio file's display name (the file itself is copied into app storage). */
    static boolean radioOn(Context c) { return prefs(c).getBoolean("radio_on", false); }
    static void setRadioOn(Context c, boolean on) { prefs(c).edit().putBoolean("radio_on", on).apply(); }
    static String radioName(Context c) { return prefs(c).getString("radio_name", ""); }
    static void setRadioName(Context c, String n) { prefs(c).edit().putString("radio_name", n).apply(); }
    static java.io.File radioFile(Context c) { return new java.io.File(c.getFilesDir(), "radio_loop"); }
    /** Volume (0-100) for Pilot and Controller. */
    static int volPilot(Context c) { return prefs(c).getInt("vol_pilot", 25); }
    static void setVolPilot(Context c, int v) { prefs(c).edit().putInt("vol_pilot", v).apply(); }
    static int volCtl(Context c) { return prefs(c).getInt("vol_ctl", 50); }
    static void setVolCtl(Context c, int v) { prefs(c).edit().putInt("vol_ctl", v).apply(); }

    /** Picks the English or Portuguese text according to the app UI language. */
    static String t(Context c, String en, String pt) { return uiLang(c).equals("pt") ? pt : en; }

    /** HTTP status code and (small) response body. */
    static final class Resp {
        final int code;
        final String body;
        Resp(int code, String body) { this.code = code; this.body = body; }
    }

    /** Returns HTTP status code; body is ignored. Throws on network failure. */
    static int send(String method, String path, String json, String key) throws Exception {
        return request(method, path, json, key).code;
    }

    /** Like send, but also returns the response body. Throws on network failure. */
    static Resp request(String method, String path, String json, String key) throws Exception {
        if (WsLink.live()) {   // WebSocket first (only open during a flight); null = unusable -> HTTP below
            Resp w = WsLink.request(method, path, json, 6000);
            if (w != null) return w;
        }
        HttpURLConnection c = (HttpURLConnection) new URL(BuildConfig.SERVER_URL + path).openConnection();
        try {
            c.setRequestMethod(method);
            c.setConnectTimeout(6000);
            c.setReadTimeout(6000);
            c.setRequestProperty("X-API-Key", key);
            if (json != null) {
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                OutputStream o = c.getOutputStream();
                o.write(json.getBytes("UTF-8"));
                o.close();
            }
            int code = c.getResponseCode();
            InputStream in = code < 400 ? c.getInputStream() : c.getErrorStream();
            StringBuilder sb = new StringBuilder();
            if (in != null) {
                BufferedReader r = new BufferedReader(new InputStreamReader(in, "UTF-8"));
                String ln;
                while ((ln = r.readLine()) != null && sb.length() < 65536) sb.append(ln);
                r.close();
            }
            return new Resp(code, sb.toString());
        } finally {
            c.disconnect();
        }
    }
}
