package com.aeroflyconnect.app;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;

import java.io.File;
import java.io.FileInputStream;
import java.util.HashSet;
import java.util.Set;

/**
 * Background radio: loops an audio file the user picked in Settings (copied into app storage).
 * One shared player for the screens that want it ("pilot" service, "ctl" Controller screen, "test"
 * Settings button). It never takes audio focus, so it plays alongside the sim and Discord.
 * All work happens on the main thread; the public methods can be called from any thread.
 */
final class RadioPlayer {
    private RadioPlayer() {}

    /** Shown in the Pilot status. */
    static volatile String state = "off";

    private static final Handler h = new Handler(Looper.getMainLooper());
    private static final Set<String> owners = new HashSet<String>();
    private static Context app;
    private static MediaPlayer mp;
    private static boolean ducked;

    /** A screen wants the radio. Plays if it is enabled and a file is chosen. */
    static void start(Context c, final String owner) {
        final Context a = c.getApplicationContext();
        h.post(new Runnable() {
            @Override public void run() { app = a; owners.add(owner); open(); }
        });
    }

    /** That screen is done; the player is released when nobody is left. */
    static void stop(final String owner) {
        h.post(new Runnable() {
            @Override public void run() {
                owners.remove(owner);
                if (owners.isEmpty()) { release(); state = "off"; } else applyVolume();
            }
        });
    }

    /** Settings changed (on/off or a new file): restart if someone is listening. */
    static void settingsChanged(Context c) {
        final Context a = c.getApplicationContext();
        h.post(new Runnable() {
            @Override public void run() {
                app = a;
                if (owners.isEmpty()) return;
                release();
                open();
            }
        });
    }

    static void refreshVolume() {
        h.post(new Runnable() { @Override public void run() { applyVolume(); } });
    }

    /** Lowers the radio while a real ATC message is spoken. */
    static void duck(final boolean on) {
        h.post(new Runnable() { @Override public void run() { ducked = on; applyVolume(); } });
    }

    private static void release() {
        MediaPlayer m = mp;
        mp = null;
        if (m != null) {
            try { m.reset(); } catch (Throwable ignored) { }
            try { m.release(); } catch (Throwable ignored) { }
        }
    }

    private static void open() {
        if (mp != null || owners.isEmpty() || app == null) return;
        File f = Api.radioFile(app);
        if (!Api.radioOn(app)) { state = "off"; return; }
        if (!f.exists() || f.length() == 0) { state = "no audio file chosen"; return; }
        final MediaPlayer m = new MediaPlayer();
        mp = m;
        FileInputStream in = null;
        try {
            m.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build());
            m.setWakeMode(app, PowerManager.PARTIAL_WAKE_LOCK);
            in = new FileInputStream(f);
            m.setDataSource(in.getFD());
            m.setLooping(true);
            m.setOnPreparedListener(new MediaPlayer.OnPreparedListener() {
                @Override public void onPrepared(MediaPlayer p) {
                    if (mp != p) return;
                    applyVolume();
                    p.start();
                    state = "playing";
                }
            });
            m.setOnErrorListener(new MediaPlayer.OnErrorListener() {
                @Override public boolean onError(MediaPlayer p, int what, int extra) {
                    if (mp == p) { release(); state = "error " + what + "/" + extra + " (can't play this file)"; }
                    return true;
                }
            });
            state = "loading...";
            m.prepareAsync();
        } catch (Throwable e) {
            release();
            state = "error: " + e.getClass().getSimpleName();
        } finally {
            if (in != null) { try { in.close(); } catch (Throwable ignored) { } }
        }
    }

    private static void applyVolume() {
        MediaPlayer m = mp;
        if (m == null || app == null) return;
        int pct = owners.contains("ctl") ? Api.volCtl(app) : Api.volPilot(app);
        float v = pct / 100f * (ducked ? 0.25f : 1f);
        try { m.setVolume(v, v); } catch (Throwable ignored) { }
    }
}
