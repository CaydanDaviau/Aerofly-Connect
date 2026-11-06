package cloud.abflug.revival;

import android.app.Activity;
import android.graphics.Typeface;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Stage 0: proves the no-PC build pipeline works and that the phone can reach the Worker.
 * No sim link and no ATC yet.
 */
public class MainActivity extends Activity {

    private TextView status;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        int pad = (int) (24 * getResources().getDisplayMetrics().density);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setPadding(pad, pad * 2, pad, pad);

        TextView title = new TextView(this);
        title.setText("Abflug Revival");
        title.setTextSize(28);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        root.addView(title);

        TextView info = new TextView(this);
        info.setText("Stage 0 - build " + BuildConfig.VERSION_NAME
                + "\nSigning: " + (BuildConfig.RELEASE_KEY ? "release key" : "debug key (temporary)")
                + "\nServer: " + BuildConfig.SERVER_URL);
        info.setTextSize(14);
        info.setPadding(0, pad / 2, 0, pad);
        root.addView(info);

        Button test = new Button(this);
        test.setText("Test server connection");
        test.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                checkServer();
            }
        });
        root.addView(test);

        status = new TextView(this);
        status.setTextSize(16);
        status.setPadding(0, pad, 0, 0);
        status.setText("Not tested yet.");
        root.addView(status);

        setContentView(root);
    }

    private void checkServer() {
        status.setText("Testing...");
        new Thread(new Runnable() {
            @Override
            public void run() {
                String result;
                long t0 = System.currentTimeMillis();
                try {
                    URL url = new URL(BuildConfig.SERVER_URL + "/api/health");
                    HttpURLConnection c = (HttpURLConnection) url.openConnection();
                    c.setConnectTimeout(8000);
                    c.setReadTimeout(8000);
                    c.setRequestProperty("X-API-Key", "stage0-test");
                    int code = c.getResponseCode();
                    BufferedReader r = new BufferedReader(new InputStreamReader(
                            code < 400 ? c.getInputStream() : c.getErrorStream()));
                    String body = r.readLine();
                    r.close();
                    result = "HTTP " + code + " in " + (System.currentTimeMillis() - t0) + " ms\n" + body;
                } catch (Exception e) {
                    result = "Failed: " + e;
                }
                final String shown = result;
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        status.setText(shown);
                    }
                });
            }
        }).start();
    }
}
