package cloud.abflug.revival;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.util.Locale;
import java.util.Random;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * Speaks ATC messages with Android's built-in voice (offline voice preferred), rendered to a file
 * first so a radio effect (band-pass, light distortion, static, squelch) can be applied before playing.
 */
final class AtcVoice {
    private final Context ctx;
    private final String lang;
    private final ExecutorService ex = Executors.newSingleThreadExecutor();
    private final CountDownLatch ready = new CountDownLatch(1);
    private volatile boolean ttsOk;
    private volatile CountDownLatch utterDone;
    private volatile boolean utterOk;
    private TextToSpeech tts;
    private int seq;

    AtcVoice(Context c, String lang) {
        this.ctx = c.getApplicationContext();
        this.lang = lang;
        tts = new TextToSpeech(ctx, new TextToSpeech.OnInitListener() {
            @Override public void onInit(int status) {
                ttsOk = status == TextToSpeech.SUCCESS;
                ready.countDown();
            }
        });
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String id) { }
            @Override public void onDone(String id) { finish(true); }
            @Override public void onError(String id) { finish(false); }
            private void finish(boolean ok) {
                utterOk = ok;
                CountDownLatch l = utterDone;
                if (l != null) l.countDown();
            }
        });
    }

    /** Queues a message; messages are spoken one after another. */
    void speak(final String text, final Runnable onStart) {
        ex.execute(new Runnable() {
            @Override public void run() {
                started = false;
                try { say(text, onStart); } catch (Throwable ignored) { }
                fireStart(onStart);   // speech failed before playing: still run it
            }
        });
    }

    private boolean started;
    private void fireStart(Runnable r) {
        if (started) return;
        started = true;
        if (r != null) r.run();
    }

    void shutdown() {
        ex.execute(new Runnable() {
            @Override public void run() {
                try { if (tts != null) tts.shutdown(); } catch (Throwable ignored) { }
            }
        });
        ex.shutdown();
    }

    // ---------- speech ----------
    private void say(String text, Runnable onStart) throws Exception {
        if (!ready.await(8, TimeUnit.SECONDS) || !ttsOk) return;
        Locale loc = lang.equals("pt") ? new Locale("pt", "BR") : Locale.US;
        int r = tts.setLanguage(loc);
        if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) return;
        pickOfflineVoice(loc);
        tts.setSpeechRate(0.95f);

        File f = new File(ctx.getCacheDir(), "atc_tts_" + (seq++ % 4) + ".wav");
        utterDone = new CountDownLatch(1);
        utterOk = false;
        if (tts.synthesizeToFile(speakable(text), new Bundle(), f, "atc" + seq) != TextToSpeech.SUCCESS) return;
        if (!utterDone.await(20, TimeUnit.SECONDS) || !utterOk) return;

        int[] rate = new int[1];
        short[] pcm = readWav(f, rate);
        f.delete();
        if (pcm == null || pcm.length == 0) return;
        play(radio(pcm, rate[0]), rate[0], onStart);
    }

    /** Prefers an installed (offline) voice of the language, so the app works without internet. */
    private void pickOfflineVoice(Locale loc) {
        try {
            Voice best = null;
            for (Voice v : tts.getVoices()) {
                Locale vl = v.getLocale();
                if (!vl.getLanguage().equals(loc.getLanguage()) || v.isNetworkConnectionRequired()) continue;
                if (v.getFeatures() != null && v.getFeatures().contains("notInstalled")) continue;
                boolean exact = vl.getCountry().equals(loc.getCountry());
                if (best == null || (exact && !best.getLocale().getCountry().equals(loc.getCountry()))
                        || (exact == best.getLocale().getCountry().equals(loc.getCountry()) && v.getQuality() > best.getQuality()))
                    best = v;
            }
            if (best != null) tts.setVoice(best);
        } catch (Throwable ignored) { }
    }

    /** Reads digits one by one after "squawk" and expands FL for natural pronunciation. */
    private String speakable(String s) {
        boolean pt = lang.equals("pt");
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("(?i)(squawk|código)\\s*(\\d{4})").matcher(s);
        StringBuffer sb = new StringBuffer();
        while (m.find()) {
            String d = m.group(2);
            m.appendReplacement(sb, m.group(1) + " " + d.charAt(0) + ", " + d.charAt(1) + ", " + d.charAt(2) + ", " + d.charAt(3));
        }
        m.appendTail(sb);
        return sb.toString().replaceAll("(?i)\\bFL\\s?(\\d{2,3})\\b", pt ? "nível de voo $1" : "flight level $1");
    }

    // ---------- WAV ----------
    private static int le16(byte[] b, int o) { return (b[o] & 0xff) | (b[o + 1] << 8); }
    private static int le32(byte[] b, int o) { return le16(b, o) | (le16(b, o + 2) << 16); }

    /** 16-bit PCM WAV to mono samples. Returns null for anything else. */
    private static short[] readWav(File f, int[] rateOut) throws IOException {
        byte[] b = new byte[(int) f.length()];
        FileInputStream in = new FileInputStream(f);
        try {
            int n = 0, k;
            while (n < b.length && (k = in.read(b, n, b.length - n)) > 0) n += k;
        } finally { in.close(); }
        if (b.length < 44 || b[0] != 'R' || b[8] != 'W') return null;
        int ch = 1, bits = 16, rate = 22050, pos = 12;
        while (pos + 8 <= b.length) {
            int sz = le32(b, pos + 4);
            String id = new String(b, pos, 4, "US-ASCII");
            if (id.equals("fmt ")) {
                ch = le16(b, pos + 10); rate = le32(b, pos + 12); bits = le16(b, pos + 22);
            } else if (id.equals("data")) {
                if (bits != 16 || ch < 1) return null;
                int len = Math.min(sz < 0 ? Integer.MAX_VALUE : sz, b.length - pos - 8);
                int frames = len / (2 * ch);
                short[] out = new short[frames];
                for (int i = 0; i < frames; i++) {
                    int sum = 0;
                    for (int c = 0; c < ch; c++) sum += (short) le16(b, pos + 8 + (i * ch + c) * 2);
                    out[i] = (short) (sum / ch);
                }
                rateOut[0] = rate;
                return out;
            }
            pos += 8 + sz + (sz & 1);
        }
        return null;
    }

    // ---------- radio effect ----------
    private static final class Biquad {
        final double b0, b1, b2, a1, a2;
        double x1, x2, y1, y2;
        Biquad(boolean high, double fs, double f0, double q) {
            double w = 2 * Math.PI * f0 / fs, cs = Math.cos(w), al = Math.sin(w) / (2 * q);
            double a0 = 1 + al;
            if (high) { b0 = (1 + cs) / 2 / a0; b1 = -(1 + cs) / a0; b2 = b0; }
            else { b0 = (1 - cs) / 2 / a0; b1 = (1 - cs) / a0; b2 = b0; }
            a1 = -2 * cs / a0; a2 = (1 - al) / a0;
        }
        double p(double x) {
            double y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
            x2 = x1; x1 = x; y2 = y1; y1 = y;
            return y;
        }
    }

    /** Narrow band (about 400-2800 Hz), soft clipping, static under the voice, key-up click and squelch tail. */
    private static short[] radio(short[] in, int rate) {
        Biquad hp1 = new Biquad(true, rate, 420, 0.7), hp2 = new Biquad(true, rate, 420, 0.7);
        Biquad lp1 = new Biquad(false, rate, 2800, 0.7), lp2 = new Biquad(false, rate, 2800, 0.7);
        Random rnd = new Random(7);
        int lead = rate * 90 / 1000, tail = rate * 220 / 1000, pad = rate * 120 / 1000;
        int n = lead + pad + in.length + pad + tail;
        double[] o = new double[n];
        double peak = 1;
        for (int i = 0; i < in.length; i++) peak = Math.max(peak, Math.abs(in[i]));
        double g = 1.0 / peak;
        Biquad nl = new Biquad(false, rate, 3200, 0.7);
        for (int i = 0; i < n; i++) {
            double noise = nl.p(rnd.nextDouble() * 2 - 1);
            double v = 0;
            int si = i - lead - pad;
            if (si >= 0 && si < in.length) {
                v = lp2.p(lp1.p(hp2.p(hp1.p(in[si] * g))));
                v = Math.tanh(v * 2.6) * 0.8;
            }
            double bed = 0, env;
            if (i < lead) {                                   // key-up click: fast fade-out burst
                env = 1.0 - (double) i / lead; bed = noise * env * 0.55;
            } else if (i < n - tail) {                        // carrier hiss while the "transmission" is open
                bed = noise * 0.05;
            } else {                                          // squelch tail
                env = 1.0 - (double) (i - (n - tail)) / tail; bed = noise * env * env * 0.4;
            }
            o[i] = v + bed;
        }
        short[] out = new short[n];
        for (int i = 0; i < n; i++) out[i] = (short) Math.max(-32767, Math.min(32767, o[i] * 30000));
        return out;
    }

    // ---------- playback ----------
    private void play(short[] pcm, int rate, Runnable onStart) throws Exception {
        AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        AudioAttributes attr = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build();
        AudioFocusRequest fr = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                .setAudioAttributes(attr).build();
        am.requestAudioFocus(fr);
        AudioTrack t = null;
        try {
            int bytes = pcm.length * 2;
            t = new AudioTrack.Builder()
                    .setAudioAttributes(attr)
                    .setAudioFormat(new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                            .setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                    .setTransferMode(AudioTrack.MODE_STATIC)
                    .setBufferSizeInBytes(bytes).build();
            t.write(pcm, 0, pcm.length);
            t.play();
            fireStart(onStart);
            Thread.sleep(pcm.length * 1000L / rate + 250);
        } finally {
            if (t != null) t.release();
            am.abandonAudioFocusRequest(fr);
        }
    }
}
