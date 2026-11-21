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
        info.setTextColor(0xFFFFFFFF);
        info.setPadding(0, pad / 6, 0, pad);
        root.addView(info);

        menuOnline = dim("", 13);
        menuOnline.setGravity(Gravity.CENTER);
        menuOnline.setVisibility(View.GONE);
        root.addView(menuOnline, Ui.lp(this, 10));
        menuUpd = text("", 14, true);
        menuUpd.setGravity(Gravity.CENTER);
        menuUpd.setTextColor(0xFFFFC107);
        menuUpd.setVisibility(View.GONE);
        menuUpd.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://github.com/CaydanDaviau/Aerofly-Connect/releases/tag/android-latest")));
        } });
        root.addView(menuUpd, Ui.lp(this, 10));
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
        root.addView(menuCard(Api.t(this, "Training", "Treino"),
                Api.t(this, "Practice Tower and Approach with AI traffic", "Pratique Torre e Aproximação com tráfego de IA"),
                new View.OnClickListener() {
                    @Override public void onClick(View v) { startActivity(new Intent(MainActivity.this, ControllerActivity.class).putExtra("page", "train")); }
                }), Ui.lp(this, 12));

        Button prof = Ui.button(this, Api.t(this, "Profile", "Perfil"), Ui.SECONDARY);
        prof.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { showProfile(); }
        });
        root.addView(prof, Ui.lp(this, 12));

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
    private TextView menuOnline, menuCrash, menuUpd;
    private Runnable menuTick;
    private int menuTicks;
    private String menuGroup = "";

    private void startMenuTick() {
        stopMenuTick();
        menuTicks = 0;
        menuTick = new Runnable() {
            @Override public void run() {
                if (menuOnline == null || menuTick != this) return;
                long left = Api.crashLeftMs(MainActivity.this);
                if (left > 0) {
                    menuCrash.setText(Api.t(MainActivity.this, "Timeout - you can fly again in ", "Tempo de espera - você poderá voar em ") + Api.mmss(left));
                    menuCrash.setVisibility(View.VISIBLE);
                } else menuCrash.setVisibility(View.GONE);
                // the online count goes through the WebSocket (one connection instead of a request every 15 s); during a flight the service owns the socket
                if (!PilotService.running) {
                    if (!menuGroup.equals(Api.group)) { menuGroup = Api.group; WsLink.close(); }
                    WsLink.ensure(Api.key(MainActivity.this), false, 0, 0, System.currentTimeMillis());
                }
                if (menuTicks++ % 15 == 0) fetchOnline();   // right away, then every 15 s
                ui.postDelayed(this, 1000);
            }
        };
        menuTick.run();
    }

    private void stopMenuTick() {
        if (menuTick != null) ui.removeCallbacks(menuTick);
        menuTick = null;
        if (!PilotService.running) WsLink.close();
    }

    /** True when version a ("1.1.3") is newer than b. */
    private static boolean newer(String a, String b) {
        if (a == null || a.isEmpty()) return false;
        String[] x = a.split("\\."), y = b.split("\\.");
        for (int i = 0; i < Math.max(x.length, y.length); i++) {
            int p, q;
            try { p = i < x.length ? Integer.parseInt(x[i].replaceAll("\\D", "")) : 0; q = i < y.length ? Integer.parseInt(y[i].replaceAll("\\D", "")) : 0; } catch (Exception e) { return false; }
            if (p != q) return p > q;
        }
        return false;
    }

    private void fetchOnline() {
        final String key = Api.key(this);
        new Thread(new Runnable() {
            @Override public void run() {
                int n = -1; String latest = "";
                try {
                    Api.Resp r = Api.request("GET", "/api/health", null, key);
                    if (r.code < 400) {
                        org.json.JSONObject j = new org.json.JSONObject(r.body);
                        n = j.has("pilots") ? j.optInt("pilots", -1) : j.optInt("active_clients", -1);
                        latest = j.optString("latest_android", "");
                    }
                } catch (Exception ignored) { }
                final int fn = n; final String fl = latest;
                ui.post(new Runnable() {
                    @Override public void run() {
                        TextView u = menuUpd;
                        if (u != null) {
                            boolean old = newer(fl, BuildConfig.VERSION_NAME);
                            u.setVisibility(old ? View.VISIBLE : View.GONE);
                            if (old) u.setText(Api.t(MainActivity.this, "Update available: v" + fl + " (tap to download)", "Atualização disponível: v" + fl + " (toque para baixar)"));
                        }
                        TextView v = menuOnline;
                        if (v == null) return;
                        if (fn < 0) { v.setVisibility(View.GONE); return; }
                        v.setText("\u25CF " + fn + Api.t(MainActivity.this, fn == 1 ? " pilot flying" : " pilots flying", fn == 1 ? " piloto voando" : " pilotos voando"));
                        v.setTextColor(Ui.CYAN);
                        v.setTypeface(Typeface.DEFAULT_BOLD);
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

    // ---------- Profile: nickname (server) + flight time + ATC time ----------
    private void showProfile() {
        stopTicker();
        status = null;
        inSettings = true;   // Back returns to the start screen
        LinearLayout root = column();
        root.addView(text(Api.t(this, "Profile", "Perfil"), 24, true));
        LinearLayout card = section(root, Api.t(this, "Pilot / controller", "Piloto / controlador"));
        final EditText nick = addField(card, Api.t(this, "Nickname", "Apelido"), "", false, false);
        nick.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(20)});
        final TextView flight = text("", 18, true), atc = text("", 18, true), flights = text("", 18, true);
        card.addView(dim(Api.t(this, "Flight time (in the air)", "Tempo de voo (no ar)"), 13));
        card.addView(flight);
        card.addView(dim(Api.t(this, "Flights completed", "Voos concluídos"), 13));
        card.addView(flights);
        card.addView(dim(Api.t(this, "ATC time (holding a division)", "Tempo de ATC (com uma divisão)"), 13));
        card.addView(atc);
        final TextView lands = text("--", 18, true), viols = text("--", 18, true), pgrade = text("--", 18, true), agrade = text("--", 18, true), nextReq = dim("", 13);
        card.addView(dim(Api.t(this, "Landings", "Pousos"), 13));
        card.addView(lands);
        card.addView(dim(Api.t(this, "Penalties / Violations (today)", "Penalidades / Infrações (hoje)"), 13));
        card.addView(viols);
        card.addView(dim(Api.t(this, "Pilot grade", "Nível de piloto"), 13));
        card.addView(pgrade);
        card.addView(dim(Api.t(this, "Controller grade", "Nível de controlador"), 13));
        card.addView(agrade);
        card.addView(nextReq);
        flight.setText("--"); atc.setText("--"); flights.setText("--");
        final Button save = Ui.button(this, Api.t(this, "Save nickname", "Salvar apelido"), Ui.PRIMARY);
        root.addView(save, Ui.lp(this, 12));
        final String key = Api.key(this);
        final boolean[] loaded = {false};
        final Runnable[] done = new Runnable[1];
        new Thread(new Runnable() {
            @Override public void run() {
                try {
                    Api.Resp r = Api.request("GET", "/api/profile", null, key);
                    if (r.code < 400) {
                        final org.json.JSONObject j = new org.json.JSONObject(r.body);
                        ui.post(new Runnable() {
                            @Override public void run() {
                                if (!inSettings) return;
                                loaded[0] = true;
                                nick.setText(j.optString("nick", ""));
                                flight.setText(hm(j.optLong("flight_s", 0)));
                                atc.setText(hm(j.optLong("atc_s", 0)));
                                flights.setText(String.valueOf(j.optLong("flights", 0)));
                                lands.setText(String.valueOf(j.optLong("landings", 0)));
                                viols.setText(j.optLong("penalties_today", 0) + "/" + j.optLong("penalty_limit", 10) + "  ·  " + j.optLong("violations_today", 0) + "/" + j.optLong("violation_limit", 3));
                                pgrade.setText(j.optString("pilot_grade", "--"));
                                boolean allRoles = j.optBoolean("all_roles", false);
                                agrade.setText(allRoles ? Api.t(MainActivity.this, "All roles (Network)", "Todas as funções (Network)") : j.optString("atc_grade_name", "--"));
                                String ng = j.optString("next_grade", "");
                                org.json.JSONArray rq = j.optJSONArray("next_req");
                                if (!ng.isEmpty() && !allRoles && rq != null) {
                                    StringBuilder sb = new StringBuilder(Api.t(MainActivity.this, "Next grade: ", "Próximo nível: ") + ng + " - ");
                                    for (int i = 0; i < rq.length(); i++) {
                                        org.json.JSONObject q = rq.optJSONObject(i); if (q == null) continue;
                                        String k = q.optString("k"); long have = q.optLong("have"), need = q.optLong("need");
                                        String nm = k.equals("atc_s") ? Api.t(MainActivity.this, "ATC time", "Tempo de ATC")
                                                : k.equals("gw") ? Api.t(MainActivity.this, "ground work actions", "ações de solo")
                                                : k.equals("ops") ? Api.t(MainActivity.this, "takeoffs/landings at your airport", "decolagens/pousos no seu aeroporto")
                                                : Api.t(MainActivity.this, "APP time", "Tempo de APP");
                                        boolean isTime = k.endsWith("_s");
                                        sb.append(i > 0 ? ", " : "").append(nm).append(' ').append(isTime ? (have / 360) / 10.0 + "/" + (need / 3600) + " h" : have + "/" + need);
                                    }
                                    nextReq.setText(sb.toString());
                                }
                            }
                        });
                    }
                } catch (Exception ignored) { }
            }
        }).start();
        save.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                final String n = nick.getText().toString().trim();
                new Thread(new Runnable() {
                    @Override public void run() {
                        int code = -1; String why = "";
                        try {
                            Api.Resp r = Api.request("PUT", "/api/profile", new org.json.JSONObject().put("nick", n).toString(), key);
                            code = r.code; why = r.body;
                        } catch (Exception e) { why = String.valueOf(e); }
                        final boolean fok = code >= 200 && code < 400;
                        final String fmsg = code < 0 ? Api.t(MainActivity.this, "No connection", "Sem conexão") : "HTTP " + code + " " + (why.length() > 80 ? why.substring(0, 80) : why);
                        ui.post(new Runnable() {
                            @Override public void run() {
                                Toast.makeText(MainActivity.this, fok ? Api.t(MainActivity.this, "Saved", "Salvo") : fmsg, Toast.LENGTH_LONG).show();
                            }
                        });
                    }
                }).start();
            }
        });
        ScrollView sv = new ScrollView(this);
        sv.addView(root);
        setContentView(Ui.withBackground(this, sv, R.drawable.bg_settings));
    }

    private static String hm(long s) {
        long m = s / 60;
        return (m / 60) + " h " + String.format(java.util.Locale.US, "%02d", m % 60) + " min";
    }

    private void showSettings() {
        stopTicker();
        status = null;
        inSettings = true;
        LinearLayout root = column();
        root.addView(text(Api.t(this, "Settings", "Configurações"), 24, true));

        // ----- Account -----
        LinearLayout acc = section(root, Api.t(this, "Account", "Conta"));
        final String accName = Api.accountName(this);
        if (!accName.isEmpty()) {
            acc.addView(text(Api.t(this, "Signed in as ", "Conectado como ") + accName, 18, true));
            TextView ah = dim(Api.t(this, "Your hours and profile follow you on every device you sign in on.",
                    "Suas horas e perfil acompanham você em qualquer aparelho em que entrar."), 13);
            ah.setPadding(0, pad / 4, 0, pad / 2);
            acc.addView(ah);
            final EditText po = addField(acc, Api.t(this, "Current password", "Senha atual"), "", false, false);
            po.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);
            final EditText pn = addField(acc, Api.t(this, "New password (6+ characters)", "Nova senha (6+ caracteres)"), "", false, false);
            pn.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);
            Button chg = Ui.button(this, Api.t(this, "Change password", "Alterar senha"), Ui.SECONDARY);
            acc.addView(chg, Ui.lp(this, 8));
            chg.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) {
                    final String o0 = po.getText().toString(), n0 = pn.getText().toString();
                    final String tk0 = Api.token(MainActivity.this);
                    new Thread(new Runnable() { @Override public void run() {
                        String msg;
                        try {
                            Api.Resp r = Api.request("POST", "/api/account/password", new org.json.JSONObject().put("old", o0).put("new", n0).toString(), tk0);
                            String er = ""; try { er = new org.json.JSONObject(r.body).optString("error", ""); } catch (Exception ignored) { }
                            msg = r.code < 400 ? Api.t(MainActivity.this, "Password changed. Other devices were signed out.", "Senha alterada. Outros aparelhos foram desconectados.")
                                    : er.equals("bad_password") ? Api.t(MainActivity.this, "Password must have 6+ characters", "A senha deve ter 6+ caracteres")
                                    : er.equals("bad_login") ? Api.t(MainActivity.this, "Wrong current password", "Senha atual incorreta")
                                    : er.equals("too_many_attempts") ? Api.t(MainActivity.this, "Too many attempts, wait 10 min", "Muitas tentativas, espere 10 min")
                                    : "HTTP " + r.code;
                        } catch (Exception e) { msg = Api.t(MainActivity.this, "No connection", "Sem conexão"); }
                        final String m2 = msg;
                        ui.post(new Runnable() { @Override public void run() { Toast.makeText(MainActivity.this, m2, Toast.LENGTH_LONG).show(); po.setText(""); pn.setText(""); } });
                    } }).start();
                }
            });
            Button out = Ui.button(this, Api.t(this, "Sign out", "Sair"), Ui.SECONDARY);
            acc.addView(out, Ui.lp(this, 8));
            out.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) {
                    if (PilotService.running) { Toast.makeText(MainActivity.this, Api.t(MainActivity.this, "Stop the flight first.", "Pare o voo primeiro."), Toast.LENGTH_SHORT).show(); return; }
                    final String tk = Api.token(MainActivity.this);
                    Api.setAccount(MainActivity.this, "", "");
                    new Thread(new Runnable() { @Override public void run() { try { Api.request("POST", "/api/account/logout", "{}", tk); } catch (Exception ignored) { } } }).start();
                    showSettings();
                }
            });
        } else {
            final EditText an = addField(acc, Api.t(this, "Account name", "Nome da conta"), "", false, false);
            an.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);
            final EditText ap = addField(acc, Api.t(this, "Password (6+ characters)", "Senha (6+ caracteres)"), "", false, false);
            ap.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
            TextView ah = dim(Api.t(this, "Optional. Signing in or creating an account adds this device's hours to it. No email: a forgotten password cannot be recovered.",
                    "Opcional. Entrar ou criar conta soma as horas deste aparelho. Sem e-mail: senha esquecida não pode ser recuperada."), 13);
            ah.setPadding(0, pad / 4, 0, pad / 2);
            acc.addView(ah);
            final Button login = Ui.button(this, Api.t(this, "Log in", "Entrar"), Ui.PRIMARY);
            Button reg = Ui.button(this, Api.t(this, "Create account", "Criar conta"), Ui.SECONDARY);
            acc.addView(login, Ui.lp(this, 8));
            acc.addView(reg, Ui.lp(this, 8));
            View.OnClickListener go = new View.OnClickListener() {
                @Override public void onClick(View v) {
                    if (PilotService.running) { Toast.makeText(MainActivity.this, Api.t(MainActivity.this, "Stop the flight first.", "Pare o voo primeiro."), Toast.LENGTH_SHORT).show(); return; }
                    final boolean isReg = v != login;
                    final String n = an.getText().toString().trim(), pw = ap.getText().toString();
                    if (n.isEmpty() || pw.isEmpty()) return;
                    final String dk = Api.deviceKey(MainActivity.this);
                    new Thread(new Runnable() {
                        @Override public void run() {
                            String msg; boolean okk = false; String tk = "", nm = "";
                            try {
                                org.json.JSONObject o = new org.json.JSONObject();
                                o.put("name", n); o.put("password", pw);
                                Api.Resp r = Api.request("POST", isReg ? "/api/account/register" : "/api/account/login", o.toString(), dk);
                                String err = "";
                                try { org.json.JSONObject j = new org.json.JSONObject(r.body); err = j.optString("error", ""); tk = j.optString("token", ""); nm = j.optString("name", n); } catch (Exception ignored) { }
                                if (r.code < 300 && !tk.isEmpty()) { okk = true; msg = Api.t(MainActivity.this, "Signed in as ", "Conectado como ") + nm; }
                                else if (err.equals("name_taken")) msg = Api.t(MainActivity.this, "That name is taken.", "Esse nome já existe.");
                                else if (err.equals("bad_name")) msg = Api.t(MainActivity.this, "Name: 3-20 letters, digits, _ . -", "Nome: 3-20 letras, números, _ . -");
                                else if (err.equals("bad_password")) msg = Api.t(MainActivity.this, "Password must have 6+ characters.", "A senha precisa ter 6+ caracteres.");
                                else if (err.equals("bad_login")) msg = Api.t(MainActivity.this, "Wrong name or password.", "Nome ou senha incorretos.");
                                else if (err.equals("too_many_attempts")) msg = Api.t(MainActivity.this, "Too many attempts. Try again in 10 minutes.", "Muitas tentativas. Tente em 10 minutos.");
                                else msg = Api.t(MainActivity.this, "Failed (HTTP ", "Falhou (HTTP ") + r.code + ")";
                            } catch (Exception e) { msg = Api.t(MainActivity.this, "No connection", "Sem conexão"); }
                            final boolean fok = okk; final String fm = msg, ftk = tk, fnm = nm;
                            ui.post(new Runnable() {
                                @Override public void run() {
                                    Toast.makeText(MainActivity.this, fm, Toast.LENGTH_LONG).show();
                                    if (fok) { Api.setAccount(MainActivity.this, ftk, fnm); if (inSettings) showSettings(); }
                                }
                            });
                        }
                    }).start();
                }
            };
            login.setOnClickListener(go);
            reg.setOnClickListener(go);
        }

        // ----- Group code -----
        LinearLayout grp = section(root, Api.t(this, "Aerofly Connect ATC Network", "Aerofly Connect ATC Network"));
        Api.key(this);   // loads Api.group
        final EditText grpIn = addField(grp, Api.t(this, "Network code from Discord (optional)", "Código da rede do Discord (opcional)"), Api.group, false, false);
        grpIn.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);   // no autocorrect/auto-capital
        grpIn.addTextChangedListener(new android.text.TextWatcher() {
            @Override public void beforeTextChanged(CharSequence c, int a, int b, int d) { }
            @Override public void onTextChanged(CharSequence c, int a, int b, int d) { }
            @Override public void afterTextChanged(android.text.Editable e) { Api.setGroup(MainActivity.this, e.toString()); }
        });
        TextView grpHint = dim(Api.t(this, "Network members only see each other (separate from the public section). Takes effect at the next Start.",
                "Membros da rede só veem uns aos outros (separado da seção pública). Vale a partir do próximo Iniciar."), 13);
        grpHint.setPadding(0, pad / 4, 0, 0);
        grp.addView(grpHint);

        // ----- Sim on another device (first card) -----
        LinearLayout simc = section(root, Api.t(this, "Sim on a different device", "Sim em outro aparelho"));
        final LinearLayout simBox = new LinearLayout(this);
        simBox.setOrientation(LinearLayout.VERTICAL);
        simc.addView(sw(Api.t(this, "Aerofly runs on another device", "O Aerofly roda em outro aparelho"), Api.simRemote(this),
                new CompoundButton.OnCheckedChangeListener() {
                    @Override public void onCheckedChanged(CompoundButton b, boolean on) {
                        Api.setSimRemote(MainActivity.this, on);
                        simBox.setVisibility(on ? View.VISIBLE : View.GONE);
                    }
                }));
        final EditText simip = addField(simBox, Api.t(this, "IP address of the device running the sim", "Endereço IP do aparelho que roda o sim"), Api.field(this, "simip"), false, false);
        simip.addTextChangedListener(new android.text.TextWatcher() {
            @Override public void beforeTextChanged(CharSequence c, int a, int b, int d) { }
            @Override public void onTextChanged(CharSequence c, int a, int b, int d) { }
            @Override public void afterTextChanged(android.text.Editable e) { Api.setField(MainActivity.this, "simip", e.toString().trim()); }
        });
        TextView simHint = dim(Api.t(this, "Use its Wi-Fi IP on the same network or hotspot (not a 192.0.0.x mobile address). Takes effect at the next Start.",
                "Use o IP do Wi-Fi dele, na mesma rede ou ponto de acesso (não um endereço móvel 192.0.0.x). Vale a partir do próximo Iniciar."), 13);
        simHint.setPadding(0, pad / 4, 0, 0);
        simBox.addView(simHint);
        simBox.setVisibility(Api.simRemote(this) ? View.VISIBLE : View.GONE);
        simc.addView(simBox);

        // ----- Aerofly FS on a PC (UDP 49002) -----
        LinearLayout pcc = section(root, Api.t(this, "Aerofly FS on a PC", "Aerofly FS no PC"));
        pcc.addView(sw(Api.t(this, "Sim runs on a PC (UDP port 49002)", "O sim roda em um PC (porta UDP 49002)"), Api.pcMode(this),
                new CompoundButton.OnCheckedChangeListener() {
                    @Override public void onCheckedChanged(CompoundButton b, boolean on) { Api.setPcMode(MainActivity.this, on); }
                }));
        String myIp = PcLink.localIp();
        TextView pcHint = dim(Api.t(this, "In Aerofly FS on the PC, turn on flight data output to this phone's IP address" + (myIp.isEmpty() ? " (connect to the same Wi-Fi or hotspot first)" : ": " + myIp) + ", port 49002. Phone and PC must be on the same network. Takes effect at the next Start; overrides the other-device option above.",
                "No Aerofly FS do PC, ative o envio de dados de voo para o IP deste celular" + (myIp.isEmpty() ? " (conecte antes à mesma rede Wi-Fi ou ponto de acesso)" : ": " + myIp) + ", porta 49002. Celular e PC precisam estar na mesma rede. Vale a partir do próximo Iniciar; substitui a opção de outro aparelho acima."), 13);
        pcHint.setPadding(0, pad / 4, 0, 0);
        pcc.addView(pcHint);

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

        // ----- Auto ATC on/off -----
        LinearLayout aa = section(root, Api.t(this, "Auto ATC", "ATC automático"));
        aa.addView(sw(Api.t(this, "Automatic ATC when no controller is online", "ATC automático quando não há controlador online"), Api.autoAtcOn(this),
                new CompoundButton.OnCheckedChangeListener() {
                    @Override public void onCheckedChanged(CompoundButton b, boolean on) { Api.setAutoAtcOn(MainActivity.this, on); }
                }));
        TextView aaHint = dim(Api.t(this, "Off: no automatic clearances or messages, and requests get no automatic answer. A human controller still works normally. Takes effect within a few seconds.",
                "Desligado: sem autorizações ou mensagens automáticas, e os pedidos não recebem resposta automática. Um controlador humano continua normal. Vale em poucos segundos."), 13);
        aaHint.setPadding(0, pad / 4, 0, 0);
        aa.addView(aaHint);

        // ----- Voice chat (push-to-talk with the controller) -----
        LinearLayout vc = section(root, Api.t(this, "Voice chat", "Chat de voz"));
        vc.addView(sw(Api.t(this, "Push-to-talk voice with ATC (hear and send clips)", "Voz push-to-talk com o ATC (ouvir e enviar)"), Api.voiceOn(this),
                new CompoundButton.OnCheckedChangeListener() {
                    @Override public void onCheckedChanged(CompoundButton b, boolean on) {
                        Api.setVoiceOn(MainActivity.this, on);
                        if (on && !Mic.permitted(MainActivity.this)) requestPermissions(new String[] { android.Manifest.permission.RECORD_AUDIO }, 4);
                    }
                }));
        TextView vcHint = dim(Api.t(this, "Needs the microphone permission (asked when you switch on). Takes effect at the next Start. with Voice off, controllers see that you cannot listen.",
                "Precisa da permissão do microfone (pedida ao ligar). Vale a partir do próximo Iniciar. com a voz desligada, os controladores veem que você não pode ouvir."), 13);
        vcHint.setPadding(0, pad / 4, 0, 0);
        vc.addView(vcHint);

        // ----- SimBrief (import a flight plan on the Pilot screen) -----
        LinearLayout sbc = section(root, "SimBrief");
        final EditText sbUser = addField(sbc, Api.t(this, "SimBrief username or Pilot ID", "Usuário ou Pilot ID do SimBrief"), Api.field(this, "sbuser"), false, false);
        sbUser.addTextChangedListener(new android.text.TextWatcher() {
            @Override public void beforeTextChanged(CharSequence c, int a, int b, int d) { }
            @Override public void onTextChanged(CharSequence c, int a, int b, int d) { }
            @Override public void afterTextChanged(android.text.Editable e) { Api.setField(MainActivity.this, "sbuser", e.toString().trim()); }
        });
        TextView sbHint = dim(Api.t(this, "Then tap \"Import from SimBrief\" on the Pilot screen. Needs a generated plan and a public profile.",
                "Depois toque em \"Importar do SimBrief\" na tela do Piloto. Precisa de um plano gerado e perfil público."), 13);
        sbHint.setPadding(0, pad / 4, 0, 0);
        sbc.addView(sbHint);

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
        EditText livery = addField(r2, Api.t(this, "Registration (e.g. N899SB)", "Matrícula (ex. PR-ABC)"), Api.field(this, "livery"), false, false);
        EditText cruise = addField(card, Api.t(this, "Cruise alt (ft)", "Altitude de cruzeiro (ft)"), Api.field(this, "cruise"), false, true);
        EditText route = addField(card, Api.t(this, "Route (optional)", "Rota (opcional)"), Api.field(this, "route"), true, false);
        extra = new EditText[]{dep, arr, deprwy, arrrwy, model, livery, cruise, route};   // same order as EXTRA_KEYS

        importBtn = Ui.button(this, Api.t(this, "Import from SimBrief", "Importar do SimBrief"), Ui.SECONDARY);
        importBtn.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { importSimBrief(); }
        });
        card.addView(importBtn, Ui.lp(this, 10));

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
    private Button importBtn;

    /** Fills the Flight card from the latest SimBrief plan; the route is stored and uploaded at the next Start. */
    private void importSimBrief() {
        if (PilotService.running) return;
        final String user = Api.field(this, "sbuser").trim();
        if (user.isEmpty()) {
            Toast.makeText(this, Api.t(this, "Enter your SimBrief username in Settings first.", "Informe seu usuário do SimBrief em Configurações primeiro."), Toast.LENGTH_LONG).show();
            return;
        }
        importBtn.setEnabled(false);
        Toast.makeText(this, Api.t(this, "Importing from SimBrief...", "Importando do SimBrief..."), Toast.LENGTH_SHORT).show();
        SimBrief.fetch(user, new SimBrief.Cb() {
            @Override public void done(final SimBrief.Plan p) {
                ui.post(new Runnable() {
                    @Override public void run() {
                        importBtn.setEnabled(true);
                        if (p.error != null) {
                            String m = SimBrief.ERR_USER.equals(p.error) ? Api.t(MainActivity.this, "SimBrief user not found (or profile is private).", "Usuário do SimBrief não encontrado (ou perfil privado).")
                                    : SimBrief.ERR_NOPLAN.equals(p.error) ? Api.t(MainActivity.this, "No flight plan found on SimBrief. Generate one first.", "Nenhum plano encontrado no SimBrief. Gere um primeiro.")
                                    : SimBrief.ERR_BAD.equals(p.error) ? Api.t(MainActivity.this, "Could not read the SimBrief plan.", "Não foi possível ler o plano do SimBrief.")
                                    : Api.t(MainActivity.this, "Could not reach SimBrief. Check your connection.", "Não foi possível acessar o SimBrief. Verifique a conexão.");
                            Toast.makeText(MainActivity.this, m, Toast.LENGTH_LONG).show();
                            return;
                        }
                        if (PilotService.running || callsignBox == null || extra == null) return;
                        if (!p.callsign.isEmpty()) callsignBox.setText(p.callsign);
                        String[] v = {p.dep, p.arr, p.depRwy, p.arrRwy, p.model, p.reg, p.cruise, p.route};   // same order as EXTRA_KEYS (livery field = registration)
                        for (int i = 0; i < v.length; i++) if (v[i] != null && !v[i].isEmpty()) extra[i].setText(v[i]);
                        SimBrief.store(MainActivity.this, p);
                        Toast.makeText(MainActivity.this, Api.t(MainActivity.this, "Imported ", "Importado ") + p.dep + " \u2192 " + p.arr
                                + (p.points.length() > 1 ? " (" + p.points.length() + Api.t(MainActivity.this, " route points)", " pontos de rota)") : ""), Toast.LENGTH_LONG).show();
                    }
                });
            }
        });
    }
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
                Toast.makeText(this, Api.t(this, "Timeout - you can fly again in ", "Tempo de espera - você poderá voar em ") + Api.mmss(crashLeft), Toast.LENGTH_LONG).show();
                return;
            }
            if (Build.VERSION.SDK_INT >= 33
                    && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
            }
            String bad = Api.simRemote(this) && !Api.pcMode(this) ? SimHost.problem(Api.field(this, "simip")) : null;
            if (bad != null) {
                Toast.makeText(this, "mobile".equals(bad)
                        ? Api.t(this, "That is a mobile-network address. Use the Wi-Fi IP of the device running the sim.", "Esse é um endereço da rede móvel. Use o IP do Wi-Fi do aparelho que roda o sim.")
                        : Api.t(this, "Sim IP is not a valid address.", "O IP do sim não é um endereço válido."), Toast.LENGTH_LONG).show();
                return;
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
        importBtn.setEnabled(!on);
        for (EditText e : extra) e.setEnabled(!on);
        String raw = PilotService.lastRaw;
        if (raw.length() > 300) raw = raw.substring(0, 300) + "...";
        String shown = (Api.t(this, "Sim link: ", "Link do sim: ") + PilotService.simState
                + (SimHost.isLocal(Api.simHost(this)) ? "" : " @ " + Api.simHost(this))
                + Api.t(this, "\nServer: ", "\nServidor: ") + PilotService.serverState
                + Api.t(this, "\nUploads: ", "\nEnvios: ") + PilotService.okCount + " ok / " + PilotService.failCount + Api.t(this, " failed", " falhas")
                + (Api.radioOn(this) ? "\nRadio: " + RadioPlayer.state : "")
                + Api.t(this, "\nKey: ", "\nChave: ") + Api.key(this)
                + Api.t(this, "\n\nLast sim line:\n", "\n\nÚltima linha do sim:\n") + (raw.isEmpty() ? Api.t(this, "(none yet)", "(nenhuma ainda)") : raw));
        // Skip identical text so a text selection is not cleared by the 1 s refresh.
        if (!shown.equals(status.getText().toString())) status.setText(shown);
    }
}
