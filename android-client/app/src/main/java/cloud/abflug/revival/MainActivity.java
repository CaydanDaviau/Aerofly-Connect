package cloud.abflug.revival;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/** Start screen (Pilot / Controller) and the Pilot screen. */
public class MainActivity extends Activity {

    private final Handler ui = new Handler();
    private Runnable ticker;
    private TextView status;
    private Button startStop;
    private EditText callsignBox;
    private int pad;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        pad = (int) (24 * getResources().getDisplayMetrics().density);
        showStart();
    }

    @Override
    protected void onDestroy() {
        stopTicker();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (status != null) showStart(); else super.onBackPressed();
    }

    private LinearLayout column() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(pad, pad * 2, pad, pad);
        return root;
    }

    private TextView text(String s, int size, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(size);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    // ---------- Start screen ----------
    private void showStart() {
        stopTicker();
        status = null;
        LinearLayout root = column();
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.addView(text("Aerofly Connect", 28, true));
        TextView info = text("Build " + BuildConfig.VERSION_NAME
                + (BuildConfig.RELEASE_KEY ? "" : " (debug key)"), 13, false);
        info.setPadding(0, pad / 4, 0, pad * 2);
        root.addView(info);

        Button pilot = new Button(this);
        pilot.setText("Pilot");
        pilot.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { showPilot(); }
        });
        root.addView(pilot);

        Button ctl = new Button(this);
        ctl.setText("Controller");
        ctl.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                startActivity(new Intent(MainActivity.this, ControllerActivity.class));
            }
        });
        root.addView(ctl);
        setContentView(root);
    }

    // ---------- Pilot screen ----------
    private void showPilot() {
        LinearLayout root = column();
        root.addView(text("Pilot", 24, true));

        callsignBox = addField(root, "Callsign", Api.callsign(this), true, false);
        extra = new EditText[]{
                addField(root, "Departure (ICAO)", Api.field(this, "dep"), true, false),
                addField(root, "Arrival (ICAO)", Api.field(this, "arr"), true, false),
                addField(root, "Aircraft model", Api.field(this, "model"), true, false),
                addField(root, "Airline / livery", Api.field(this, "livery"), false, false),
                addField(root, "Cruise alt (ft)", Api.field(this, "cruise"), false, true),
                addField(root, "Squawk (4 digits)", Api.field(this, "squawk"), false, true),
                addField(root, "Route (optional)", Api.field(this, "route"), true, false)};

        startStop = new Button(this);
        startStop.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { toggle(); }
        });
        root.addView(startStop);

        Button map = new Button(this);
        map.setText("Map");
        map.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                startActivity(new Intent(MainActivity.this, MapActivity.class));
            }
        });
        root.addView(map);

        status = text("", 14, false);
        status.setPadding(0, pad, 0, 0);
        status.setTypeface(Typeface.MONOSPACE);
        status.setTextIsSelectable(true);
        root.addView(status);

        ScrollView sv = new ScrollView(this);
        sv.addView(root);
        setContentView(sv);
        startTicker();
    }

    private EditText[] extra;
    private static final String[] EXTRA_KEYS = {"dep", "arr", "model", "livery", "cruise", "squawk", "route"};

    private EditText addField(LinearLayout root, String label, String value, boolean caps, boolean digits) {
        TextView l = text(label, 13, false);
        l.setPadding(0, pad / 2, 0, 0);
        root.addView(l);
        EditText e = new EditText(this);
        e.setSingleLine(true);
        e.setInputType(digits ? InputType.TYPE_CLASS_NUMBER
                : InputType.TYPE_CLASS_TEXT | (caps ? InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS : 0));
        e.setText(value);
        root.addView(e);
        return e;
    }

    private void toggle() {
        if (PilotService.running) {
            Intent i = new Intent(this, PilotService.class);
            i.setAction(PilotService.ACTION_STOP);
            startService(i);
        } else {
            if (Build.VERSION.SDK_INT >= 33
                    && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
            }
            Api.setCallsign(this, callsignBox.getText().toString().trim());
            for (int i = 0; i < extra.length; i++)
                Api.setField(this, EXTRA_KEYS[i], extra[i].getText().toString().trim());
            startForegroundService(new Intent(this, PilotService.class));
        }
    }

    private void startTicker() {
        stopTicker();
        ticker = new Runnable() {
            @Override public void run() {
                refresh();
                ui.postDelayed(this, 1000);
            }
        };
        ticker.run();
    }

    private void stopTicker() {
        if (ticker != null) ui.removeCallbacks(ticker);
        ticker = null;
    }

    private void refresh() {
        if (status == null) return;
        boolean on = PilotService.running;
        startStop.setText(on ? "Stop" : "Start");
        callsignBox.setEnabled(!on);
        for (EditText e : extra) e.setEnabled(!on);
        String raw = PilotService.lastRaw;
        if (raw.length() > 300) raw = raw.substring(0, 300) + "...";
        String shown = ("State: " + (on ? "flying" : "stopped")
                + "\nSim link: " + PilotService.simState
                + "\nServer: " + PilotService.serverState
                + "\nUploads: " + PilotService.okCount + " ok / " + PilotService.failCount + " failed"
                + "\nKey: " + Api.key(this)
                + "\n\nLast sim line:\n" + (raw.isEmpty() ? "(none yet)" : raw));
        // Skip identical text so a text selection is not cleared by the 1 s refresh.
        if (!shown.equals(status.getText().toString())) status.setText(shown);
    }
}
