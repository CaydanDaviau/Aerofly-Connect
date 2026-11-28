package com.aeroflyconnect.app;

import android.content.Context;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.Locale;

/** Small map for the overlay's Flight tab: the same /map page as the full map (compact "pip" look), fed by the service. Main thread only. */
final class MiniMap {
    private final Context ctx;
    private final Handler h = new Handler(Looper.getMainLooper());
    private final FrameLayout holder;
    private WebView web;
    private TextView note;
    private boolean ready, running, failed;
    private long trafficPushed;
    private String lastOwn = "";
    private android.widget.Button bFollow, bHdg;
    private boolean ctlVisible = true;

    private final Runnable feed = new Runnable() {
        @Override public void run() {
            if (!running) return;
            pushOwn(); pushTraffic(); syncButtons();
            h.postDelayed(this, 1000);
        }
    };

    MiniMap(Context ctx, int heightPx, float radiusPx) {
        this.ctx = ctx;
        holder = new FrameLayout(ctx);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xFF012C33);
        bg.setStroke(1, Ui.STROKE);
        bg.setCornerRadius(radiusPx);
        holder.setBackground(bg);
        holder.setClipToOutline(true);
        holder.setLayoutParams(new android.widget.LinearLayout.LayoutParams(
                android.widget.LinearLayout.LayoutParams.MATCH_PARENT, heightPx));
        note = new TextView(ctx);
        note.setTextSize(10);
        note.setTextColor(Ui.DIM);
        note.setGravity(android.view.Gravity.CENTER);
        note.setText(Api.t(ctx, "Loading map...", "Carregando mapa..."));
        holder.addView(note, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        bFollow = ctlButton(Api.t(ctx, "Follow", "Seguir"), "document.getElementById('bFollow').click()");
        bHdg = ctlButton(Api.t(ctx, "North up", "Norte acima"), "document.getElementById('bHdg').click()");
        LinearLayout row = new LinearLayout(ctx);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.addView(bFollow); row.addView(bHdg);
        FrameLayout.LayoutParams rl = new FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, android.view.Gravity.BOTTOM | android.view.Gravity.START);
        rl.setMargins(4, 0, 0, 4);
        controls = row;
        holder.addView(row, rl);
    }

    private LinearLayout controls;

    private android.widget.Button ctlButton(String label, final String js) {
        android.widget.Button b = new android.widget.Button(ctx);
        b.setText(label); b.setAllCaps(false); b.setTextSize(9); b.setTextColor(Ui.TXT);
        b.setPadding(10, 0, 10, 0); b.setMinHeight(0); b.setMinimumHeight(0); b.setMinWidth(0); b.setMinimumWidth(0);
        b.setBackground(Ui.shape(ctx, 0xCC012C33, Ui.STROKE, 8));
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, (int) (26 * ctx.getResources().getDisplayMetrics().density));
        p.rightMargin = 4;
        b.setLayoutParams(p);
        b.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) {
            if (web != null && ready) { web.evaluateJavascript(js, null); h.postDelayed(new Runnable() { @Override public void run() { syncButtons(); } }, 120); }
        } });
        return b;
    }

    /** Buttons follow the page's state (a drag switches Follow off by itself). */
    private void syncButtons() {
        if (web == null || !ready || !ctlVisible) return;
        web.evaluateJavascript("(follow?'1':'0')+(hdgUp?'1':'0')", new android.webkit.ValueCallback<String>() {
            @Override public void onReceiveValue(String v) {
                if (v == null || v.length() < 4) return;
                boolean f = v.charAt(1) == '1', hu = v.charAt(2) == '1';
                bFollow.setBackground(Ui.shape(ctx, f ? 0xFF1E7480 : 0xCC012C33, Ui.STROKE, 8));
                bHdg.setText(hu ? Api.t(ctx, "Heading up", "Proa acima") : Api.t(ctx, "North up", "Norte acima"));
                bHdg.setBackground(Ui.shape(ctx, hu ? 0xFF1E7480 : 0xCC012C33, Ui.STROKE, 8));
            }
        });
    }

    /** Shown together with the tabs; hidden when the tabs are hidden (^). */
    void setControls(boolean on) {
        ctlVisible = on;
        controls.setVisibility(on ? View.VISIBLE : View.GONE);
    }

    View view() { return holder; }

    private String url() {
        return BuildConfig.SERVER_URL + "/map?key=" + Api.key(ctx) + "&mode=" + Api.mode + "&group=" + java.net.URLEncoder.encode(Api.group);
    }

    private void create() {
        if (web != null) return;
        try {
            web = new WebView(ctx);
            web.setBackgroundColor(0xFF012C33);
            web.setLayerType(View.LAYER_TYPE_HARDWARE, null);
            WebSettings s = web.getSettings();
            s.setJavaScriptEnabled(true);
            s.setDomStorageEnabled(true);
            s.setCacheMode(WebSettings.LOAD_DEFAULT);
            web.addJavascriptInterface(new Object() { @JavascriptInterface public void pip() { } }, "Android");   // app-fed mode, no PiP button
            web.setWebViewClient(new WebViewClient() {
                @Override public void onPageFinished(WebView v, String u) {
                    if (failed) return;
                    ready = true; lastOwn = "";
                    web.evaluateJavascript("window.setPip&&window.setPip(true)", null);
                    h.postDelayed(new Runnable() { @Override public void run() {
                        if (web != null) web.evaluateJavascript("window.setPip&&window.setPip(true)", null);
                    } }, 400);
                    String t = PilotService.traceJson();
                    if (t != null) web.evaluateJavascript("window.setOwnTrace&&window.setOwnTrace(" + t + ")", null);
                    if (running) web.evaluateJavascript("window.setActive&&window.setActive(true)", null);
                    note.setVisibility(View.GONE);
                }
                @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                    if (r.isForMainFrame()) {
                        failed = true; ready = false;
                        web.setVisibility(View.INVISIBLE);
                        note.setText(Api.t(ctx, "Map unavailable", "Mapa indisponível"));
                        note.setVisibility(View.VISIBLE);
                    }
                }
            });
            holder.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
            controls.bringToFront();   // the page was added after the buttons and would cover them
            controls.setElevation(20f);
            web.loadUrl(url());
        } catch (Throwable t) {
            web = null;
            note.setText(Api.t(ctx, "Map unavailable", "Mapa indisponível"));
        }
    }

    /** Show and feed the map (Flight tab open). */
    void start() {
        if (running) return;
        running = true;
        PilotService.miniShown = true;
        trafficPushed = 0; lastOwn = "";
        create();
        if (web != null && ready) web.evaluateJavascript("window.setActive&&window.setActive(true)", null);
        h.removeCallbacks(feed);
        h.post(feed);
    }

    /** Stop feeding (tab hidden or panel folded): no polling, no pushes. */
    void stop() {
        if (!running) return;
        running = false;
        PilotService.miniShown = false;
        h.removeCallbacks(feed);
        if (web != null && ready) {
            web.evaluateJavascript("window.saveTrails&&window.saveTrails()", null);
            web.evaluateJavascript("window.setActive&&window.setActive(false)", null);
        }
    }

    void destroy() {
        stop();
        if (web != null) {
            try { holder.removeView(web); web.destroy(); } catch (Exception ignored) { }
            web = null;
        }
    }

    private void pushTraffic() {
        String j = PilotService.trafficJson; long at = PilotService.trafficAt;
        if (web == null || !ready || j == null || at == trafficPushed || System.currentTimeMillis() - at > 10000) return;
        trafficPushed = at;
        web.evaluateJavascript("window.setTraffic&&window.setTraffic(" + j + ")", null);
    }

    private void pushOwn() {
        if (web == null || !ready || !PilotService.running || !PilotService.hasPos) return;
        String cs = Api.callsign(ctx).trim().toUpperCase(Locale.US).replace("'", "");
        String js = String.format(Locale.US,
                "window.__appOwn=true;window.setOwn&&window.setOwn(%f,%f,%f,%f,%f,'%s',%d,%s)",
                PilotService.lastLat, PilotService.lastLon, PilotService.lastHdg,
                PilotService.lastGs, PilotService.lastAlt, cs, Phase.etaMin,
                Phase.landingShown(System.currentTimeMillis()) ? String.valueOf(Phase.landFpm) : "null");
        if (js.equals(lastOwn)) return;
        lastOwn = js;
        web.evaluateJavascript(js, null);
    }
}
