package com.aeroflyconnect.app;

import org.json.JSONObject;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * One WebSocket to the Worker (/ws). While it is open, Api.request() sends through it (same handlers as HTTP,
 * billed far less) and the server pushes traffic for the map. If it is down, everything falls back to HTTP.
 * Driven by PilotService: ensure() every loop turn, close() at the end of the flight.
 */
final class WsLink {
    private WsLink() {}

    private static final OkHttpClient CLIENT = new OkHttpClient.Builder()
            .pingInterval(25, TimeUnit.SECONDS)   // protocol pings: free, and detect a dead connection
            .connectTimeout(8, TimeUnit.SECONDS)
            .build();

    private static final class Pending {
        final CountDownLatch latch = new CountDownLatch(1);
        volatile Api.Resp resp;
    }

    private static final ConcurrentHashMap<Integer, Pending> pending = new ConcurrentHashMap<>();
    private static final AtomicInteger ids = new AtomicInteger(1);

    private static volatile WebSocket sock;
    private static volatile boolean open;
    private static volatile boolean connecting;
    private static volatile String curKey = "";
    private static long nextTry;
    private static int fails;
    // Traffic subscription state (loop thread only, except the reset in onOpen/onDown).
    private static volatile boolean subbed;
    private static double subLat, subLon;
    private static long subAt;

    static boolean live() { return open && sock != null; }

    /** Called every loop turn: (re)connects with backoff, keeps the traffic subscription in step with the map. */
    static void ensure(String key, boolean wantTraffic, double lat, double lon, long now) {
        if (!key.equals(curKey)) { close(); curKey = key; }
        if (!open && !connecting && now >= nextTry) connect(key);
        if (!open) return;
        if (wantTraffic) {
            boolean moved = Math.abs(lat - subLat) > 0.5 || Math.abs(lon - subLon) > 0.5;
            if (!subbed || moved || now - subAt > 120000) {
                WebSocket w = sock;
                if (w != null && w.send("{\"sub\":{\"lat\":" + fmt(lat) + ",\"lon\":" + fmt(lon) + ",\"radius_miles\":13000,\"max\":100}}")) {
                    subbed = true; subLat = lat; subLon = lon; subAt = now;
                }
            }
        } else if (subbed) {
            WebSocket w = sock;
            if (w != null) w.send("{\"sub\":null}");
            subbed = false;
        }
    }

    private static String fmt(double d) { return String.format(java.util.Locale.US, "%.5f", d); }

    private static void connect(String key) {
        connecting = true;
        try {
            String base = BuildConfig.SERVER_URL;
            Request r = new Request.Builder().url(base + "/ws?key=" + java.net.URLEncoder.encode(key, "UTF-8") + (Api.group.isEmpty() ? "" : "&group=" + java.net.URLEncoder.encode(Api.group, "UTF-8"))).build();
            sock = CLIENT.newWebSocket(r, new WebSocketListener() {
                @Override public void onOpen(WebSocket w, Response resp) {
                    sock = w;   // set here too: the callback can run before newWebSocket() has returned
                    fails = 0; subbed = false; open = true; connecting = false;
                }
                @Override public void onMessage(WebSocket w, String text) { handle(text); }
                @Override public void onClosing(WebSocket w, int code, String reason) { w.close(1000, null); }
                @Override public void onClosed(WebSocket w, int code, String reason) { down(w); }
                @Override public void onFailure(WebSocket w, Throwable t, Response resp) { down(w); }
            });
        } catch (Exception e) {
            connecting = false;
            backoff();
        }
    }

    private static void backoff() {
        fails++;
        nextTry = System.currentTimeMillis() + Math.min(30000L, 2000L << Math.min(fails - 1, 4));
    }

    /** Socket ended (any reason): fail waiting callers (they retry over HTTP) and schedule a reconnect. */
    private static void down(WebSocket w) {
        if (sock != null && w != sock) return;   // an old socket ending
        sock = null; open = false; connecting = false; subbed = false;
        backoff();
        for (Pending p : pending.values()) p.latch.countDown();
    }

    static void close() {
        WebSocket w = sock;
        sock = null; open = false; connecting = false; subbed = false; fails = 0; nextTry = 0;
        if (w != null) { try { w.close(1000, null); } catch (Exception ignored) { } }
        for (Pending p : pending.values()) p.latch.countDown();
    }

    private static void handle(String text) {
        if (text.equals("pong")) return;
        try {
            if (text.startsWith("{\"push\":\"traffic\"")) {
                if (PilotService.mapShown) { PilotService.trafficJson = text; PilotService.trafficAt = System.currentTimeMillis(); }
                return;
            }
            JSONObject j = new JSONObject(text);
            if (!j.has("id")) return;
            Pending p = pending.get(j.getInt("id"));
            if (p == null) return;
            Object b = j.opt("body");
            p.resp = new Api.Resp(j.optInt("status", 500), b == null || b == JSONObject.NULL ? "" : b.toString());
            p.latch.countDown();
        } catch (Exception ignored) {
        }
    }

    /** Sends one request through the socket. Returns null when the socket is not usable (caller then uses HTTP). */
    static Api.Resp request(String method, String path, String json, long timeoutMs) {
        WebSocket w = sock;
        if (!open || w == null) return null;
        int id = ids.getAndIncrement();
        Pending p = new Pending();
        pending.put(id, p);
        try {
            StringBuilder sb = new StringBuilder("{\"id\":").append(id)
                    .append(",\"method\":\"").append(method).append("\",\"path\":\"").append(path).append('"');
            if (json != null) sb.append(",\"body\":").append(json);
            sb.append('}');
            if (!w.send(sb.toString())) return null;
            if (!p.latch.await(timeoutMs, TimeUnit.MILLISECONDS) || p.resp == null) {
                if (p.resp == null && open && w == sock) { w.cancel(); down(w); }   // no answer: treat the socket as dead
                return null;
            }
            return p.resp;
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
            return null;
        } finally {
            pending.remove(id);
        }
    }
}
