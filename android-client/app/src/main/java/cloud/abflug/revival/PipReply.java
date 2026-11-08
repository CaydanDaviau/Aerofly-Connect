package cloud.abflug.revival;

import android.os.Handler;
import android.os.Looper;

import java.util.ArrayList;

/**
 * ATC messages waiting for a Wilco/Unable answer from the PiP window. The oldest one is shown
 * (the PiP buttons become check / cross) for 30 s, then it is dropped from here; its
 * notification stays. All state is touched on the main thread only.
 */
final class PipReply {
    static final long TIMEOUT_MS = 60000;

    static final class Item {
        final String id;
        final int nid;
        final String text;
        Item(String id, int nid, String text) { this.id = id; this.nid = nid; this.text = text; }
    }

    private static final ArrayList<Item> queue = new ArrayList<>();
    private static final Handler h = new Handler(Looper.getMainLooper());
    /** Set by MapActivity: rebuild the PiP buttons. */
    static Runnable onChange;
    /** Set by the overlay: redraw the pending message. */
    static volatile Runnable overlayHook;

    private static final Runnable expire = new Runnable() {
        @Override public void run() {
            if (!queue.isEmpty()) queue.remove(0);
            changed();
        }
    };

    /** The message the PiP buttons answer now, or null (zoom buttons). */
    static Item current() { return queue.isEmpty() ? null : queue.get(0); }

    static void offer(final String id, final int nid, final String text) {
        h.post(new Runnable() {
            @Override public void run() {
                queue.add(new Item(id, nid, text));
                changed();
            }
        });
    }

    /** Answered (from PiP or from the notification): drop it. */
    static void done(final String id) {
        h.post(new Runnable() {
            @Override public void run() {
                for (int i = 0; i < queue.size(); i++) {
                    if (queue.get(i).id.equals(id)) { queue.remove(i); break; }
                }
                changed();
            }
        });
    }

    static void clear() {
        h.post(new Runnable() {
            @Override public void run() { queue.clear(); changed(); }
        });
    }

    private static void changed() {
        h.removeCallbacks(expire);
        if (!queue.isEmpty()) h.postDelayed(expire, TIMEOUT_MS);
        if (onChange != null) onChange.run();
        Runnable oh = overlayHook;
        if (oh != null) oh.run();
    }
}
