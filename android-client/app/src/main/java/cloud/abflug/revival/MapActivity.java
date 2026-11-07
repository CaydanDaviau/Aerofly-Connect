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
import android.view.View;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import java.util.Locale;

/** Pilot map (MapLibre page served by the Worker at /map), with picture-in-picture over the sim. */
public class MapActivity extends Activity {
    private WebView web;
    private final Handler ui = new Handler();
    private Runnable feed;
    private volatile boolean pageReady;
    private View err;
    private boolean failed;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        pipOnStart = ACT_TOGGLE.equals(getIntent().getAction());
        overridePendingTransition(0, 0);
        PipReply.onChange = new Runnable() { @Override public void run() { refreshPip(); } };
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        web.addJavascriptInterface(new Bridge(), "Android");
        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView v, String url) { if (!failed) { pageReady = true; syncPip(); } }
            @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame()) showError();
            }
            @Override public void onReceivedHttpError(WebView v, WebResourceRequest r, WebResourceResponse e) {
                if (r.isForMainFrame() && e.getStatusCode() >= 500) showError();
            }
        });
        err = ErrorPane.build(this, new Runnable() { @Override public void run() { retry(); } },
                new Runnable() { @Override public void run() { finish(); } });
        FrameLayout root = new FrameLayout(this);
        root.addView(web);
        root.addView(err);
        setContentView(root);
        if (pipOnStart) web.setVisibility(View.INVISIBLE);   // no full-screen flash before the PiP window
        web.loadUrl(mapUrl());
    }

    private boolean pipOnStart;

    /** The app decides PiP state; the page must never guess it from its size. */
    private void syncPip() {
        final boolean on = isInPictureInPictureMode();
        web.evaluateJavascript("window.setPip&&window.setPip(" + on + ")", null);
        ui.postDelayed(new Runnable() {
            @Override public void run() {
                web.evaluateJavascript("window.setPip&&window.setPip(" + isInPictureInPictureMode() + ")", null);
            }
        }, 400);
    }

    @Override
    public void onConfigurationChanged(Configuration c) {
        super.onConfigurationChanged(c);
        syncPip();
    }

    private String mapUrl() { return BuildConfig.SERVER_URL + "/map?key=" + Api.key(this); }

    private void showError() {
        failed = true; pageReady = false;
        web.setVisibility(View.INVISIBLE);
        err.setVisibility(View.VISIBLE);
    }

    private void retry() {
        failed = false;
        err.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        web.loadUrl(mapUrl());
    }

    @Override
    protected void onNewIntent(android.content.Intent it) {
        super.onNewIntent(it);
        if (ACT_TOGGLE.equals(it.getAction())) finish();   // "Hide map"
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (pipOnStart) { pipOnStart = false; enterPip(); }   // "Show map": straight into PiP
        else syncPip();
    }

    @Override
    protected void onStart() {
        super.onStart();
        PilotService.mapShown = true; PilotService.refreshNotif(this);
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

    static final String ACT_TOGGLE = "cloud.abflug.revival.TOGGLE_MAP";
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

    private Icon replyGlyph(boolean ok) {
        Bitmap bm = Bitmap.createBitmap(96, 96, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bm);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setStyle(Paint.Style.STROKE); p.setStrokeWidth(12);
        p.setStrokeCap(Paint.Cap.ROUND); p.setStrokeJoin(Paint.Join.ROUND);
        if (ok) {
            p.setColor(0xFF4CD964);
            android.graphics.Path path = new android.graphics.Path();
            path.moveTo(20, 50); path.lineTo(40, 70); path.lineTo(76, 28);
            c.drawPath(path, p);
        } else {
            p.setColor(0xFFFF5A52);
            c.drawLine(26, 26, 70, 70, p);
            c.drawLine(70, 26, 26, 70, p);
        }
        return Icon.createWithBitmap(bm);
    }

    private RemoteAction replyAction(PipReply.Item it, boolean ok) {
        String label = ok ? "Wilco" : Api.t(this, "Unable", "Impossível");
        return new RemoteAction(replyGlyph(ok), label, label,
                PilotService.replyIntent(this, it.id, ok ? "wilco" : "unable", it.nid));
    }

    /** Zoom buttons, or check / cross while an ATC message waits for an answer. */
    private ArrayList<RemoteAction> buildActions() {
        ArrayList<RemoteAction> acts = new ArrayList<>();
        PipReply.Item it = PipReply.current();
        if (it != null) {
            acts.add(replyAction(it, true));
            acts.add(replyAction(it, false));
        } else {
            acts.add(zoomAction(false));
            acts.add(zoomAction(true));
        }
        return acts;
    }

    private void refreshPip() {
        try {
            setPictureInPictureParams(new PictureInPictureParams.Builder()
                    .setAspectRatio(new Rational(4, 3)).setActions(buildActions()).build());
        } catch (Exception ignored) { }
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
            if (!enterPictureInPictureMode(new PictureInPictureParams.Builder()
                    .setAspectRatio(new Rational(4, 3)).setActions(buildActions()).build())) {
                web.setVisibility(View.VISIBLE);
            }
        } catch (Exception ignored) { web.setVisibility(View.VISIBLE); }
    }

    /** Leaving to the sim with Home: shrink into a floating window instead of disappearing. */
    @Override
    protected void onUserLeaveHint() {
        if (PilotService.running) enterPip();
    }

    @Override
    public void onPictureInPictureModeChanged(boolean inPip, Configuration c) {
        super.onPictureInPictureModeChanged(inPip, c);
        if (inPip) web.setVisibility(View.VISIBLE);
        syncPip();
    }

    @Override
    public void onBackPressed() {
        finish();
    }

    @Override
    protected void onDestroy() {
        PilotService.mapShown = false; PilotService.refreshNotif(this);
        ui.removeCallbacks(feed);
        PipReply.onChange = null;
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
