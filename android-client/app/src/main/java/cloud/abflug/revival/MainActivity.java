package cloud.abflug.revival;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.speech.tts.TextToSpeech;
import android.speech.tts.Voice;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
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

        // ----- Background radio stream -----
        TextView hdr = text(Api.t(this, "Background radio", "Rádio de fundo"), 18, true);
        hdr.setPadding(0, pad, 0, 0);
        root.addView(hdr);

        Switch st = new Switch(this);
        st.setText(Api.t(this, "Play radio stream (Pilot and Controller)", "Tocar rádio (Piloto e Controlador)"));
        st.setTextSize(16);
        st.setPadding(0, pad / 2, 0, pad / 4);
        st.setChecked(Api.streamOn(this));
        st.setOnCheckedChangeListener(new CompoundButton.OnCheckedChangeListener() {
            @Override public void onCheckedChanged(CompoundButton b, boolean on) {
                Api.setStreamOn(MainActivity.this, on);
                StreamPlayer.settingsChanged(MainActivity.this);
            }
        });
        root.addView(st);

        TextView ul = text(Api.t(this, "Stream URL (paste an MP3 stream link)", "URL do stream (cole um link de stream MP3)"), 13, false);
        ul.setPadding(0, pad / 4, 0, 0);
        root.addView(ul);
        EditText url = new EditText(this);
        url.setSingleLine(true);
        url.setHint("http://.../stream");
        url.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        url.setText(Api.streamUrl(this));
        url.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int a, int b, int c) { }
            @Override public void onTextChanged(CharSequence s, int a, int b, int c) { }
            @Override public void afterTextChanged(Editable s) { Api.setStreamUrl(MainActivity.this, s.toString().trim()); }
        });
        url.setOnFocusChangeListener(new View.OnFocusChangeListener() {
            @Override public void onFocusChange(View v, boolean has) {
                if (!has) StreamPlayer.settingsChanged(MainActivity.this);
            }
        });
        root.addView(url);

        root.addView(volRow(Api.t(this, "Volume - Pilot", "Volume - Piloto"), Api.volPilot(this), true));
        root.addView(volRow(Api.t(this, "Volume - Controller", "Volume - Controlador"), Api.volCtl(this), false));

        testBtn = new Button(this);
        testBtn.setText(streamTesting ? Api.t(this, "Stop test", "Parar teste") : Api.t(this, "Test stream", "Testar stream"));
        testBtn.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { toggleStreamTest(); }
        });
        root.addView(testBtn);

        ScrollView sv = new ScrollView(this);
        sv.addView(root);
        setContentView(sv);
    }

    // ---------- Settings helpers: voice picker, speed, stream test ----------
    private Spinner voiceSpinner;
    private TextToSpeech voiceTts;
    private final List<String> voiceNames = new ArrayList<String>();
    private Button testBtn;
    private boolean streamTesting;

    /** Releases everything the Settings screen holds (voice list engine, stream test). */
    private void leaveSettings() {
        closeVoiceTts();
        voiceSpinner = null;
        if (streamTesting) { streamTesting = false; StreamPlayer.stop("test"); }
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
                StreamPlayer.refreshVolume();
            }
            @Override public void onStartTrackingTouch(SeekBar s) { }
            @Override public void onStopTrackingTouch(SeekBar s) { }
        });
        row.addView(sb);
        return row;
    }

    /** Plays the stream right here so a pasted URL can be checked without starting a flight. */
    private void toggleStreamTest() {
        streamTesting = !streamTesting;
        if (streamTesting) {
            StreamPlayer.start(this, "test");
            testBtn.setText(Api.t(this, "Stop test", "Parar teste"));
            ui.postDelayed(new Runnable() {
                @Override public void run() {
                    if (streamTesting) Toast.makeText(MainActivity.this, "Radio: " + StreamPlayer.state, Toast.LENGTH_SHORT).show();
                }
            }, 4000);
        } else {
            StreamPlayer.stop("test");
            testBtn.setText(Api.t(this, "Test stream", "Testar stream"));
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
                + (Api.streamOn(this) ? "\nRadio: " + StreamPlayer.state : "")
                + Api.t(this, "\nKey: ", "\nChave: ") + Api.key(this)
                + Api.t(this, "\n\nLast sim line:\n", "\n\nÚltima linha do sim:\n") + (raw.isEmpty() ? Api.t(this, "(none yet)", "(nenhuma ainda)") : raw));
        // Skip identical text so a text selection is not cleared by the 1 s refresh.
        if (!shown.equals(status.getText().toString())) status.setText(shown);
    }
}
