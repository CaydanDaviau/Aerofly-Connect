package cloud.abflug.revival;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.content.pm.PackageManager;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.speech.tts.TextToSpeech;
import android.speech.tts.Voice;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.CompoundButton;
import android.widget.SeekBar;
import android.widget.Spinner;
import android.widget.Toast;
import android.widget.Switch;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Set;

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
        leaveSettings();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (status != null || inSettings) { inSettings = false; showStart(); } else super.onBackPressed();
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
        leaveSettings();
        status = null;
        inSettings = false;
        LinearLayout root = column();
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.addView(text("Aerofly Connect", 28, true));
        TextView info = text("Build " + BuildConfig.VERSION_NAME
                + (BuildConfig.RELEASE_KEY ? "" : " (debug key)"), 13, false);
        info.setPadding(0, pad / 4, 0, pad * 2);
        root.addView(info);

        Button pilot = new Button(this);
        pilot.setText(Api.t(this, "Pilot", "Piloto"));
        pilot.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { showPilot(); }
        });
        root.addView(pilot);

        Button ctl = new Button(this);
        ctl.setText(Api.t(this, "Controller", "Controlador"));
        ctl.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                startActivity(new Intent(MainActivity.this, ControllerActivity.class));
            }
        });
        root.addView(ctl);

        Button set = new Button(this);
        set.setText(Api.t(this, "Settings", "Configurações"));
        set.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { showSettings(); }
        });
        root.addView(set);
        setContentView(root);
    }

    // ---------- Settings ----------
    private boolean inSettings;

    private void showSettings() {
        stopTicker();
        status = null;
        inSettings = true;
        LinearLayout root = column();
        root.addView(text(Api.t(this, "Settings", "Configurações"), 24, true));

        Switch sp = new Switch(this);
        sp.setText(Api.t(this, "Speak ATC messages", "Falar mensagens do ATC"));
        sp.setTextSize(16);
        sp.setPadding(0, pad, 0, pad / 2);
        sp.setChecked(Api.speakOn(this));
        sp.setOnCheckedChangeListener(new CompoundButton.OnCheckedChangeListener() {
            @Override public void onCheckedChanged(CompoundButton b, boolean on) { Api.setSpeakOn(MainActivity.this, on); }
        });
        root.addView(sp);

        root.addView(langRow(Api.t(this, "App language", "Idioma do app"), Api.uiLang(this), true));
        root.addView(langRow(Api.t(this, "Voice language", "Idioma da voz"), Api.voiceLang(this), false));
        root.addView(voiceRow());
        root.addView(rateRow());

        // ----- Background radio (loops an audio file picked from the phone) -----
        TextView hdr = text(Api.t(this, "Background radio", "Rádio de fundo"), 18, true);
        hdr.setPadding(0, pad, 0, 0);
        root.addView(hdr);

        Switch st = new Switch(this);
        st.setText(Api.t(this, "Play background radio (Pilot and Controller)", "Tocar rádio de fundo (Piloto e Controlador)"));
        st.setTextSize(16);
        st.setPadding(0, pad / 2, 0, pad / 4);
        st.setChecked(Api.radioOn(this));
        st.setOnCheckedChangeListener(new CompoundButton.OnCheckedChangeListener() {
            @Override public void onCheckedChanged(CompoundButton b, boolean on) {
                Api.setRadioOn(MainActivity.this, on);
                RadioPlayer.settingsChanged(MainActivity.this);
            }
        });
        root.addView(st);

        radioFileLabel = text("", 13, false);
        radioFileLabel.setPadding(0, pad / 4, 0, 0);
        showRadioName();
        root.addView(radioFileLabel);
        Button pickBtn = new Button(this);
        pickBtn.setText(Api.t(this, "Choose audio file", "Escolher arquivo de áudio"));
        pickBtn.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { pickRadioFile(); }
        });
        root.addView(pickBtn);

        root.addView(volRow(Api.t(this, "Volume - Pilot", "Volume - Piloto"), Api.volPilot(this), true));
        root.addView(volRow(Api.t(this, "Volume - Controller", "Volume - Controlador"), Api.volCtl(this), false));

        testBtn = new Button(this);
        testBtn.setText(radioTesting ? Api.t(this, "Stop test", "Parar teste") : Api.t(this, "Test radio", "Testar rádio"));
        testBtn.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { toggleRadioTest(); }
        });
        root.addView(testBtn);

        ScrollView sv = new ScrollView(this);
        sv.addView(root);
        setContentView(sv);
    }

    // ---------- Settings helpers: voice picker, speed, radio file + test ----------
    private Spinner voiceSpinner;
    private TextToSpeech voiceTts;
    private final List<String> voiceNames = new ArrayList<String>();
    private Button testBtn;
    private boolean radioTesting;

    /** Releases everything the Settings screen holds (voice list engine, radio test). */
    private void leaveSettings() {
        closeVoiceTts();
        voiceSpinner = null;
        if (radioTesting) { radioTesting = false; RadioPlayer.stop("test"); }
        testBtn = null;
    }

    private void closeVoiceTts() {
        TextToSpeech t = voiceTts;
        voiceTts = null;
        if (t != null) { try { t.shutdown(); } catch (Throwable ignored) { } }
    }

    private View voiceRow() {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.VERTICAL);
        TextView l = text(Api.t(this, "Voice", "Voz"), 13, false);
        l.setPadding(0, pad / 2, 0, 0);
        row.addView(l);
        voiceSpinner = new Spinner(this);
        voiceSpinner.setAdapter(new ArrayAdapter<String>(this, android.R.layout.simple_spinner_dropdown_item,
                new String[]{Api.t(this, "Loading...", "Carregando...")}));
        row.addView(voiceSpinner);
        Button test = new Button(this);
        test.setText(Api.t(this, "Test voice", "Testar voz"));
        test.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                String lang = Api.voiceLang(MainActivity.this);
                AtcVoice av = new AtcVoice(MainActivity.this, lang);
                av.speak(lang.equals("pt") ? "Código 4321, suba e mantenha nível de voo 100"
                        : "Squawk 4321, climb and maintain FL100", null);
                av.shutdown();   // finishes after the queued sentence
            }
        });
        row.addView(test);
        refreshVoices();
        return row;
    }

    /** Lists the installed offline voices of the voice language (asks the TTS engine once). */
    private void refreshVoices() {
        closeVoiceTts();
        final String lang = Api.voiceLang(this);
        final TextToSpeech[] holder = new TextToSpeech[1];
        holder[0] = new TextToSpeech(getApplicationContext(), new TextToSpeech.OnInitListener() {
            @Override public void onInit(final int st) {
                ui.post(new Runnable() {
                    @Override public void run() {
                        if (voiceTts != holder[0] || voiceSpinner == null) return;
                        fillVoices(st, lang);
                        closeVoiceTts();
                    }
                });
            }
        });
        voiceTts = holder[0];
    }

    private void fillVoices(int st, String lang) {
        voiceNames.clear();
        List<String> labels = new ArrayList<String>();
        labels.add(Api.t(this, "Automatic", "Automático"));
        if (st == TextToSpeech.SUCCESS) {
            List<Voice> list = new ArrayList<Voice>();
            try {
                Set<Voice> vs = voiceTts.getVoices();
                if (vs != null) for (Voice v : vs) {
                    if (!v.getLocale().getLanguage().equals(lang) || v.isNetworkConnectionRequired()) continue;
                    if (v.getFeatures() != null && v.getFeatures().contains("notInstalled")) continue;
                    list.add(v);
                }
            } catch (Throwable ignored) { }
            Collections.sort(list, new Comparator<Voice>() {
                @Override public int compare(Voice a, Voice b) { return a.getName().compareTo(b.getName()); }
            });
            for (Voice v : list) {
                voiceNames.add(v.getName());
                labels.add(v.getLocale().toLanguageTag() + "  " + v.getName());
            }
        }
        int sel = voiceNames.indexOf(Api.voiceName(this)) + 1;   // 0 = Automatic
        voiceSpinner.setOnItemSelectedListener(null);
        voiceSpinner.setAdapter(new ArrayAdapter<String>(this, android.R.layout.simple_spinner_dropdown_item, labels));
        voiceSpinner.setSelection(sel);
        if (st != TextToSpeech.SUCCESS) return;   // engine not ready: keep the saved choice untouched
        voiceSpinner.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override public void onItemSelected(AdapterView<?> p, View v, int pos, long id) {
                Api.setVoiceName(MainActivity.this, pos == 0 || pos > voiceNames.size() ? "" : voiceNames.get(pos - 1));
            }
            @Override public void onNothingSelected(AdapterView<?> p) { }
        });
    }

    private View rateRow() {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.VERTICAL);
        TextView l = text(Api.t(this, "Speech speed", "Velocidade da fala"), 13, false);
        l.setPadding(0, pad / 2, 0, 0);
        row.addView(l);
        Spinner sp = new Spinner(this);
        sp.setAdapter(new ArrayAdapter<String>(this, android.R.layout.simple_spinner_dropdown_item,
                new String[]{Api.t(this, "Slow", "Lenta"), "Normal", Api.t(this, "Fast", "Rápida")}));
        sp.setSelection(Api.rateIdx(this));
        sp.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override public void onItemSelected(AdapterView<?> p, View v, int pos, long id) {
                Api.setRateIdx(MainActivity.this, pos);
            }
            @Override public void onNothingSelected(AdapterView<?> p) { }
        });
        row.addView(sp);
        return row;
    }

    private View volRow(final String label, int value, final boolean pilot) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.VERTICAL);
        final TextView l = text(label + ": " + value + "%", 13, false);
        l.setPadding(0, pad / 2, 0, 0);
        row.addView(l);
        SeekBar sb = new SeekBar(this);
        sb.setMax(100);
        sb.setProgress(value);
        sb.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar s, int p, boolean user) {
                l.setText(label + ": " + p + "%");
                if (pilot) Api.setVolPilot(MainActivity.this, p); else Api.setVolCtl(MainActivity.this, p);
                RadioPlayer.refreshVolume();
            }
            @Override public void onStartTrackingTouch(SeekBar s) { }
            @Override public void onStopTrackingTouch(SeekBar s) { }
        });
        row.addView(sb);
        return row;
    }

    private static final int REQ_RADIO = 77;
    private static final long MAX_RADIO_BYTES = 100L * 1024 * 1024;
    private TextView radioFileLabel;

    private void showRadioName() {
        if (radioFileLabel == null) return;
        String n = Api.radioName(this);
        boolean has = Api.radioFile(this).exists() && !n.isEmpty();
        radioFileLabel.setText(Api.t(this, "Audio file: ", "Arquivo de áudio: ")
                + (has ? n : Api.t(this, "(none chosen)", "(nenhum escolhido)")));
    }

    private void pickRadioFile() {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("audio/*");
        startActivityForResult(i, REQ_RADIO);
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req != REQ_RADIO || res != RESULT_OK || data == null || data.getData() == null) return;
        final Uri uri = data.getData();
        final android.content.Context app = getApplicationContext();
        Toast.makeText(this, Api.t(this, "Loading audio file...", "Carregando arquivo de áudio..."), Toast.LENGTH_SHORT).show();
        new Thread(new Runnable() {
            @Override public void run() {
                String name = "audio";
                try {
                    Cursor c = app.getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null);
                    if (c != null) { try { if (c.moveToFirst() && !c.isNull(0)) name = c.getString(0); } finally { c.close(); } }
                } catch (Throwable ignored) { }
                File dst = Api.radioFile(app);
                File tmp = new File(dst.getPath() + ".tmp");
                boolean ok = false;
                String why = "";
                try {
                    InputStream in = app.getContentResolver().openInputStream(uri);
                    OutputStream out = new FileOutputStream(tmp);
                    try {
                        byte[] buf = new byte[65536];
                        long total = 0;
                        int n;
                        while ((n = in.read(buf)) > 0) {
                            total += n;
                            if (total > MAX_RADIO_BYTES) throw new IOException("too big");
                            out.write(buf, 0, n);
                        }
                    } finally {
                        try { in.close(); } catch (Throwable ignored) { }
                        out.close();
                    }
                    dst.delete();
                    ok = tmp.renameTo(dst);
                } catch (Throwable e) {
                    why = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
                }
                if (!ok) tmp.delete();
                final boolean fok = ok;
                final String fname = name, fwhy = why;
                ui.post(new Runnable() {
                    @Override public void run() {
                        if (fok) {
                            Api.setRadioName(app, fname);
                            RadioPlayer.settingsChanged(app);
                            showRadioName();
                            Toast.makeText(app, Api.t(app, "Audio file ready", "Arquivo de áudio pronto"), Toast.LENGTH_SHORT).show();
                        } else {
                            Toast.makeText(app, Api.t(app, "Could not load the file", "Não foi possível carregar o arquivo")
                                    + (fwhy.equals("too big") ? Api.t(app, " (over 100 MB)", " (mais de 100 MB)") : ""), Toast.LENGTH_LONG).show();
                        }
                    }
                });
            }
        }, "radio-copy").start();
    }

    /** Plays the radio right here so the chosen file can be checked without starting a flight. */
    private void toggleRadioTest() {
        radioTesting = !radioTesting;
        if (radioTesting) {
            RadioPlayer.start(this, "test");
            testBtn.setText(Api.t(this, "Stop test", "Parar teste"));
            ui.postDelayed(new Runnable() {
                @Override public void run() {
                    if (radioTesting) Toast.makeText(MainActivity.this, "Radio: " + RadioPlayer.state, Toast.LENGTH_SHORT).show();
                }
            }, 4000);
        } else {
            RadioPlayer.stop("test");
            testBtn.setText(Api.t(this, "Test radio", "Testar rádio"));
        }
    }

    private static final String[] LANG_CODES = {"en", "pt"};
    private static final String[] LANG_NAMES = {"English", "Português BR"};

    private View langRow(String label, String current, final boolean ui) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.VERTICAL);
        TextView l = text(label, 13, false);
        l.setPadding(0, pad / 2, 0, 0);
        row.addView(l);
        Spinner sp = new Spinner(this);
        sp.setAdapter(new ArrayAdapter<String>(this, android.R.layout.simple_spinner_dropdown_item, LANG_NAMES));
        sp.setSelection(current.equals("pt") ? 1 : 0);
        sp.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override public void onItemSelected(AdapterView<?> p, View v, int pos, long id) {
                String code = LANG_CODES[pos];
                if (ui) {
                    if (code.equals(Api.uiLang(MainActivity.this))) return;
                    Api.setUiLang(MainActivity.this, code);
                    PilotService.refreshNotif(MainActivity.this);
                    showSettings(); // redraw in the new language
                } else {
                    if (code.equals(Api.voiceLang(MainActivity.this))) return;
                    Api.setVoiceLang(MainActivity.this, code);
                    Api.setVoiceName(MainActivity.this, "");   // a voice belongs to one language
                    if (voiceSpinner != null) refreshVoices();
                }
            }
            @Override public void onNothingSelected(AdapterView<?> p) { }
        });
        row.addView(sp);
        return row;
    }

    // ---------- Pilot screen ----------
    private void showPilot() {
        LinearLayout root = column();
        root.addView(text(Api.t(this, "Pilot", "Piloto"), 24, true));

        callsignBox = addField(root, Api.t(this, "Callsign", "Indicativo"), Api.callsign(this), true, false);
        extra = new EditText[]{
                addField(root, Api.t(this, "Departure (ICAO)", "Partida (ICAO)"), Api.field(this, "dep"), true, false),
                addField(root, Api.t(this, "Arrival (ICAO)", "Chegada (ICAO)"), Api.field(this, "arr"), true, false),
                addField(root, Api.t(this, "Aircraft model", "Modelo da aeronave"), Api.field(this, "model"), true, false),
                addField(root, Api.t(this, "Airline / livery", "Companhia / pintura"), Api.field(this, "livery"), false, false),
                addField(root, Api.t(this, "Cruise alt (ft)", "Altitude de cruzeiro (ft)"), Api.field(this, "cruise"), false, true),
                addField(root, Api.t(this, "Squawk (4 digits)", "Squawk (4 dígitos)"), Api.field(this, "squawk"), false, true),
                addField(root, Api.t(this, "Route (optional)", "Rota (opcional)"), Api.field(this, "route"), true, false)};

        startStop = new Button(this);
        startStop.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { toggle(); }
        });
        root.addView(startStop);

        Button map = new Button(this);
        map.setText(Api.t(this, "Map", "Mapa"));
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
        startStop.setText(on ? Api.t(this, "Stop", "Parar") : Api.t(this, "Start", "Iniciar"));
        callsignBox.setEnabled(!on);
        for (EditText e : extra) e.setEnabled(!on);
        String raw = PilotService.lastRaw;
        if (raw.length() > 300) raw = raw.substring(0, 300) + "...";
        String shown = (Api.t(this, "State: ", "Estado: ") + (on ? Api.t(this, "flying", "voando") : Api.t(this, "stopped", "parado"))
                + Api.t(this, "\nSim link: ", "\nLink do sim: ") + PilotService.simState
                + Api.t(this, "\nServer: ", "\nServidor: ") + PilotService.serverState
                + Api.t(this, "\nUploads: ", "\nEnvios: ") + PilotService.okCount + " ok / " + PilotService.failCount + Api.t(this, " failed", " falhas")
                + (Api.radioOn(this) ? "\nRadio: " + RadioPlayer.state : "")
                + Api.t(this, "\nKey: ", "\nChave: ") + Api.key(this)
                + Api.t(this, "\n\nLast sim line:\n", "\n\nÚltima linha do sim:\n") + (raw.isEmpty() ? Api.t(this, "(none yet)", "(nenhuma ainda)") : raw));
        // Skip identical text so a text selection is not cleared by the 1 s refresh.
        if (!shown.equals(status.getText().toString())) status.setText(shown);
    }
}
