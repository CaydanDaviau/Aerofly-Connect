package cloud.abflug.revival;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.widget.Toast;

/**
 * Fallback for pilots without the overlay permission: the "ATC request" button of the pilot
 * notification opens a heads-up notification with the requests that fit the flight phase.
 */
public class RequestReceiver extends BroadcastReceiver {
    static final String ACT_MENU = "cloud.abflug.revival.REQ_MENU";
    static final String ACT_REQ = "cloud.abflug.revival.REQ_SEND";
    private static final int MENU_NID = 2;

    private static Notification.Action action(Context c, int code, String type, String label) {
        PendingIntent pi = PendingIntent.getBroadcast(c, code,
                new Intent(c, RequestReceiver.class).setAction(ACT_REQ).putExtra("type", type),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Action.Builder(null, label, pi).build();
    }

    @Override
    public void onReceive(final Context ctx, Intent it) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (ACT_MENU.equals(it.getAction())) {
            Notification.Builder b = new Notification.Builder(ctx, "atc_urgent")
                    .setContentTitle(Api.t(ctx, "ATC request", "Pedido ao ATC"))
                    .setContentText(Api.t(ctx, "What do you need?", "O que você precisa?"))
                    .setSmallIcon(android.R.drawable.ic_dialog_info)
                    .setAutoCancel(true);
            int n = 0;
            if (Phase.clearance) { b.addAction(action(ctx, 20, "clearance", Api.t(ctx, "Clearance", "Autorização"))); n++; }
            if (Phase.taxi) { b.addAction(action(ctx, 21, "taxi", Api.t(ctx, "Taxi", "Táxi"))); n++; }
            if (Phase.takeoff) { b.addAction(action(ctx, 22, "takeoff", Api.t(ctx, "Take off", "Decolar"))); n++; }
            if (Phase.land) { b.addAction(action(ctx, 23, "land", Api.t(ctx, "Land", "Pousar"))); n++; }
            if (n > 0) nm.notify(MENU_NID, b.build());
        } else if (ACT_REQ.equals(it.getAction())) {
            nm.cancel(MENU_NID);
            String type = it.getStringExtra("type");
            if (type == null) return;
            final Context app = ctx.getApplicationContext();
            final Handler main = new Handler(Looper.getMainLooper());
            PilotService.request(app, type, new PilotService.ReqCb() {
                @Override public void done(final String feedback) {
                    main.post(new Runnable() {
                        @Override public void run() { Toast.makeText(app, feedback, Toast.LENGTH_SHORT).show(); }
                    });
                }
            });
        }
    }
}
