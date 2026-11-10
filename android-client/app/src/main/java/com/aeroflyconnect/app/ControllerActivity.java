package com.aeroflyconnect.app;

import android.app.Activity;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

/** Controller mode: the /atc radar page inside the app, full screen, with a native error screen. */
public class ControllerActivity extends Activity {
    private WebView web;
    private View err;
    private boolean failed;
    private String url() { return BuildConfig.SERVER_URL + "/atc?key=" + Api.key(this) + "&lang=" + Api.uiLang(this) + (Api.voiceOn(this) ? "" : "&voice=0"); }

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        web = new WebView(this);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true); // IndexedDB cache for runway data
        web.getSettings().setMediaPlaybackRequiresUserGesture(false);
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(final PermissionRequest r) {
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        if (Mic.permitted(ControllerActivity.this)) r.grant(r.getResources());
                        else { r.deny(); requestPermissions(new String[] { android.Manifest.permission.RECORD_AUDIO }, 5); }
                    }
                });
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame()) showError();
            }
            @Override public void onReceivedHttpError(WebView v, WebResourceRequest r, android.webkit.WebResourceResponse e) {
                if (r.isForMainFrame() && e.getStatusCode() >= 500) showError();
            }
        });
        err = ErrorPane.build(this, new Runnable() { @Override public void run() { retry(); } },
                new Runnable() { @Override public void run() { finish(); } });
        FrameLayout root = new FrameLayout(this);
        root.addView(web);
        root.addView(err);
        setContentView(root);
        if (Api.voiceOn(this) && !Mic.permitted(this)) requestPermissions(new String[] { android.Manifest.permission.RECORD_AUDIO }, 5);
        web.loadUrl(url());
        RadioPlayer.start(this, "ctl");   // background radio (only plays if enabled in Settings)
    }

    @Override
    protected void onStop() {
        web.evaluateJavascript("window.saveTrails&&window.saveTrails()", null);   // keep the 30 min traces
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        RadioPlayer.stop("ctl");
        super.onDestroy();
    }

    private void showError() {
        failed = true;
        web.setVisibility(View.INVISIBLE);
        err.setVisibility(View.VISIBLE);
    }

    private void retry() {
        failed = false;
        err.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        web.loadUrl(url());
    }

    @Override
    public void onBackPressed() {
        if (!failed && web.canGoBack()) web.goBack(); else super.onBackPressed();
    }
}
