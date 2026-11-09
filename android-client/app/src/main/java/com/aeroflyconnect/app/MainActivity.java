package com.aeroflyconnect.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.provider.Settings;
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
        root.setPadding(Ui.dp(this, 20), Ui.dp(this, 28), Ui.dp(this, 20), Ui.dp(this, 24));
        return root;
    }

    private TextView text(String s, int size, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(size);
        t.setTextColor(Ui.TXT);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private TextView dim(String s, int size) {
        TextView t = text(s, size, false);
        t.setTextColor(Ui.DIM);
        return t;
    }

    /** Small dim caption above a field or control. */
    private TextView fieldLabel(String s) {
        TextView t = dim(s, 12);
        t.setPadding(0, pad / 2, 0, pad / 8);
        return t;
    }

    /** A rounded card with a cyan caps title, added to root. */
    private LinearLayout section(LinearLayout root, String title) {
        LinearLayout c = Ui.card(this);
        c.addView(Ui.heading(this, title));
        root.addView(c, Ui.lp(this, 14));
        return c;
    }

    private Switch sw(String label, boolean on, CompoundButton.OnCheckedChangeListener l) {
        Switch s = new Switch(this);
        s.setText(label);
        s.setTextSize(15);
        s.setPadding(0, pad / 2, 0, pad / 6);
        s.setChecked(on);
        Ui.toggle(s);
        s.setOnCheckedChangeListener(l);
        return s;
    }

    private View menuCard(String title, String sub, View.OnClickListener click) {
        LinearLayout c = Ui.card(this);
        c.setBackground(Ui.ripple(this, Ui.CARD, Ui.STROKE, 16));
        c.setOnClickListener(click);
        TextView t = text(title, 20, true);
        t.setTextColor(Ui.CYAN);
        c.addView(t);
        TextView d = dim(sub, 13);
        d.setPadding(0, pad / 6, 0, 0);
        c.addView(d);
        return c;
    }

    // ---------- Start screen ----------
    private void showStart() {
        stopTicker();
        leaveSettings();
        status = null;
        inSettings = false;
        LinearLayout root = column();
        root.setGravity(Gravity.CENTER_HORIZONTAL);

        android.widget.ImageView logo = new android.widget.ImageView(this);
        logo.setImageResource(R.drawable.logo);
        root.addView(logo, new LinearLayout.LayoutParams(Ui.dp(this, 112), Ui.dp(this, 112)));
        TextView title = text("AEROFLY CONNECT", 22, true);
        title.setLetterSpacing(0.12f);
        title.setPadding(0, pad / 2, 0, 0);
        root.addView(title);
        TextView info = dim("v" + BuildConfig.VERSION_NAME, 12);
        info.setPadding(0, pad / 6, 0, pad);
        root.addView(info);

        menuOnline = dim("", 13);
        menuOnline.setGravity(Gravity.CENTER);
        menuOnline.setVisibility(View.GONE);
        root.addView(menuOnline, Ui.lp(this, 10));
        menuCrash = text("", 15, true);
        menuCrash.setGravity(Gravity.CENTER);
        menuCrash.setTextColor(Ui.RED);
        menuCrash.setPadding(pad / 2, pad / 2, pad / 2, pad / 2);
        menuCrash.setBackground(Ui.shape(this, 0xE6012C33, Ui.RED, 14));
        menuCrash.setVisibility(View.GONE);
        root.addView(menuCrash, Ui.lp(this, 12));

        root.addView(menuCard(Api.t(this, "Pilot", "Piloto"),
                Api.t(this, "Share your position and receive ATC messages", "Compartilhe sua posição e receba mensagens do ATC"),
                new View.OnClickListener() { @Override public void onClick(View v) { showPilot(); } }), Ui.lp(this, 12));
        root.addView(menuCard(Api.t(this, "Controller", "Controlador"),
                Api.t(this, "See the radar and message pilots", "Veja o radar e envie mensagens aos pilotos"),
                new View.OnClickListener() {
                    @Override public void onClick(View v) { startActivity(new Intent(MainActivity.this, ControllerActivity.class)); }
                }), Ui.lp(this, 12));

        Button set = Ui.button(this, Api.t(this, "Settings", "Configurações"), Ui.SECONDARY);
        set.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { showSettings(); }
        });
        root.addView(set, Ui.lp(this, 16));

        ScrollView sv = new ScrollView(this);
        sv.setFillViewport(true);
        sv.addView(root);
        setContentView(Ui.withBackground(this, sv, R.drawable.bg_start));
        startMenuTick();
    }

    // ---------- Start screen: online count + crash timeout ----------
    private TextView menuOnline, menuCrash;
    private Runnable menuTick;
    private int menuTicks;

    private void startMenuTick() {
        stopMenuTick();
        menuTicks = 0;
        menuTick = new Runnable() {
            @Override public void run() {
                if (menuOnline == null || menuTick != this) return;
                long left = Api.crashLeftMs(MainActivity.this);
                if (left > 0) {
                    menuCrash.setText(Api.t(MainActivity.this, "Crash timeout - you can fly again in ", "Tempo de espera após o acidente - você poderá voar em ") + Api.mmss(left));
                    menuCrash.setVisibility(View.VISIBLE);
                } else menuCrash.setVisibility(View.GONE);
                if (menuTicks++ % 15 == 0) fetchOnline();   // right away, then every 15 s
                ui.postDelayed(this, 1000);
            }
        };
        menuTick.run();
    }

    private void stopMenuTick() {
        if (menuTick != null) ui.removeCallbacks(menuTick);
        menuTick = null;
    }

    private void fetchOnline() {
        final String key = Api.key(this);
        new Thread(new Runnable() {
            @Override public void run() {
                int n = -1;
                try {
                    Api.Resp r = Api.request("GET", "/api/health", null, key);
                    if (r.code < 400) {
                        org.json.JSONObject j = new org.json.JSONObject(r.body);
                        n = j.has("pilots") ? j.optInt("pilots", -1) : j.optInt("active_clients", -1);
                    }
                } catch (Exception ignored) { }
                final int fn = n;
                ui.post(new Runnable() {
                    @Override public void run() {
                        TextView v = menuOnline;
                        if (v == null) return;
                        if (fn < 0) { v.setVisibility(View.GONE); return; }
                        v.setText("\u25CF " + fn + Api.t(MainActivity.this, fn == 1 ? " pilot flying" : " pilots flying", fn == 1 ? " piloto voando" : " pilotos voando"));
                        v.setTextColor(fn > 0 ? Ui.GREEN : Ui.DIM);
                        v.setVisibility(View.VISIBLE);
                    }
                });
            }
        }, "online-count").start();
    }

    // ---------- Settings ----------
    private boolean inSettings;
    private boolean awaitingOverlay;

    @Override
    protected void onResume() {
        super.onResume();
        // Back from the system permission screen: redraw Settings with the new state.
        if (awaitingOverlay) { awaitingOverlay = false; if (inSettings) showSettings(); }
    }

    private void showSettings() {
        stopTicker();
        status = null;
        inSettings = true;
        LinearLayout root = column();
        root.addView(text(Api.t(this, "Settings", "Configurações"), 24, true));

        LinearLayout lang = section(root, Api.t(this, "Language", "Idioma"));
        lang.addView(langRow(Api.t(this, "App language", "Idioma do app"), Api.uiLang(this), true));
        lang.addView(langRow(Api.t(this, "Voice language", "Idioma da voz"), Api.voiceLang(this), false));

        LinearLayout voice = section(root, Api.t(this, "ATC voice", "Voz do ATC"));
        voice.addView(sw(Api.t(this, "Speak ATC messages", "Falar mensagens do ATC"), Api.speakOn(this),
                new CompoundButton.OnCheckedChangeListener() {
                    @Override public void onCheckedChanged(CompoundButton b, boolean on) { Api.setSpeakOn(MainActivity.this, on); }
                }));
        voice.addView(voiceRow());
        voice.addView(rateRow());

        // ----- Floating ATC window (requests + Wilco / Unable over the sim) -----
        LinearLayout ov = section(root, Api.t(this, "ATC overlay", "Janela do ATC"));
        ov.addView(sw(Api.t(this, "Floating ATC window while flying", "Janela flutuante do ATC durante o voo"), Api.overlayOn(this),
                new CompoundButton.OnCheckedChangeListener() {
                    @Override public void onCheckedChanged(CompoundButton b, boolean on) { Api.setOverlayOn(MainActivity.this, on); }
                }));
        boolean granted = Settings.canDrawOverlays(this);
        TextView ovState = dim(granted
                ? Api.t(this, "Permission granted. Takes effect at the next Start.", "Permissão concedida. Vale a partir do próximo Iniciar.")
                : Api.t(this, "Needs the \"Display over other apps\" permission.", "Precisa da permissão \"Exibir sobre outros apps\"."), 13);
        ovState.setPadding(0, pad / 4, 0, 0);
        ov.addView(ovState);
        if (!granted) {
            Button allow = Ui.button(this, Api.t(this, "Allow overlay permission", "Permitir janela flutuante"), Ui.SECONDARY);
            allow.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) {
                    awaitingOverlay = true;
                    startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName())));
                }
            });
            ov.addView(allow, Ui.lp(this, 10));
        }

        // ----- Background radio (loops an audio file picked from the phone) -----
        LinearLayout radio = section(root, Api.t(this, "Background radio", "Rádio de fundo"));
        radio.addView(sw(Api.t(this, "Play background radio (Pilot and Controller)", "Tocar rádio de fundo (Piloto e Controlador)"),
                Api.radioOn(this), new CompoundButton.OnCheckedChangeListener() {
                    @Override public void onCheckedChanged(CompoundButton b, boolean on) {
                        Api.setRadioOn(MainActivity.this, on);
                        RadioPlayer.settingsChanged(MainActivity.this);
                    }
                }));

        radioFileLabel = dim("", 13);
        radioFileLabel.setPadding(0, pad / 4, 0, 0);
        showRadioName();
        radio.addView(radioFileLabel);
        Button pickBtn = Ui.button(this, Api.t(this, "Choose audio file", "Escolher arquivo de áudio"), Ui.SECONDARY);
        pickBtn.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { pickRadioFile(); }
        });
        radio.addView(pickBtn, Ui.lp(this, 10));

        radio.addView(volRow(Api.t(this, "Volume - Pilot", "Volume - Piloto"), Api.volPilot(this), true));
        radio.addView(volRow(Api.t(this, "Volume - Controller", "Volume - Controlador"), Api.volCtl(this), false));

        testBtn = Ui.button(this, radioTesting ? Api.t(this, "Stop test", "Parar teste") : Api.t(this, "Test radio", "Testar rádio"), Ui.SECONDARY);
        testBtn.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { toggleRadioTest(); }
        });
        radio.addView(testBtn, Ui.lp(this, 12));

        ScrollView sv = new ScrollView(this);
        sv.addView(root);
        setContentView(Ui.withBackground(this, sv, R.drawable.bg_settings));
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
        TextView l = fieldLabel(Api.t(this, "Voice", "Voz"));
        row.addView(l);
        voiceSpinner = new Spinner(this);
        Ui.spinner(this, voiceSpinner);
        voiceSpinner.setAdapter(new ArrayAdapter<String>(this, android.R.layout.simple_spinner_dropdown_item,
                new String[]{Api.t(this, "Loading...", "Carregando...")}));
        row.addView(voiceSpinner);
        Button test = Ui.button(this, Api.t(this, "Test voice", "Testar voz"), Ui.SECONDARY);
        test.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                String lang = Api.voiceLang(MainActivity.this);
                AtcVoice av = new AtcVoice(MainActivity.this, lang);
                av.speak(lang.equals("pt") ? "Código 4321, suba e mantenha nível de voo 100"
                        : "Squawk 4321, climb and maintain FL100", null);
                av.shutdown();   // finishes after the queued sentence
            }
        });
        row.addView(test, Ui.lp(this, 10));
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
        TextView l = fieldLabel(Api.t(this, "Speech speed", "Velocidade da fala"));
        row.addView(l);
        Spinner sp = new Spinner(this);
        Ui.spinner(this, sp);
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
        final TextView l = fieldLabel(label + ": " + value + "%");
        row.addView(l);
        SeekBar sb = new SeekBar(this);
        Ui.seek(sb);
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
        TextView l = fieldLabel(label);
        row.addView(l);
        Spinner sp = new Spinner(this);
        Ui.spinner(this, sp);
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
    private TextView statusHead;
    private Boolean lastOn;

    private void showPilot() {
        lastOn = null;
        LinearLayout root = column();
        root.addView(text(Api.t(this, "Pilot", "Piloto"), 24, true));

        LinearLayout card = section(root, Api.t(this, "Flight", "Voo"));
        callsignBox = addField(card, Api.t(this, "Callsign", "Indicativo"), Api.callsign(this), true, false);
        LinearLayout r1 = fieldRow(card);
        EditText dep = addField(r1, Api.t(this, "Departure (ICAO)", "Partida (ICAO)"), Api.field(this, "dep"), true, false);
        EditText arr = addField(r1, Api.t(this, "Arrival (ICAO)", "Chegada (ICAO)"), Api.field(this, "arr"), true, false);
        LinearLayout rw = fieldRow(card);
        EditText deprwy = addField(rw, Api.t(this, "Dep runway (e.g. 29L)", "Pista de partida (ex. 29L)"), Api.field(this, "deprwy"), true, false);
        EditText arrrwy = addField(rw, Api.t(this, "Arr runway (e.g. 11R)", "Pista de chegada (ex. 11R)"), Api.field(this, "arrrwy"), true, false);
        LinearLayout r2 = fieldRow(card);
        EditText model = addField(r2, Api.t(this, "Aircraft model", "Modelo da aeronave"), Api.field(this, "model"), true, false);
        EditText livery = addField(r2, Api.t(this, "Airline / livery", "Companhia / pintura"), Api.field(this, "livery"), false, false);
        EditText cruise = addField(card, Api.t(this, "Cruise alt (ft)", "Altitude de cruzeiro (ft)"), Api.field(this, "cruise"), false, true);
        EditText route = addField(card, Api.t(this, "Route (optional)", "Rota (opcional)"), Api.field(this, "route"), true, false);
        extra = new EditText[]{dep, arr, deprwy, arrrwy, model, livery, cruise, route};   // same order as EXTRA_KEYS

        startStop = Ui.button(this, "", Ui.PRIMARY);
        startStop.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { toggle(); }
        });
        root.addView(startStop, Ui.lp(this, 16));

        Button map = Ui.button(this, Api.t(this, "Map", "Mapa"), Ui.SECONDARY);
        map.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                startActivity(new Intent(MainActivity.this, MapActivity.class));
            }
        });
        root.addView(map, Ui.lp(this, 10));

        LinearLayout sc = section(root, "Status");
        statusHead = text("", 16, true);
        statusHead.setPadding(0, pad / 3, 0, 0);
        sc.addView(statusHead);
        status = text("", 13, false);
        status.setPadding(0, pad / 3, 0, 0);
        status.setTypeface(Typeface.MONOSPACE);
        status.setTextIsSelectable(true);
        sc.addView(status);

        ScrollView sv = new ScrollView(this);
        sv.addView(root);
        setContentView(Ui.withBackground(this, sv, R.drawable.bg_pilot));
        startTicker();
    }

    private EditText[] extra;
    private static final String[] EXTRA_KEYS = {"dep", "arr", "deprwy", "arrrwy", "model", "livery", "cruise", "route"};

    /** Horizontal row that holds two fields side by side. */
    private LinearLayout fieldRow(LinearLayout parent) {
        LinearLayout r = new LinearLayout(this);
        r.setOrientation(LinearLayout.HORIZONTAL);
        parent.addView(r, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        return r;
    }

    private EditText addField(LinearLayout parent, String label, String value, boolean caps, boolean digits) {
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.addView(fieldLabel(label));
        EditText e = new EditText(this);
        e.setSingleLine(true);
        e.setInputType(digits ? InputType.TYPE_CLASS_NUMBER
                : InputType.TYPE_CLASS_TEXT | (caps ? InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS : 0));
        e.setText(value);
        Ui.field(this, e);
        col.addView(e);
        if (parent.getOrientation() == LinearLayout.HORIZONTAL) {
            LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
            if (parent.getChildCount() > 0) p.leftMargin = Ui.dp(this, 10);
            parent.addView(col, p);
        } else {
            parent.addView(col);
        }
        return e;
    }

    private void toggle() {
        if (PilotService.running) {
            Intent i = new Intent(this, PilotService.class);
            i.setAction(PilotService.ACTION_STOP);
            startService(i);
        } else {
            long crashLeft = Api.crashLeftMs(this);
            if (crashLeft > 0) {   // hard-landing timeout
                Toast.makeText(this, Api.t(this, "Crash timeout - you can fly again in ", "Tempo de espera após o acidente - você poderá voar em ") + Api.mmss(crashLeft), Toast.LENGTH_LONG).show();
                return;
            }
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
        stopMenuTick();
        menuOnline = null; menuCrash = null;
        if (ticker != null) ui.removeCallbacks(ticker);
        ticker = null;
    }

    private void refresh() {
        if (status == null) return;
        boolean on = PilotService.running;
        startStop.setText(on ? Api.t(this, "Stop", "Parar") : Api.t(this, "Start", "Iniciar"));
        if (lastOn == null || lastOn != on) {   // restyle only on change, so a press ripple is not reset every second
            lastOn = on;
            Ui.kind(this, startStop, on ? Ui.DANGER : Ui.PRIMARY);
        }
        statusHead.setText("\u25CF " + (on ? Api.t(this, "FLYING", "VOANDO") : Api.t(this, "STOPPED", "PARADO")));
        statusHead.setTextColor(on ? Ui.GREEN : Ui.DIM);
        callsignBox.setEnabled(!on);
        for (EditText e : extra) e.setEnabled(!on);
        String raw = PilotService.lastRaw;
        if (raw.length() > 300) raw = raw.substring(0, 300) + "...";
        String shown = (Api.t(this, "Sim link: ", "Link do sim: ") + PilotService.simState
                + Api.t(this, "\nServer: ", "\nServidor: ") + PilotService.serverState
                + Api.t(this, "\nUploads: ", "\nEnvios: ") + PilotService.okCount + " ok / " + PilotService.failCount + Api.t(this, " failed", " falhas")
                + (Api.radioOn(this) ? "\nRadio: " + RadioPlayer.state : "")
                + Api.t(this, "\nKey: ", "\nChave: ") + Api.key(this)
                + Api.t(this, "\n\nLast sim line:\n", "\n\nÚltima linha do sim:\n") + (raw.isEmpty() ? Api.t(this, "(none yet)", "(nenhuma ainda)") : raw));
        // Skip identical text so a text selection is not cleared by the 1 s refresh.
        if (!shown.equals(status.getText().toString())) status.setText(shown);
    }
}
