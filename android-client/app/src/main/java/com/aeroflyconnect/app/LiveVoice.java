package com.aeroflyconnect.app;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.AudioTrack;
import android.media.MediaRecorder;
import android.util.Base64;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Random;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * Live push-to-talk over the WebSocket (same wire format as the radar page and the PC app):
 * PCM16 mono 16 kHz in 80 ms chunks, base64, {"voice_stream":"start|chunk|end", ...}. Incoming streams are
 * played while they arrive (radio filter, short prebuffer). The last transmission, sent or heard, is kept in
 * memory so Replay plays it locally without sending anything.
 */
final class LiveVoice {
    private LiveVoice() { }

    static final int RATE = 16000, CHUNK = 1280, MAX_CHUNKS = 330;   // 80 ms per chunk, about 26 s per transmission
    static final int MAX_MS = MAX_CHUNKS * 80;

    // ---------- last transmission (replay) ----------
    static final class Clip { final short[] pcm; final int rate; Clip(short[] p, int r) { pcm = p; rate = r; } }
    private static volatile Clip last;
    static Clip last() { return last; }
    static void clear() { last = null; }
    private static void remember(ArrayList<short[]> parts, int rate) {
        int n = 0;
        for (short[] p : parts) n += p.length;
        if (n == 0) return;
        short[] all = new short[n];
        int o = 0;
        for (short[] p : parts) { System.arraycopy(p, 0, all, o, p.length); o += p.length; }
        last = new Clip(all, rate);
    }

    // ---------- transmit ----------
    private static volatile boolean txOn;
    private static volatile boolean txActive;
    private static Thread txThread;
    private static volatile long txMs;

