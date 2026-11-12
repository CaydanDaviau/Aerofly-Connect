package com.aeroflyconnect.app;

import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.Collections;

/**
 * Aerofly FS on a PC: the sim sends UDP datagrams (ForeFlight format) to this phone, port 49002.
 *   XGPS<name>,<lon>,<lat>,<alt m>,<track deg>,<gs m/s>
 *   XATT<name>,<true heading>,<pitch>,<roll>
 * No vertical speed is sent, so it is derived from the altitude change.
 */
final class PcLink {
    static final int PORT = 49002;
    private static final double M_TO_FT = 3.28084, MS_TO_KT = 1.943844;

    private volatile boolean run;
    private volatile String error;
    private DatagramSocket sock;
    private Thread th;

    private volatile double lat, lon, altFt, track, gsKt, hdg = Double.NaN;
    private volatile long gpsAt;
    private double vsFt; private double lastAlt = Double.NaN; private long lastAltAt;

    void start() {
        run = true;
        th = new Thread(new Runnable() { @Override public void run() { loop(); } }, "pc-udp");
        th.start();
    }

    void stop() {
        run = false;
        try { if (sock != null) sock.close(); } catch (Exception ignored) { }
    }

    String error() { return error; }

    private void loop() {
        try {
            DatagramSocket s = new DatagramSocket(null);
            s.setReuseAddress(true);
            s.bind(new java.net.InetSocketAddress(PORT));
            s.setSoTimeout(1000);
            sock = s;
            byte[] buf = new byte[1024];
            while (run) {
                DatagramPacket p = new DatagramPacket(buf, buf.length);
                try { s.receive(p); } catch (java.net.SocketTimeoutException e) { continue; }
                handle(new String(p.getData(), 0, p.getLength(), "US-ASCII").trim());
            }
        } catch (Exception e) {
            if (run) error = e.getClass().getSimpleName();
        }
    }

    private void handle(String t) {
        try {
            String[] f = t.split(",");
            if (t.startsWith("XGPS") && f.length >= 6) {
                double lo = Double.parseDouble(f[1]), la = Double.parseDouble(f[2]);
                double alt = Double.parseDouble(f[3]) * M_TO_FT;
                long now = System.currentTimeMillis();
                if (!Double.isNaN(lastAlt) && now - lastAltAt >= 800) {
                    double v = (alt - lastAlt) * 60000.0 / (now - lastAltAt);
                    vsFt = vsFt * 0.6 + v * 0.4;
                    lastAlt = alt; lastAltAt = now;
                } else if (Double.isNaN(lastAlt)) { lastAlt = alt; lastAltAt = now; }
                lon = lo; lat = la; altFt = alt;
                track = Double.parseDouble(f[4]); gsKt = Double.parseDouble(f[5]) * MS_TO_KT;
                gpsAt = now;
            } else if (t.startsWith("XATT") && f.length >= 2) {
                hdg = Double.parseDouble(f[1]);
            }
        } catch (Exception ignored) { }
    }

    /** Latest position, or null if nothing arrived in the last 3 s. */
    JSONObject position() {
        if (System.currentTimeMillis() - gpsAt > 3000) return null;
        if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat == 0 && lon == 0)) return null;
        try {
            JSONObject o = new JSONObject();
            o.put("latitude", lat);
            o.put("longitude", lon);
            o.put("altitude_ft", Math.round(altFt));
            o.put("heading_true", Math.round(Double.isNaN(hdg) ? track : hdg));
            o.put("ground_speed", Math.round(gsKt));
            o.put("vertical_speed_ft_min", Math.round(vsFt));
            return o;
        } catch (Exception e) {
            return null;
        }
    }

    /** This phone's Wi-Fi / hotspot IPv4 address, for typing into the PC sim; "" if unknown. */
    static String localIp() {
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                String n = ni.getName();
                if (!(n.startsWith("wlan") || n.startsWith("ap") || n.startsWith("swlan"))) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses()))
                    if (a instanceof Inet4Address && !a.isLoopbackAddress()) return a.getHostAddress();
            }
        } catch (Exception ignored) { }
        return "";
    }
}
