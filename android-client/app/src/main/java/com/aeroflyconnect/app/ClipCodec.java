package com.aeroflyconnect.app;

import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;

import java.io.File;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.ShortBuffer;
import java.util.Arrays;

/** Decodes a short recorded clip (AAC in mp4, Opus in webm, ...) to mono 16-bit PCM. */
final class ClipCodec {
    private ClipCodec() { }

    static short[] decode(File f, int[] rateOut) throws Exception {
        MediaExtractor ex = new MediaExtractor();
        MediaCodec codec = null;
        try {
            ex.setDataSource(f.getAbsolutePath());
            int track = -1;
            MediaFormat fmt = null;
            for (int i = 0; i < ex.getTrackCount(); i++) {
                MediaFormat tf = ex.getTrackFormat(i);
                String m = tf.getString(MediaFormat.KEY_MIME);
                if (m != null && m.startsWith("audio/")) { track = i; fmt = tf; break; }
            }
            if (track < 0) return null;
            ex.selectTrack(track);
            codec = MediaCodec.createDecoderByType(fmt.getString(MediaFormat.KEY_MIME));
            codec.configure(fmt, null, null, 0);
            codec.start();
            int rate = fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE);
            int ch = Math.max(1, fmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT));
            short[] out = new short[rate * 4];
            int n = 0;
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            boolean inDone = false, outDone = false;
            long deadline = System.currentTimeMillis() + 8000;
            while (!outDone && System.currentTimeMillis() < deadline) {
                if (!inDone) {
                    int ii = codec.dequeueInputBuffer(10000);
                    if (ii >= 0) {
                        ByteBuffer ib = codec.getInputBuffer(ii);
                        int sz = ex.readSampleData(ib, 0);
                        if (sz < 0) {
                            codec.queueInputBuffer(ii, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inDone = true;
                        } else {
                            codec.queueInputBuffer(ii, 0, sz, ex.getSampleTime(), 0);
                            ex.advance();
                        }
                    }
                }
                int oi = codec.dequeueOutputBuffer(info, 10000);
                if (oi >= 0) {
                    ByteBuffer ob = codec.getOutputBuffer(oi);
                    ob.position(info.offset);
                    ob.limit(info.offset + info.size);
                    ShortBuffer sb = ob.order(ByteOrder.nativeOrder()).asShortBuffer();
                    int frames = sb.remaining() / ch;
                    if (n + frames > out.length) out = Arrays.copyOf(out, Math.max(out.length * 2, n + frames));
                    for (int fr = 0; fr < frames; fr++) {
                        int sum = 0;
                        for (int c = 0; c < ch; c++) sum += sb.get();
                        out[n++] = (short) (sum / ch);
                    }
                    codec.releaseOutputBuffer(oi, false);
                    if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) outDone = true;
                } else if (oi == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    MediaFormat of = codec.getOutputFormat();
                    rate = of.getInteger(MediaFormat.KEY_SAMPLE_RATE);
                    ch = Math.max(1, of.getInteger(MediaFormat.KEY_CHANNEL_COUNT));
                }
            }
            rateOut[0] = rate;
            return Arrays.copyOf(out, Math.min(n, rate * 12));
        } finally {
            try { if (codec != null) { codec.stop(); codec.release(); } } catch (Throwable ignored) { }
            ex.release();
        }
    }
}
