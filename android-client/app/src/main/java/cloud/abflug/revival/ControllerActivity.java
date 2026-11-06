package cloud.abflug.revival;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/** Controller mode (Stage 1): the existing /atc radar page inside the app. */
public class ControllerActivity extends Activity {
    private WebView web;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        web = new WebView(this);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true); // IndexedDB cache for runway data
        web.setWebViewClient(new WebViewClient());
        setContentView(web);
        web.loadUrl(BuildConfig.SERVER_URL + "/atc");
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack(); else super.onBackPressed();
    }
}
