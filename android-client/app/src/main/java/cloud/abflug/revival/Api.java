package cloud.abflug.revival;

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

    /** Pilot form fields: dep, arr, model, livery, cruise, squawk, route. */
    static String field(Context c, String name) {
        return prefs(c).getString("f_" + name, "");
    }

    static void setField(Context c, String name, String v) {
        prefs(c).edit().putString("f_" + name, v).apply();
    }

    /** Returns HTTP status code; body is ignored. Throws on network failure. */
    static int send(String method, String path, String json, String key) throws Exception {
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
            if (in != null) {
                BufferedReader r = new BufferedReader(new InputStreamReader(in));
                while (r.readLine() != null) { /* drain */ }
                r.close();
            }
            return code;
        } finally {
            c.disconnect();
        }
    }
}
