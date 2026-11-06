package cloud.abflug.revival;

import android.app.Activity;
import android.app.PendingIntent;
import android.app.PictureInPictureParams;
import android.app.RemoteAction;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.drawable.Icon;
import java.util.ArrayList;
import android.content.res.Configuration;
import android.os.Bundle;
import android.os.Handler;
import android.util.Rational;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.util.Locale;

/** Pilot map (MapLibre page served by the Worker at /map), with picture-in-picture over the sim. */
public class MapActivity extends Activity {
    private WebView web;
    private final Handler ui = new Handler();
    private Runnable feed;
    private volatile boolean pageReady;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        web.addJavascriptInterface(new Bridge(), "Android");
        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView v, String url) { pageReady = true; }
        });
        setContentView(web);
        web.loadUrl(BuildConfig.SERVER_URL + "/map?key=" + Api.key(this));
    }

    @Override
    protected void onStart() {
        super.onStart();
        // Push our own plane (from the sim link) into the page once a second.
        feed = new Runnable() {
            @Override public void run() {
                pushOwn();
                ui.postDelayed(this, 1000);
            }
        };
        ui.post(feed);
    }

    @Override
    protected void onStop() {
        ui.removeCallbacks(feed);
        super.onStop();
    }

    private void pushOwn() {
        if (!pageReady || !PilotService.running || !PilotService.hasPos) return;
        String cs = Api.callsign(this).trim().toUpperCase(Locale.US).replace("'", "");
        web.evaluateJavascript(String.format(Locale.US,
                "window.__appOwn=true;window.setOwn&&window.setOwn(%f,%f,%f,%f,%f,'%s')",
                PilotService.lastLat, PilotService.lastLon, PilotService.lastHdg,
                PilotService.lastGs, PilotService.lastAlt, cs), null);
    }

    private static final String ACT_ZOOM = "cloud.abflug.revival.ZOOM";
    private BroadcastReceiver zoomRx;

    private Icon glyph(boolean plus) {
        Bitmap bm = Bitmap.createBitmap(96, 96, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bm);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setColor(0xFFFFFFFF); p.setStrokeWidth(10); p.setStrokeCap(Paint.Cap.ROUND);
        c.drawLine(24, 48, 72, 48, p);
        if (plus) c.drawLine(48, 24, 48, 72, p);
        return Icon.createWithBitmap(bm);
    }

    private RemoteAction zoomAction(boolean in) {
        Intent i = new Intent(ACT_ZOOM).setPackage(getPackageName()).putExtra("d", in ? 1 : -1);
        PendingIntent pi = PendingIntent.getBroadcast(this, in ? 1 : 2, i,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new RemoteAction(glyph(in), in ? "Zoom in" : "Zoom out", in ? "Zoom in" : "Zoom out", pi);
    }

    private void enterPip() {
        try {
            if (zoomRx == null) {
                zoomRx = new BroadcastReceiver() {
                    @Override public void onReceive(Context ctx, Intent it) {
                        web.evaluateJavascript("window.zoomBy&&window.zoomBy(" + it.getIntExtra("d", 0) + ")", null);
                    }
                };
                IntentFilter f = new IntentFilter(ACT_ZOOM);
                if (android.os.Build.VERSION.SDK_INT >= 33) registerReceiver(zoomRx, f, Context.RECEIVER_NOT_EXPORTED);
                else registerReceiver(zoomRx, f);
            }
            ArrayList<RemoteAction> acts = new ArrayList<>();
            acts.add(zoomAction(false));
            acts.add(zoomAction(true));
            enterPictureInPictureMode(new PictureInPictureParams.Builder()
                    .setAspectRatio(new Rational(4, 3)).setActions(acts).build());
        } catch (Exception ignored) { }
    }

    /** Leaving to the sim with Home: shrink into a floating window instead of disappearing. */
    @Override
    protected void onUserLeaveHint() {
        if (PilotService.running) enterPip();
    }

    @Override
    public void onPictureInPictureModeChanged(boolean inPip, Configuration c) {
        super.onPictureInPictureModeChanged(inPip, c);
        web.evaluateJavascript("window.setPip&&window.setPip(" + inPip + ")", null);
    }

    @Override
    public void onBackPressed() {
        finish();
    }

    @Override
    protected void onDestroy() {
        ui.removeCallbacks(feed);
        if (zoomRx != null) { try { unregisterReceiver(zoomRx); } catch (Exception ignored) { } }
        web.destroy();
        super.onDestroy();
    }

    private class Bridge {
        @JavascriptInterface
        public void pip() {
            runOnUiThread(new Runnable() { @Override public void run() { enterPip(); } });
        }
    }
}