    /** Starts a live transmission. Returns null on success, otherwise a short message for the status line. */
    static synchronized String startTx(Context c) {
        if (txActive) return null;
        if (!WsLink.live()) return Api.t(c, "No live connection yet", "Sem conexão ao vivo ainda");
        final String id = "an" + Long.toString(System.currentTimeMillis(), 36) + Integer.toString(new Random().nextInt(36 * 36 * 36), 36);
        int min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        final AudioRecord ar;
        try {
            ar = new AudioRecord(MediaRecorder.AudioSource.MIC, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, CHUNK * 2 * 4));
            if (ar.getState() != AudioRecord.STATE_INITIALIZED) { ar.release(); return Api.t(c, "Microphone busy", "Microfone em uso"); }
        } catch (Throwable e) {
            return Api.t(c, "Microphone busy", "Microfone em uso");
        }
        if (!WsLink.send("{\"voice_stream\":\"start\",\"id\":\"" + id + "\",\"direction\":\"up\",\"sampleRate\":" + RATE + "}")) {
            ar.release();
            return Api.t(c, "No live connection yet", "Sem conexão ao vivo ainda");
        }
        txOn = true; txActive = true; txMs = 0;
        txThread = new Thread(new Runnable() {
            @Override public void run() {
                ArrayList<short[]> kept = new ArrayList<>();
                short[] buf = new short[CHUNK];
                int n = 0, extra = 1;   // one more block after release so the end of the last word is not cut
                try {
                    ar.startRecording();
                    while ((txOn || extra-- > 0) && n < MAX_CHUNKS) {
                        int got = 0;
                        while (got < CHUNK) { int r = ar.read(buf, got, CHUNK - got); if (r <= 0) break; got += r; }
                        if (got < CHUNK) break;
                        short[] out = buf.clone();
                        kept.add(out);
                        byte[] b = new byte[CHUNK * 2];
                        for (int i = 0; i < CHUNK; i++) { b[2 * i] = (byte) out[i]; b[2 * i + 1] = (byte) (out[i] >> 8); }
                        if (!WsLink.send("{\"voice_stream\":\"chunk\",\"id\":\"" + id + "\",\"data\":\"" + Base64.encodeToString(b, Base64.NO_WRAP) + "\"}")) break;
                        n++; txMs = n * 80L;
                    }
                } catch (Throwable ignored) {
                } finally {
                    try { ar.stop(); } catch (Throwable ignored) { }
                    ar.release();
                    WsLink.send("{\"voice_stream\":\"end\",\"id\":\"" + id + "\"}");
                    if (n >= 4) remember(kept, RATE);
                    txActive = false; txOn = false;
                    Overlay.poke();
                }
            }
        }, "live-ptt");
        txThread.start();
        return null;
    }

    /** Ends the transmission; returns its length in ms. */
    static long stopTx() {
        txOn = false;
        Thread t = txThread;
        if (t != null) { try { t.join(600); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); } }
        return txMs;
    }

    // ---------- receive ----------
    private static final short[] END = new short[0];
    private static final ConcurrentHashMap<String, Rx> streams = new ConcurrentHashMap<>();

    /** One {"push":"voice_stream"} event from the socket (reader thread). Replays from the server are ignored: Replay is local. */
    static void onEvent(Context c, JSONObject j) {
        try {
            String ev = j.optString("event"), id = j.optString("id");
            if (id.isEmpty() || ev.startsWith("replay") || !Api.voiceOn(c)) return;
            if (ev.equals("start")) {
                JSONObject m = j.optJSONObject("meta");
                int sr = m == null ? RATE : m.optInt("sampleRate", RATE);
                if (sr < 8000 || sr > 48000) sr = RATE;
                if (streams.size() > 4) return;
                Rx r = new Rx(c.getApplicationContext(), id, sr);
                streams.put(id, r);
                r.start();
                return;
            }
            Rx r = streams.get(id);
            if (r == null) return;
            if (ev.equals("chunk")) {
                byte[] b = Base64.decode(j.optString("data"), Base64.DEFAULT);
                int n = b.length / 2;
                if (n == 0) return;
                short[] s = new short[n];
                for (int i = 0; i < n; i++) s[i] = (short) ((b[2 * i] & 0xff) | (b[2 * i + 1] << 8));
                r.q.offer(s);
            } else if (ev.equals("end")) {
                r.q.offer(END);
            }
        } catch (Throwable ignored) {
        }
    }

    private static final class Rx implements Runnable {
        final Context ctx; final String id; final int sr;
        final LinkedBlockingQueue<short[]> q = new LinkedBlockingQueue<>();
        final ArrayList<short[]> kept = new ArrayList<>();
        final AtcVoice.Biquad hp1, hp2, lp1, lp2;
        final Random rnd = new Random(11);

        Rx(Context c, String id, int sr) {
            this.ctx = c; this.id = id; this.sr = sr;
            hp1 = new AtcVoice.Biquad(true, sr, 420, 0.7); hp2 = new AtcVoice.Biquad(true, sr, 420, 0.7);
            lp1 = new AtcVoice.Biquad(false, sr, 2800, 0.7); lp2 = new AtcVoice.Biquad(false, sr, 2800, 0.7);
        }

        void start() { new Thread(this, "live-rx").start(); }

        /** Radio sound for one block (filters keep their state between blocks). */
        short[] fx(short[] in) {
            short[] out = new short[in.length];
            for (int i = 0; i < in.length; i++) {
                double v = lp2.p(lp1.p(hp2.p(hp1.p(in[i] / 32768.0)))) * 1.6;
                v = Math.tanh(v * 1.4) * 0.85 + (rnd.nextDouble() * 2 - 1) * 0.012;
                out[i] = (short) Math.max(-32767, Math.min(32767, v * 32767));
            }
            return out;
        }

        short[] burst(int ms, double amp, boolean fade) {
            int n = sr * ms / 1000;
            short[] o = new short[n];
            for (int i = 0; i < n; i++) o[i] = (short) ((rnd.nextDouble() * 2 - 1) * amp * (fade ? 1.0 - (double) i / n : 1.0) * 32767);
            return o;
        }

        @Override public void run() {
            AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
            AudioAttributes attr = new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build();
            AudioFocusRequest fr = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK).setAudioAttributes(attr).build();
            AudioTrack t = null;
            long written = 0;
            try {
                am.requestAudioFocus(fr);
                int min = AudioTrack.getMinBufferSize(sr, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
                t = new AudioTrack.Builder().setAudioAttributes(attr)
                        .setAudioFormat(new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(sr).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                        .setTransferMode(AudioTrack.MODE_STREAM).setBufferSizeInBytes(Math.max(min, sr * 2)).build();   // about 1 s of buffer
                // short prebuffer (two chunks, 160 ms) so network jitter does not chop the start
                ArrayList<short[]> pre = new ArrayList<>();
                boolean done = false;
                for (int i = 0; i < 2 && !done; i++) {
                    short[] b = q.poll(500, TimeUnit.MILLISECONDS);
                    if (b == null) break;
                    if (b == END) { done = true; break; }
                    pre.add(b);
                }
                RadioPlayer.duck(true);
                t.play();
                short[] click = burst(60, 0.4, true);
                t.write(click, 0, click.length); written += click.length;
                for (short[] b : pre) { kept.add(b); short[] o = fx(b); written += t.write(o, 0, o.length); }
                while (!done) {
                    short[] b = q.poll(3000, TimeUnit.MILLISECONDS);
                    if (b == null || b == END) break;
                    kept.add(b);
                    short[] o = fx(b);
                    written += t.write(o, 0, o.length);
                }
                short[] tail = burst(120, 0.35, true);
                written += t.write(tail, 0, tail.length);
                t.stop();   // stream mode: the buffered audio still plays out
                long until = System.currentTimeMillis() + 3000;
                while (t.getPlaybackHeadPosition() < written && System.currentTimeMillis() < until) Thread.sleep(20);
            } catch (Throwable ignored) {
            } finally {
                streams.remove(id);
                RadioPlayer.duck(false);
                if (t != null) { try { t.release(); } catch (Throwable ignored) { } }
                try { am.abandonAudioFocusRequest(fr); } catch (Throwable ignored) { }
                remember(kept, sr);
                Overlay.poke();
            }
        }
    }
}
