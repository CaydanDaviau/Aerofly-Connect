package cloud.abflug.revival;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;

import java.util.HashSet;
import java.util.Set;

/**
 * Background radio stream (a URL the user pastes in Settings). One shared player for the screens that
 * want it ("pilot" service, "ctl" Controller screen, "test" Settings button). It never takes audio
 * focus, so it plays alongside the sim and Discord. Reconnects every 5 s when the stream drops.
 * All work happens on the main thread; the public methods can be called from any thread.
 */
final class StreamPlayer {
    private StreamPlayer() {}

    /** Shown in the Pilot status. */
    static volatile String state = "off";

    private static final Handler h = new Handler(Looper.getMainLooper());
    private static final Set<String> owners = new HashSet<String>();
    private static Context app;
    private static MediaPlayer mp;
    private static boolean ducked;
    private static final Runnable reopen = new Runnable() {
        @Override public void run() { open(); }
    };

    /** A screen wants the radio. Plays if the stream is enabled and has a URL. */
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

    /** Settings changed (on/off or URL): reconnect if someone is listening. */
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

    /** Lowers the stream while a real ATC message is spoken. */
    static void duck(final boolean on) {
        h.post(new Runnable() { @Override public void run() { ducked = on; applyVolume(); } });
    }

    private static void release() {
        h.removeCallbacks(reopen);
        MediaPlayer m = mp;
        mp = null;
        if (m != null) {
            try { m.reset(); } catch (Throwable ignored) { }
            try { m.release(); } catch (Throwable ignored) { }
        }
    }

    private static void open() {
        h.removeCallbacks(reopen);
        if (mp != null || owners.isEmpty() || app == null) return;
        String url = Api.streamUrl(app);
        if (!Api.streamOn(app) || url.isEmpty()) { state = "off"; return; }
        final MediaPlayer m = new MediaPlayer();
        mp = m;
        try {
            m.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build());
            m.setWakeMode(app, PowerManager.PARTIAL_WAKE_LOCK);
            m.setDataSource(url);
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
                    fail(p, "error " + what + "/" + extra);
                    return true;
                }
            });
            m.setOnCompletionListener(new MediaPlayer.OnCompletionListener() {
                @Override public void onCompletion(MediaPlayer p) { fail(p, "stream ended"); }
            });
            state = "connecting...";
            m.prepareAsync();
        } catch (Throwable e) {
            fail(m, e.getClass().getSimpleName());
        }
    }

    private static void fail(MediaPlayer p, String why) {
        if (mp != p) return;
        release();
        state = why + ", retrying";
        if (!owners.isEmpty()) h.postDelayed(reopen, 5000);
    }

    private static void applyVolume() {
        MediaPlayer m = mp;
        if (m == null || app == null) return;
        int pct = owners.contains("ctl") ? Api.volCtl(app) : Api.volPilot(app);
        float v = pct / 100f * (ducked ? 0.25f : 1f);
        try { m.setVolume(v, v); } catch (Throwable ignored) { }
    }
}
