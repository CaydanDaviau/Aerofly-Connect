package com.aeroflyconnect.app;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import org.json.JSONObject;

/** Wilco / Unable button on an ATC message notification: sends the reply to the Worker. */
public class ReplyReceiver extends BroadcastReceiver {
    static final String ACTION = "com.aeroflyconnect.app.ATC_REPLY";

    @Override
    public void onReceive(final Context ctx, Intent intent) {
        final String id = intent.getStringExtra("id");
        final String reply = intent.getStringExtra("reply");
        final int nid = intent.getIntExtra("nid", 0);
        if (id == null || reply == null) return;
        final PendingResult pr = goAsync();
        new Thread(new Runnable() {
            @Override public void run() {
                try { sendReply(ctx, id, reply, nid); } finally { pr.finish(); }
            }
        }).start();
    }

    /** Sends Wilco / Unable (blocking). On success the notification is cancelled and the message leaves the answer queue. */
    static boolean sendReply(Context ctx, String id, String reply, int nid) {
        try {
            JSONObject o = new JSONObject();
            o.put("id", id);
            o.put("reply", reply);
            int code = Api.send("PUT", "/api/messages/reply", o.toString(), Api.key(ctx));
            // Keep the notification if sending failed, so the pilot can tap again.
            if (code < 400) {
                ((NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE)).cancel(nid);
                PipReply.done(id);
                return true;
            }
        } catch (Exception ignored) {
        }
        return false;
    }
}
