package com.aeroflyconnect.app;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.MediaRecorder;
import android.os.Build;

import java.io.File;
import java.io.FileInputStream;

/** Push-to-talk recorder: AAC in mp4, 16 kHz mono, 24 kbps (about 3 KB per second), 10 s maximum. */
final class Mic {
    private Mic() { }

    static final int MAX_MS = 10_000;
    private static MediaRecorder rec;
    private static File file;
    private static long t0;

    static boolean permitted(Context c) {
        return c.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    /** The mic button is offered only with voice on in Settings and the microphone permission. */
    static boolean available(Context c) { return Api.voiceOn(c) && permitted(c); }

    /** Starts recording. Returns null on success, otherwise a short message for the status line. */
    static synchronized String start(Context c) {
        if (rec != null) return null;
        try {
            file = new File(c.getCacheDir(), "ptt.m4a");
            MediaRecorder r = Build.VERSION.SDK_INT >= 31 ? new MediaRecorder(c) : new MediaRecorder();
            r.setAudioSource(MediaRecorder.AudioSource.MIC);
            r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            r.setAudioChannels(1);
            r.setAudioSamplingRate(16000);
            r.setAudioEncodingBitRate(24000);
            r.setMaxDuration(MAX_MS);
            r.setOutputFile(file.getAbsolutePath());
            r.prepare();
            r.start();
            rec = r;
            t0 = System.currentTimeMillis();
            return null;
        } catch (Throwable e) {
            release();
            return Api.t(c, "Microphone busy", "Microfone em uso");
        }
    }

    static synchronized long elapsed() { return rec == null ? 0 : System.currentTimeMillis() - t0; }

    /** Stops and returns the recorded file bytes, or null if nothing usable was recorded. */
    static synchronized byte[] stop() {
        MediaRecorder r = rec;
        if (r == null) return null;
        byte[] out = null;
        try {
            r.stop();
            FileInputStream in = new FileInputStream(file);
            try {
                out = new byte[(int) file.length()];
                int off = 0, n;
                while (off < out.length && (n = in.read(out, off, out.length - off)) > 0) off += n;
            } finally { in.close(); }
        } catch (Throwable e) {
            out = null;
        }
        release();
        return out;
    }

    private static void release() {
        try { if (rec != null) rec.release(); } catch (Throwable ignored) { }
        rec = null;
        if (file != null) file.delete();
    }
}
