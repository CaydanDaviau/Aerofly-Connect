package cloud.abflug.revival;

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
    static final String ACTION_STOP = "cloud.abflug.revival.STOP";
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

    /** Notification with Hide/Show map and Stop buttons. */
    static Notification buildNotif(Context c) {
        PendingIntent stop = PendingIntent.getService(c, 10,
                new Intent(c, PilotService.class).setAction(ACTION_STOP),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent map = PendingIntent.getActivity(c, 11,
                new Intent(c, MapActivity.class).setAction(MapActivity.ACT_TOGGLE)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(c, "pilot")
                .setContentTitle("Aerofly Connect")
                .setContentText(Api.t(c, "Sharing your position", "Compartilhando sua posição"))
                .setSmallIcon(android.R.drawable.ic_menu_mylocation)
                .setOngoing(true)
                .addAction(new Notification.Action.Builder(null, mapShown ? Api.t(c, "Hide map", "Ocultar mapa") : Api.t(c, "Show map", "Mostrar mapa"), map).build())
                .addAction(new Notification.Action.Builder(null, Api.t(c, "Stop", "Parar"), stop).build())
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

        StreamPlayer.start(this, "pilot");   // background radio (only plays if enabled in Settings)

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "revival:upload");
        wl.acquire();

        okCount = 0; failCount = 0; lastRaw = ""; hasPos = false;
        simState = "connecting..."; serverState = "-";
        running = true;
        final String key = Api.key(this);
        final String callsign = Api.callsign(this).trim().toUpperCase();
        worker = new Thread(new Runnable() {
            @Override public void run() { loop(key, callsign); }
        }, "pilot-loop");
        worker.start();
        return START_NOT_STICKY;
    }

    private void loop(String key, String callsign) {
        SimLink sim = new SimLink();
        boolean planSent = false;
        try {
            while (!stopFlag) {
                long t0 = System.currentTimeMillis();

                String raw = null;
                try {
                    if (!sim.isOpen()) sim.connect();
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
                    try {
                        // The sim sends no model/livery/squawk; the pilot types them in the app.
                        putIf(pos, "airplane_model", Api.field(this, "model"));
                        putIf(pos, "airplane_livery", Api.field(this, "livery"));
                        String sqk = Api.field(this, "squawk");
                        if (sqk.matches("\\d{4}")) pos.put("squawk", sqk);
                        // Callsign lives in the flight plan; the app sends it once, so do we.
                        if (!planSent) {
                            JSONObject plan = new JSONObject();
                            if (!callsign.isEmpty()) plan.put("callsign", callsign);
                            putIf(plan, "departure_airport", Api.field(this, "dep").toUpperCase());
                            putIf(plan, "arrival_airport", Api.field(this, "arr").toUpperCase());
                            putIf(plan, "cruise_altitude", Api.field(this, "cruise"));
                            putIf(plan, "flightplan_route", Api.field(this, "route"));
                            int pc = Api.send("PUT", "/api/flightplan", plan.toString(), key);
                            planSent = pc < 400;
                        }
                        Api.Resp r = Api.request("PUT", "/api/position", pos.toString(), key);
                        int code = r.code;
                        if (code < 400) {
                            okCount++; serverState = "OK (HTTP " + code + ")";
                            showMessages(r.body);
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
            StreamPlayer.stop("pilot");
            if (voice != null) { voice.shutdown(); voice = null; }
            try { Api.send("DELETE", "/api/position", null, key); } catch (Exception ignored) { }
            running = false;
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
    private void speak(String text, Runnable onStart) {
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
    private void showMessages(String body) {
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
                Notification.Builder b = new Notification.Builder(this, urgent ? "atc_urgent" : "atc_quiet")
                        .setContentTitle(urgent ? Api.t(this, "ATC - URGENT", "ATC - URGENTE") : "ATC")
                        .setContentText(text)
                        .setStyle(new Notification.BigTextStyle().bigText(text))
                        .setSmallIcon(android.R.drawable.ic_dialog_info)
                        .setAutoCancel(true)
                        .addAction(new Notification.Action.Builder(null, "Wilco", replyIntent(this, id, "wilco", nid)).build())
                        .addAction(new Notification.Action.Builder(null, Api.t(this, "Unable", "Impossível"), replyIntent(this, id, "unable", nid)).build());
                nm.notify(nid, b.build());
                final String fid = id; final int fnid = nid;
                // PiP Wilco/Unable buttons appear when the voice starts (or at once if it is off).
                speak(text, new Runnable() { @Override public void run() { PipReply.offer(fid, fnid); } });
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

    private static void putIf(JSONObject o, String k, String v) throws Exception {
        if (v != null && !v.trim().isEmpty()) o.put(k, v.trim());
    }

    @Override
    public void onDestroy() {
        stopFlag = true;
        if (worker != null) worker.interrupt();
        super.onDestroy();
    }
}
