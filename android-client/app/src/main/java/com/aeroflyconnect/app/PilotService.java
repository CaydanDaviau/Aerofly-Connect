package com.aeroflyconnect.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.IBinder;
import android.os.PowerManager;

import org.json.JSONArray;
import org.json.JSONObject;

/** Foreground service: reads the sim every 3 s and uploads the position to the Worker. */
public class PilotService extends Service {
    static final String ACTION_STOP = "com.aeroflyconnect.app.STOP";
    private static final long PERIOD_MS = 3000;

    // Status read by the UI.
    static volatile boolean running;
    static volatile String simState = "-";
    static volatile String serverState = "-";
    static volatile String lastRaw = "";
    static volatile int okCount, failCount;
    // Last valid sim position, read by the map screen.
    static volatile boolean hasPos;
    static volatile double lastLat, lastLon, lastHdg, lastGs, lastAlt;

    static volatile boolean mapShown;
    /** Own track, one point per upload, kept 30 min (also while the map is closed); handed to the map page when it opens. */
    private static final java.util.ArrayList<double[]> ownTrace = new java.util.ArrayList<>();
    static synchronized void addTrace(double lat, double lon, long now) {
        ownTrace.add(new double[]{lon, lat, now});
        while (!ownTrace.isEmpty() && now - (long) ownTrace.get(0)[2] > 30 * 60 * 1000L) ownTrace.remove(0);
    }
    static synchronized String traceJson() {
        if (ownTrace.isEmpty()) return null;
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < ownTrace.size(); i++) {
            double[] p = ownTrace.get(i);
            if (i > 0) sb.append(',');
            sb.append(String.format(java.util.Locale.US, "[%.5f,%.5f,%d]", p[0], p[1], (long) p[2]));
        }
        return sb.append(']').toString();
    }
    /** Last position response that carried traffic (aircraft[] + crashes[]), pushed to the map page. */
    static volatile String trafficJson; static volatile long trafficAt;
    static volatile PilotService inst;
    private Overlay overlay;

    interface ReqCb { void done(String feedback); }

    /** Notification with Hide/Show map and Stop buttons. */
    static Notification buildNotif(Context c) {
        PendingIntent stop = PendingIntent.getService(c, 10,
                new Intent(c, PilotService.class).setAction(ACTION_STOP),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent map = PendingIntent.getActivity(c, 11,
                new Intent(c, MapActivity.class).setAction(MapActivity.ACT_TOGGLE)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent req = PendingIntent.getBroadcast(c, 12,
                new Intent(c, RequestReceiver.class).setAction(RequestReceiver.ACT_MENU),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        // Without the overlay, requests go through a notification button (only when one fits the phase).
        boolean reqBtn = !Overlay.active && (Phase.clearance || Phase.taxi || Phase.takeoff || Phase.land);
        Notification.Builder nb = new Notification.Builder(c, "pilot")
                .setContentTitle("Aerofly Connect")
                .setContentText(Api.t(c, "Sharing your position", "Compartilhando sua posição"))
                .setSmallIcon(android.R.drawable.ic_menu_mylocation)
                .setOngoing(true)
                .addAction(new Notification.Action.Builder(null, mapShown ? Api.t(c, "Hide map", "Ocultar mapa") : Api.t(c, "Show map", "Mostrar mapa"), map).build());
        if (reqBtn) nb.addAction(new Notification.Action.Builder(null, Api.t(c, "ATC request", "Pedido ao ATC"), req).build());
        return nb.addAction(new Notification.Action.Builder(null, Api.t(c, "Stop", "Parar"), stop).build())
                .build();
    }

    static void refreshNotif(Context c) {
        if (!running) return;
        ((NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE)).notify(1, buildNotif(c));
    }

    private volatile boolean stopFlag;
    private Thread worker;
    private PowerManager.WakeLock wl;

    @Override
    public IBinder onBind(Intent i) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopFlag = true;
            if (worker == null) stopSelf();
            return START_NOT_STICKY;
        }
        if (worker != null) return START_NOT_STICKY;

        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        nm.createNotificationChannel(new NotificationChannel("pilot", Api.t(this, "Flight upload", "Envio do voo"), NotificationManager.IMPORTANCE_LOW));
        nm.deleteNotificationChannel("atc"); // old channel: heads-up + sound for every message
        // Normal messages: no sound, vibration or heads-up; they wait in the shade.
        NotificationChannel quiet = new NotificationChannel("atc_quiet", Api.t(this, "ATC messages", "Mensagens do ATC"), NotificationManager.IMPORTANCE_LOW);
        quiet.setSound(null, null);
        quiet.enableVibration(false);
        quiet.setShowBadge(false);
        nm.createNotificationChannel(quiet);
        // Urgent messages: heads-up pop up.
        nm.createNotificationChannel(new NotificationChannel("atc_urgent", Api.t(this, "ATC urgent messages", "Mensagens urgentes do ATC"), NotificationManager.IMPORTANCE_HIGH));
        Notification n = buildNotif(this);
        startForeground(1, n);
        // Warm up the radio voice now so the first ATC message is spoken without init delay.
        if (Api.speakOn(this)) {
            voiceLang = Api.voiceLang(this);
            voice = new AtcVoice(this, voiceLang);
        }

        inst = this;
        Phase.reset(); emergency = false; wasAir = false; fqDep = ""; fqArr = ""; contact = "";
        if (Overlay.allowed(this)) { overlay = new Overlay(this); overlay.show(); }

        RadioPlayer.start(this, "pilot");   // background radio (only plays if enabled in Settings)

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "revival:upload");
        wl.acquire();

        okCount = 0; failCount = 0; lastRaw = ""; hasPos = false;
        simState = "connecting..."; serverState = "-";
        running = true;
        final String key = Api.key(this);
        final String callsign = Api.callsign(this).trim().toUpperCase();
        // Runway data of the flight's airports (cached; a one-time download of a few MB) for the phase logic.
        final String depIcao = Api.field(this, "dep"), arrIcao = Api.field(this, "arr");
        new Thread(new Runnable() {
            @Override public void run() {
                Phase.setIcao(depIcao, arrIcao);
                Airports.Apt d = Airports.load(PilotService.this, depIcao);
                Phase.setAirports(d, null);
                Phase.setAirports(d, Airports.load(PilotService.this, arrIcao));
                fqDep = Airports.freqs(PilotService.this, depIcao);
                fqArr = Airports.freqs(PilotService.this, arrIcao);
            }
        }, "airports").start();
        worker = new Thread(new Runnable() {
            @Override public void run() { loop(key, callsign); }
        }, "pilot-loop");
        worker.start();
        return START_NOT_STICKY;
    }

    private void loop(String key, String callsign) {
        SimLink sim = new SimLink();
        final String simHost = Api.simHost(this);
        boolean planSent = false;
        try {
            while (!stopFlag) {
                long t0 = System.currentTimeMillis();

                String raw = null;
                try {
                    if (!sim.isOpen()) sim.connect(simHost);
                    raw = sim.readLine();
                    lastRaw = raw;
                    simState = "connected";
                } catch (Exception e) {
                    sim.close();
                    simState = "no sim (" + e.getClass().getSimpleName() + ")";
                }

                JSONObject pos = raw == null ? null : SimLink.toPosition(raw);
                if (raw != null && pos == null) simState = "connected, no valid position yet";

                if (pos != null) {
                    lastLat = pos.optDouble("latitude"); lastLon = pos.optDouble("longitude");
                    lastHdg = pos.optDouble("heading_true", 0); lastGs = pos.optDouble("ground_speed", 0);
                    lastAlt = pos.optDouble("altitude_ft", 0); hasPos = true;
                    addTrace(lastLat, lastLon, System.currentTimeMillis());
                    boolean airNow = Phase.phaseName.equals("air");
                    if (emergency && wasAir && !airNow) emergency = false;   // the server ends it at touchdown too
                    wasAir = airNow;
                    if (Phase.update(lastLat, lastLon, lastAlt, lastGs, lastHdg, pos.optDouble("vertical_speed_ft_min", 0), System.currentTimeMillis())) onPhase();
                    WsLink.ensure(key, mapShown, lastLat, lastLon, System.currentTimeMillis());
                    try {
                        // The sim sends no model/livery; the pilot types them in the app. Squawk is assigned by the controller.
                        putIf(pos, "airplane_model", Api.field(this, "model"));
                        putIf(pos, "airplane_livery", Api.field(this, "livery"));
                        // Shared with other players (shown when they tap this aircraft on the map).
                        if (Phase.etaMin >= 0) pos.put("eta_min", Phase.etaMin);
                        pos.put("terminal", Phase.terminal);
                        // Auto-ATC: where the aircraft is (ground / runway / air), which runway, distance to the arrival airport.
                        pos.put("phase", Phase.phaseName);
                        pos.put("lang", Api.voiceLang(this));
                        if (!fqDep.isEmpty()) pos.put("fq_dep", fqDep);
                        if (!fqArr.isEmpty()) pos.put("fq_arr", fqArr);
                        if (!Phase.rwyOn.isEmpty()) { pos.put("rwy_on", Phase.rwyOn); pos.put("rwy_apt", Phase.rwyApt); }
                        if (!Phase.onRwy.isEmpty()) pos.put("on_rwy", Phase.onRwy);
                        if (Phase.arrNm >= 0) pos.put("arr_nm", Phase.arrNm);
                        if (Phase.landingShown(System.currentTimeMillis())) pos.put("landing_fpm", Phase.landFpm);
                        // Callsign lives in the flight plan; the app sends it once, so do we.
                        if (!planSent) {
                            JSONObject plan = new JSONObject();
                            if (!callsign.isEmpty()) plan.put("callsign", callsign);
                            putIf(plan, "departure_airport", Api.field(this, "dep").toUpperCase());
                            putIf(plan, "arrival_airport", Api.field(this, "arr").toUpperCase());
                            putIf(plan, "departure_runway", Api.field(this, "deprwy").toUpperCase());
                            putIf(plan, "arrival_runway", Api.field(this, "arrrwy").toUpperCase());
                            putIf(plan, "cruise_altitude", Api.field(this, "cruise"));
                            putIf(plan, "flightplan_route", Api.field(this, "route"));
                            int pc = Api.send("PUT", "/api/flightplan", plan.toString(), key);
                            planSent = pc < 400;
                        }
                        Api.Resp r = Api.request("PUT", mapShown && !WsLink.live() ? "/api/position?traffic=1" : "/api/position", pos.toString(), key);
                        int code = r.code;
                        if (code == 423) {   // hard landing: the server grounds this pilot for a while
                            onCrashed(r.body);
                            break;
                        }
                        if (code < 400) {
                            okCount++; serverState = "OK (HTTP " + code + ")";
                            showMessages(r.body);
                            showTraffic(r.body);
                            if (mapShown && r.body.contains("\"aircraft\"")) { trafficJson = r.body; trafficAt = System.currentTimeMillis(); }
                        }
                        else { failCount++; serverState = "HTTP " + code; }
                    } catch (Exception e) {
                        failCount++;
                        serverState = "error: " + e.getClass().getSimpleName();
                    }
                }

                long wait = PERIOD_MS - (System.currentTimeMillis() - t0);
                if (wait > 0) {
                    try { Thread.sleep(wait); } catch (InterruptedException ie) { break; }
                }
            }
        } finally {
            sim.close();
            RadioPlayer.stop("pilot");
            if (voice != null) { voice.shutdown(); voice = null; }
            try { Api.send("DELETE", "/api/position", null, key); } catch (Exception ignored) { }
            WsLink.close();
            running = false;
            inst = null;
            Phase.reset();
            trafficJson = null; trafficAt = 0;
            if (overlay != null) { overlay.hide(); overlay = null; }
            PipReply.clear();
            simState = "-";
            if (wl != null && wl.isHeld()) wl.release();
            stopForeground(true);
            stopSelf();
        }
    }

    private static int nextNid = 100;
    private AtcVoice voice;
    private String voiceLang;

    /** Speaks the message with the radio effect, if "Speak" is on. Created on first use. */
    private synchronized void speak(String text, Runnable onStart) {
        if (!Api.speakOn(this)) { onStart.run(); return; }
        String lang = Api.voiceLang(this);
        if (voice == null || !lang.equals(voiceLang)) {
            if (voice != null) voice.shutdown();
            voice = new AtcVoice(this, lang);
            voiceLang = lang;
        }
        voice.speak(text, onStart);
    }

    /** The position response carries new ATC messages: one heads-up notification each. */
    synchronized void showMessages(String body) {
        try {
            JSONArray arr = new JSONObject(body).optJSONArray("messages");
            if (arr == null) return;
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject m = arr.getJSONObject(i);
                String id = m.optString("id");
                String text = m.optString("text");
                if (id.isEmpty() || text.isEmpty()) continue;
                int nid = nextNid++;
                boolean urgent = m.optBoolean("urgent", false);
                String ct = m.optString("contact");
                if (!ct.isEmpty()) { contact = ct; Overlay.poke(); }
                // Spoken normal messages get no notification (answer with the PiP buttons).
                // Urgent ones, or any message when Speak is off, pop up with Wilco / Unable.
                if (urgent || !Api.speakOn(this)) {
                    Notification.Builder b = new Notification.Builder(this, "atc_urgent")
                            .setContentTitle(urgent ? Api.t(this, "ATC - URGENT", "ATC - URGENTE") : "ATC")
                            .setContentText(text)
                            .setStyle(new Notification.BigTextStyle().bigText(text))
                            .setSmallIcon(android.R.drawable.ic_dialog_info)
                            .setAutoCancel(true)
                            .addAction(new Notification.Action.Builder(null, "Wilco", replyIntent(this, id, "wilco", nid)).build())
                            .addAction(new Notification.Action.Builder(null, Api.t(this, "Unable", "Impossível"), replyIntent(this, id, "unable", nid)).build());
                    nm.notify(nid, b.build());
                }
                final String fid = id; final int fnid = nid; final String ftext = text;
                // PiP Wilco/Unable buttons appear when the voice starts (or at once if it is off).
                speak(text, new Runnable() { @Override public void run() { PipReply.offer(fid, fnid, ftext); } });
            }
        } catch (Exception ignored) {
        }
    }

    static PendingIntent replyIntent(Context c, String id, String reply, int nid) {
        Intent i = new Intent(c, ReplyReceiver.class).setAction(ReplyReceiver.ACTION)
                .putExtra("id", id).putExtra("reply", reply).putExtra("nid", nid);
        // Distinct request code per notification and button, otherwise extras get overwritten.
        return PendingIntent.getBroadcast(c, nid * 2 + (reply.equals("wilco") ? 0 : 1), i,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** Hard landing: remember the timeout, tell the pilot, and end the flight (the loop stops right after). */
    private void onCrashed(String body) {
        long rem = 300; int fpm = 0;
        try {
            JSONObject j = new JSONObject(body);
            rem = j.optLong("remaining_s", 300); fpm = j.optInt("landing_fpm", 0);
        } catch (Exception ignored) { }
        Api.setCrashUntil(this, System.currentTimeMillis() + rem * 1000);
        stopFlag = true;
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            String text = Api.t(this, "Hard landing", "Pouso forte") + (fpm != 0 ? " (" + fpm + " ft/min)" : "") + ". "
                    + Api.t(this, "You can fly again in ", "Você poderá voar de novo em ") + Api.mmss(rem * 1000);
            nm.notify(900, new Notification.Builder(this, "atc_urgent")
                    .setContentTitle(Api.t(this, "CRASH", "ACIDENTE"))
                    .setContentText(text)
                    .setStyle(new Notification.BigTextStyle().bigText(text))
                    .setSmallIcon(android.R.drawable.ic_dialog_alert)
                    .setAutoCancel(true).build());
        } catch (Exception ignored) { }
    }

    /** Traffic advisory from the position response: spoken ("Traffic, traffic ...") and shown in the overlay. Always on. */
    private void showTraffic(String body) {
        try {
            JSONArray arr = new JSONObject(body).optJSONArray("traffic_alerts");
            if (arr == null || arr.length() == 0) return;
            JSONObject a = arr.getJSONObject(0);   // most urgent first
            int clock = a.optInt("clock", 12), dz = a.optInt("rel_alt_ft", 0), tr = a.optInt("vs_trend", 0);
            String shown = TrafficText.shown(Api.uiLang(this).equals("pt"), clock, dz, tr);
            Overlay.alert(shown);
            boolean speakOn = Api.speakOn(this);
            if (!Overlay.active || !speakOn) {   // no overlay or no voice: a heads-up notification makes sure it is seen
                NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                nm.notify(901, new Notification.Builder(this, "atc_urgent")
                        .setContentTitle(Api.t(this, "Traffic advisory", "Alerta de tráfego"))
                        .setContentText(shown)
                        .setSmallIcon(android.R.drawable.ic_dialog_alert)
                        .setTimeoutAfter(10000).build());
            }
            if (speakOn) speak(TrafficText.speech(Api.voiceLang(this).equals("pt"), clock, dz, tr), new Runnable() { @Override public void run() { } });
        } catch (Exception ignored) {
        }
    }

    /** The phase changed: redraw the overlay, or the notification button when there is no overlay. */
    private void onPhase() {
        Overlay.poke();
        if (!Overlay.active) refreshNotif(this);
    }

    /** Sends an auto-ATC request (clearance / taxi / takeoff / land) from a background thread; the answer arrives like any ATC message. */
    static void request(final Context c, final String type, final ReqCb cb) {
        final Context app = c.getApplicationContext();
        new Thread(new Runnable() {
            @Override public void run() {
                String fb;
                try {
                    JSONObject o = new JSONObject();
                    o.put("type", type);
                    o.put("lang", Api.voiceLang(app));
                    String rw = Phase.runwayFor(type);   // only a fallback: the runway typed in the flight form wins on the server
                    if (!rw.isEmpty()) o.put("runway", rw);
                    Api.Resp r = Api.request("PUT", "/api/atc/request", o.toString(), Api.key(app));
                    if (r.code < 400) {
                        PilotService s = inst;
                        if (s != null) s.showMessages(r.body);
                        if (type.equals("mayday")) emergency = true; else if (type.equals("mayday_cancel")) emergency = false;
                        if (type.equals("clearance")) {
                            Phase.markCleared();
                            PilotService s2 = inst;
                            if (s2 != null) s2.onPhase();
                        }
                        boolean tower = "controller".equals(new JSONObject(r.body).optString("mode"));
                        fb = tower ? Api.t(app, "Request sent to the tower", "Pedido enviado à torre")
                                : Api.t(app, "Request sent", "Pedido enviado");
                    } else if (r.code == 429) fb = Api.t(app, "Wait a moment", "Aguarde um momento");
                    else if (r.code == 404) fb = Api.t(app, "Not flying yet", "Voo ainda não iniciado");
                    else fb = Api.t(app, "Request failed", "Falha no pedido");
                } catch (Exception e) {
                    fb = Api.t(app, "No connection", "Sem conexão");
                }
                if (cb != null) cb.done(fb);
            }
        }, "atc-request").start();
    }

    /** Sends a free-text message to the controller from a background thread; the controller answers like any ATC message. */
    static void chat(final Context c, final String text, final ReqCb cb) {
        final Context app = c.getApplicationContext();
        new Thread(new Runnable() {
            @Override public void run() {
                String fb;
                try {
                    JSONObject o = new JSONObject();
                    o.put("text", text);
                    Api.Resp r = Api.request("PUT", "/api/atc/chat", o.toString(), Api.key(app));
                    if (r.code < 400) {
                        boolean tower = "controller".equals(new JSONObject(r.body).optString("mode"));
                        fb = tower ? Api.t(app, "Sent to ATC", "Enviado ao ATC")
                                : Api.t(app, "Sent, but no controller is online", "Enviado, mas não há controlador online");
                    } else if (r.code == 429) fb = Api.t(app, "Wait a moment", "Aguarde um momento");
                    else if (r.code == 404) fb = Api.t(app, "Not flying yet", "Voo ainda não iniciado");
                    else fb = Api.t(app, "Not sent", "Não enviado");
                } catch (Exception e) {
                    fb = Api.t(app, "No connection", "Sem conexão");
                }
                if (cb != null) cb.done(fb);
            }
        }, "atc-chat").start();
    }

    /** Mayday declared and not yet cancelled (cleared at Start and when the aircraft lands). */
    static volatile boolean emergency;
    static volatile String fqDep = "", fqArr = "";
    /** Controller named in the last handoff ("Departure 119.5"); shown in the overlay status line. */
    static volatile String contact = "";
    private boolean wasAir;

    private static void putIf(JSONObject o, String k, String v) throws Exception {
        if (v != null && !v.trim().isEmpty()) o.put(k, v.trim());
    }

    @Override
    public void onDestroy() {
        stopFlag = true;
        if (overlay != null) overlay.hide();
        if (worker != null) worker.interrupt();
        super.onDestroy();
    }
}
