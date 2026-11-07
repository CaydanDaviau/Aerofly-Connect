package cloud.abflug.revival;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import org.json.JSONObject;

/** Wilco / Unable button on an ATC message notification: sends the reply to the Worker. */
public class ReplyReceiver extends BroadcastReceiver {
    static final String ACTION = "cloud.abflug.revival.ATC_REPLY";

    @Override
    public void onReceive(final Context ctx, Intent intent) {
        final String id = intent.getStringExtra("id");
        final String reply = intent.getStringExtra("reply");
        final int nid = intent.getIntExtra("nid", 0);
        if (id == null || reply == null) return;
        final PendingResult pr = goAsync();
        new Thread(new Runnable() {
            @Override public void run() {
                try {
                    JSONObject o = new JSONObject();
                    o.put("id", id);
                    o.put("reply", reply);
                    int code = Api.send("PUT", "/api/messages/reply", o.toString(), Api.key(ctx));
                    // Keep the notification if sending failed, so the pilot can tap again.
                    if (code < 400) {
                        ((NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE)).cancel(nid);
                    }
                } catch (Exception ignored) {
                } finally {
                    pr.finish();
                }
            }
        }).start();
    }
}
