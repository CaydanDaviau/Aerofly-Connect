package cloud.abflug.revival;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;

/**
 * Link to the sim: TCP 127.0.0.1:58585, send "req_gmap_dat\n", read one '|'-separated line.
 *
 * FIELD ORDER BELOW IS A PLACEHOLDER (not yet verified against a real sim line).
 * Fix the indices in F_* once a real raw line is known; nothing else needs to change.
 * If the first token is not a number (a header such as "gmap_dat"), it is skipped.
 */
final class SimLink {
    // Indices after the optional header token is skipped.
    static final int F_LAT = 0, F_LON = 1, F_ALT_FT = 2, F_HDG = 3, F_GS = 4, F_VS = 5,
            F_SQUAWK = 6, F_MODEL = 7, F_LIVERY = 8;

    private Socket socket;
    private BufferedReader in;
    private OutputStream out;

    void connect() throws Exception {
        close();
        Socket s = new Socket();
        s.connect(new InetSocketAddress("127.0.0.1", 58585), 1500);
        s.setSoTimeout(2000);
        socket = s;
        in = new BufferedReader(new InputStreamReader(s.getInputStream()));
        out = s.getOutputStream();
    }

    boolean isOpen() {
        return socket != null && socket.isConnected() && !socket.isClosed();
    }

    /** One request/response. Returns the raw line, or throws if the link is dead. */
    String readLine() throws Exception {
        out.write("req_gmap_dat\n".getBytes("US-ASCII"));
        out.flush();
        String line = in.readLine();
        if (line == null) throw new java.io.IOException("sim closed the connection");
        return line;
    }

    void close() {
        try { if (socket != null) socket.close(); } catch (Exception ignored) { }
        socket = null; in = null; out = null;
    }

    private static Double num(String s) {
        try { return Double.valueOf(s.trim()); } catch (Exception e) { return null; }
    }

    private static String at(String[] f, int i) {
        return i < f.length ? f[i].trim() : "";
    }

    /** Builds the /api/position JSON, or null if the line has no plausible position. */
    static JSONObject toPosition(String raw) {
        String[] f = raw.split("\\|");
        int off = 0;
        if (f.length > 0 && num(f[0]) == null) off = 1;
        if (f.length - off <= F_LON) return null;
        Double lat = num(at(f, off + F_LAT)), lon = num(at(f, off + F_LON));
        if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
        if (lat == 0 && lon == 0) return null;
        try {
            JSONObject o = new JSONObject();
            o.put("latitude", lat);
            o.put("longitude", lon);
            Double v;
            if ((v = num(at(f, off + F_ALT_FT))) != null) o.put("altitude_ft", Math.round(v));
            if ((v = num(at(f, off + F_HDG))) != null) o.put("heading_true", Math.round(v));
            if ((v = num(at(f, off + F_GS))) != null) o.put("ground_speed", Math.round(v));
            if ((v = num(at(f, off + F_VS))) != null) o.put("vertical_speed_ft_min", Math.round(v));
            String sq = at(f, off + F_SQUAWK);
            if (sq.matches("\\d{4}")) o.put("squawk", sq);
            String m = at(f, off + F_MODEL), l = at(f, off + F_LIVERY);
            if (!m.isEmpty() && num(m) == null) o.put("airplane_model", m);
            if (!l.isEmpty() && num(l) == null) o.put("airplane_livery", l);
            return o;
        } catch (Exception e) {
            return null;
        }
    }
}
