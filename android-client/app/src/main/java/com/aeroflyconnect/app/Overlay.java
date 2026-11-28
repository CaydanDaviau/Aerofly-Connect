package com.aeroflyconnect.app;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.text.InputType;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * Floating ATC window drawn over the sim (needs "display over other apps"). Two states:
 * a small draggable "ATC" bubble, and the expanded panel with the pending ATC message
 * (Wilco / Unable) and the request buttons (Taxi / Take off / Land) that fit the flight phase.
 * A new ATC message expands the bubble by itself. Everything here runs on the main thread.
 */
final class Overlay {
    static volatile boolean active;
    private static final int PW = 220;   // panel width in dp
    private static volatile Overlay inst;

    /** Switch on in Settings and permission granted. */
    static boolean allowed(Context c) {
        return Api.overlayOn(c) && Settings.canDrawOverlays(c);
    }

    /** Traffic advisory: shows a red line at the top of the panel for 10 s and opens the panel (any thread). */
    static void alert(final String text) {
        final Overlay o = inst;
        if (o == null) return;
        o.h.post(new Runnable() {
            @Override public void run() {
                o.alertText = text;
                o.h.removeCallbacks(o.alertExpire);
                o.h.postDelayed(o.alertExpire, 10000);
                if (o.root != null && !o.expanded) { o.autoExpanded = true; o.setExpanded(true); }
                o.refresh();
            }
        });
    }

    /** Redraw after the phase or the message queue changed (any thread). */
    static void poke() {
        Overlay o = inst;
        if (o != null) o.h.post(o.refreshRun);
    }

    private final Context ctx;
    private final WindowManager wm;
    private final Handler h = new Handler(Looper.getMainLooper());
    private FrameLayout root;
    private WindowManager.LayoutParams lp;
    private TextView bubble, msgText, statusView, alertView;
    private String alertText = "";
    private ScrollView msgScroll;
    private LinearLayout panel, msgRow, reqGrid;
    private LinearLayout radioPane, flightPane, logList, msgCard;
    private ScrollView logScroll;
    private Button tabRadio, tabFlight, bMap, bRepeat;
    private MiniMap mini;
    private boolean flightTab;
    private int logVer = -1;
    private TextView ctxView, noProc, msgHead, tAlt, tHdg, tGs, tVs, tPos, tPlan, tLink;
    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (!expanded) return;
            if (flightTab) updateFlight();
            h.postDelayed(this, 1000);
        }
    };
    private Button bProc;
    private boolean procOpen;
    private GradientDrawable bubbleBg;
    private Button bWilco, bUnable, bClr, bPush, bTaxi, bRwy, bClimb, bDescent, bEmerg;
    private EditText altIn;
    private EditText chatIn;
    // frequency row
    private EditText freqIn, typingField;
    private Button bFqDn, bFqUp, bFqAll;
    private LinearLayout quickRow;
    private String quickSig = "";
    private View micBtn;
    private Button bAtis, bAtisSwap;
    private LinearLayout atisBox;
    private ScrollView atisScroll;
    private TextView atisText;
    private boolean atisOpen, atisBusy, atisArr, atisPicked;
    private String atisShownLetter = "", atisShownIcao = "";
    private boolean micRec, micLive;
    private View sendBtn;
    private boolean typing, chatBusy;
    private int savedY;
    private boolean emergArmed;
    private final Runnable disarm = new Runnable() { @Override public void run() { emergArmed = false; refresh(); } };
    private boolean expanded, autoExpanded, reqBusy, replyBusy;
    private String shownId = "", statusMsg = "";

    private final Runnable refreshRun = new Runnable() { @Override public void run() { refresh(); } };
    private final Runnable autoCollapse = new Runnable() {
        @Override public void run() {
            if (autoExpanded && PipReply.current() == null) setExpanded(false);
            autoExpanded = false;
        }
    };
    private final Runnable alertExpire = new Runnable() {
        @Override public void run() { alertText = ""; refresh(); }
    };
    private final Runnable clearStatus = new Runnable() {
        @Override public void run() { statusMsg = ""; refresh(); }
    };
    private final Runnable unlockReq = new Runnable() {
        @Override public void run() { reqBusy = false; refresh(); }
    };

    Overlay(Context c) {
        ctx = c;
        wm = (WindowManager) c.getSystemService(Context.WINDOW_SERVICE);
    }

    private int dp(float v) { return Ui.dp(ctx, v); }

    void show() {
        h.post(new Runnable() { @Override public void run() { build(); } });
    }

    void hide() {
        h.post(new Runnable() {
            @Override public void run() {
                h.removeCallbacksAndMessages(null);
                typing = false;
                atisOpen = false;
                if (mini != null) { mini.destroy(); mini = null; }
                if (micRec) { micRec = false; if (micLive) LiveVoice.stopTx(); else Mic.stop(); }
                try { ctx.unregisterComponentCallbacks(cfgCb); } catch (Exception ignored) { }
                if (root != null) { try { wm.removeView(root); } catch (Exception ignored) { } root = null; }
                if (inst == Overlay.this) { inst = null; PipReply.overlayHook = null; }
                active = false;
                PilotService.refreshNotif(ctx);
            }
        });
    }

    // ---------- build ----------
    private Button small(String text, int kind) {
        Button b = Ui.button(ctx, text, kind);
        b.setTextSize(11);
        b.setMinHeight(dp(30));
        b.setMinimumHeight(dp(30));
        b.setMinWidth(0);
        b.setMinimumWidth(0);
        b.setPadding(dp(2), 0, dp(2), 0);
        b.setLayoutParams(new LinearLayout.LayoutParams(0, dp(30), 1f));
        b.setSingleLine(true);
        return b;
    }

    private LinearLayout.LayoutParams weight() {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(0, dp(30), 1f);
        p.leftMargin = dp(1); p.rightMargin = dp(1);
        return p;
    }

    private void build() {
        if (root != null) return;
        try {
            root = new FrameLayout(ctx) {
                @Override public boolean dispatchKeyEvent(KeyEvent e) {
                    // Back closes the keyboard and hands the focus back to the sim
                    if (typing && e.getKeyCode() == KeyEvent.KEYCODE_BACK) {
                        if (e.getAction() == KeyEvent.ACTION_UP) endTyping();
                        return true;
                    }
                    return super.dispatchKeyEvent(e);
                }
            };

            bubble = new TextView(ctx) {
                private final Paint pt = new Paint(Paint.ANTI_ALIAS_FLAG);
                private final RectF rf = new RectF();
                @Override protected void onDraw(Canvas c) {
                    super.onDraw(c);
                    float w = getWidth(), hh = getHeight(), cx = w / 2f, cy = hh / 2f;
                    pt.setColor(Ui.CYAN);
                    pt.setStyle(Paint.Style.FILL);
                    c.drawCircle(cx, cy, w * 0.08f, pt);
                    pt.setStyle(Paint.Style.STROKE);
                    pt.setStrokeWidth(w * 0.055f);
                    pt.setStrokeCap(Paint.Cap.ROUND);
                    for (int i = 1; i <= 2; i++) {
                        float r = w * (0.12f + 0.12f * i);
                        rf.set(cx - r, cy - r, cx + r, cy + r);
                        c.drawArc(rf, -50, 100, false, pt);
                        c.drawArc(rf, 130, 100, false, pt);
                    }
                }
            };
            bubble.setContentDescription("ATC");
            bubbleBg = new GradientDrawable();
            bubbleBg.setShape(GradientDrawable.OVAL);
            bubbleBg.setColor(0xCC012C33);
            bubbleBg.setStroke(dp(1), Ui.STROKE);
            bubble.setBackground(bubbleBg);
            bubble.setOnTouchListener(dragger);
            root.addView(bubble, new FrameLayout.LayoutParams(dp(34), dp(34)));

            panel = new LinearLayout(ctx);
            panel.setOrientation(LinearLayout.VERTICAL);
            panel.setPadding(dp(6), dp(2), dp(6), dp(6));
            panel.setBackground(Ui.shape(ctx, 0xEB012C33, Ui.STROKE, 12));

            LinearLayout head = new LinearLayout(ctx);
            head.setOrientation(LinearLayout.HORIZONTAL);
            head.setGravity(Gravity.CENTER_VERTICAL);
            TextView title = new TextView(ctx);
            title.setText("ATC");
            title.setPadding(dp(2), 0, dp(6), 0);
            title.setTextSize(11);
            title.setTypeface(Typeface.DEFAULT_BOLD);
            title.setTextColor(Ui.CYAN);
            title.setGravity(Gravity.CENTER_VERTICAL);
            title.setOnTouchListener(dragger);
            head.addView(title, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(24)));
            statusView = new TextView(ctx);
            statusView.setTextSize(10);
            statusView.setTextColor(Ui.DIM);
            statusView.setSingleLine(true);
            statusView.setEllipsize(android.text.TextUtils.TruncateAt.END);
            statusView.setGravity(Gravity.CENTER_VERTICAL);
            statusView.setOnTouchListener(dragger);
            head.addView(statusView, new LinearLayout.LayoutParams(0, dp(24), 1f));
            TextView min = new TextView(ctx);
            min.setText("–");
            min.setTextSize(16);
            min.setTextColor(Ui.TXT);
            min.setGravity(Gravity.CENTER);
            min.setBackground(Ui.ripple(ctx, Ui.FIELD, Ui.STROKE, 10));
            min.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) { autoExpanded = false; setExpanded(false); }
            });
            head.addView(min, new LinearLayout.LayoutParams(dp(28), dp(22)));
            panel.addView(head);

            LinearLayout tabs = new LinearLayout(ctx);
            tabs.setOrientation(LinearLayout.HORIZONTAL);
            tabs.setBackground(Ui.shape(ctx, Ui.FIELD, Ui.STROKE, 8));
            tabs.setPadding(dp(2), dp(2), dp(2), dp(2));
            tabRadio = new Button(ctx); tabFlight = new Button(ctx);
            View.OnClickListener tl = new View.OnClickListener() {
                @Override public void onClick(View v) { flightTab = v == tabFlight; refresh(); if (flightTab) updateFlight(); }
            };
            for (Button tb : new Button[] { tabRadio, tabFlight }) {
                tb.setAllCaps(false); tb.setTextSize(11); tb.setTypeface(Typeface.DEFAULT_BOLD);
                tb.setMinHeight(0); tb.setMinimumHeight(0); tb.setMinWidth(0); tb.setMinimumWidth(0);
                tb.setPadding(0, 0, 0, 0); tb.setStateListAnimator(null);
                tb.setOnClickListener(tl);
                tabs.addView(tb, new LinearLayout.LayoutParams(0, dp(26), 1f));
            }
            tabRadio.setText(Api.t(ctx, "Radio", "Rádio"));
            tabFlight.setText(Api.t(ctx, "Flight", "Voo"));
            LinearLayout.LayoutParams tbp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            tbp.topMargin = dp(2); tbp.bottomMargin = dp(3);
            panel.addView(tabs, tbp);

            alertView = new TextView(ctx);
            alertView.setTextSize(12);
            alertView.setTypeface(Typeface.DEFAULT_BOLD);
            alertView.setTextColor(0xFFFFFFFF);
            alertView.setPadding(dp(6), dp(3), dp(6), dp(3));
            alertView.setBackground(Ui.shape(ctx, 0xFFB3261E, 0xFFFF6B5E, 8));
            alertView.setVisibility(View.GONE);
            LinearLayout.LayoutParams alp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            alp.bottomMargin = dp(2);
            panel.addView(alertView, alp);

            final LinearLayout mainPanel = panel;
            radioPane = new LinearLayout(ctx);
            radioPane.setOrientation(LinearLayout.VERTICAL);
            panel = radioPane;   // everything below is the Radio tab

            logList = new LinearLayout(ctx);
            logList.setOrientation(LinearLayout.VERTICAL);
            logScroll = new ScrollView(ctx) {
                @Override protected void onMeasure(int w, int hs) {
                    super.onMeasure(w, MeasureSpec.makeMeasureSpec(maxLogHeight(), MeasureSpec.AT_MOST));
                }
            };
            logScroll.setVerticalScrollBarEnabled(false);
            logScroll.addView(logList);
            logScroll.setVisibility(View.GONE);
            panel.addView(logScroll);

            msgText = new TextView(ctx);
            msgText.setTextSize(12);
            msgText.setTextColor(Ui.TXT);
            msgText.setPadding(0, dp(2), 0, dp(4));
            msgScroll = new ScrollView(ctx) {
                @Override protected void onMeasure(int w, int hs) {
                    // long messages scroll inside a capped height so Wilco / Unable never leave the screen
                    super.onMeasure(w, MeasureSpec.makeMeasureSpec(maxMsgHeight(), MeasureSpec.AT_MOST));
                }
            };
            msgScroll.setVerticalScrollBarEnabled(true);
            msgScroll.setVisibility(View.GONE);
            msgScroll.addView(msgText);
            msgCard = new LinearLayout(ctx);
            msgCard.setOrientation(LinearLayout.VERTICAL);
            msgCard.setPadding(dp(6), dp(4), dp(6), dp(5));
            msgCard.setBackground(Ui.shape(ctx, Ui.FIELD, 0xFFFFB020, 10));
            msgCard.setVisibility(View.GONE);
            msgHead = new TextView(ctx);
            msgHead.setTextSize(9);
            msgHead.setTypeface(Typeface.DEFAULT_BOLD);
            msgHead.setTextColor(0xFFFFB020);
            msgCard.addView(msgHead);
            msgCard.addView(msgScroll);

            msgRow = new LinearLayout(ctx);
            msgRow.setOrientation(LinearLayout.HORIZONTAL);
            bWilco = small(Api.t(ctx, "Read back", "Colacionar"), Ui.PRIMARY);
            bWilco.setMinHeight(dp(34)); bWilco.setMinimumHeight(dp(34));
            bUnable = small(Api.t(ctx, "Unable", "Impossível"), Ui.DANGER);
            bWilco.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) { reply("wilco"); } });
            bUnable.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) { reply("unable"); } });
            LinearLayout.LayoutParams wl = new LinearLayout.LayoutParams(0, dp(34), 1.7f); wl.leftMargin = dp(1); wl.rightMargin = dp(1);
            msgRow.addView(bWilco, wl);
            msgRow.addView(bUnable, weight());
            msgRow.setVisibility(View.GONE);
            msgCard.addView(msgRow);
            LinearLayout.LayoutParams mcp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            mcp.topMargin = dp(3);
            panel.addView(msgCard, mcp);

            // 2x2 grid, always visible: buttons that do not fit the flight phase are dimmed and inactive.
            reqGrid = new LinearLayout(ctx);
            reqGrid.setOrientation(LinearLayout.VERTICAL);
            bClr = small(Api.t(ctx, "Request clearance", "Pedir autorização"), Ui.SECONDARY);
            bPush = small(Api.t(ctx, "Request pushback", "Pedir pushback"), Ui.SECONDARY);
            bTaxi = small(Api.t(ctx, "Request taxi", "Pedir táxi"), Ui.SECONDARY);
            bRwy = small(Api.t(ctx, "Take off", "Decolar"), Ui.SECONDARY);   // Take off on the ground, Landing in the air
            bClimb = small(Api.t(ctx, "Climb", "Subir"), Ui.SECONDARY);
            bDescent = small(Api.t(ctx, "Desc.", "Desc."), Ui.SECONDARY);
            altIn = new EditText(ctx);
            altIn.setHint("ALT");
            altIn.setHintTextColor(Ui.DIM);
            altIn.setTextColor(Ui.TXT);
            altIn.setTextSize(12);
            altIn.setGravity(Gravity.CENTER);
            altIn.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
            altIn.setSingleLine(true);
            altIn.setInputType(InputType.TYPE_CLASS_NUMBER);
            altIn.setImeOptions(EditorInfo.IME_ACTION_DONE | EditorInfo.IME_FLAG_NO_EXTRACT_UI);
            altIn.setFilters(new android.text.InputFilter[] { new android.text.InputFilter.LengthFilter(5) });
            altIn.setPadding(dp(4), 0, dp(4), 0);
            altIn.setBackground(Ui.shape(ctx, Ui.FIELD, Ui.STROKE, 10));
            altIn.setOnTouchListener(new View.OnTouchListener() {
                @Override public boolean onTouch(View v, MotionEvent e) {
                    if (e.getActionMasked() == MotionEvent.ACTION_DOWN && !typing) beginTyping(altIn);
                    return false;
                }
            });
            altIn.setOnEditorActionListener(new android.widget.TextView.OnEditorActionListener() {
                @Override public boolean onEditorAction(TextView v, int actionId, KeyEvent ev) {
                    if (actionId == EditorInfo.IME_ACTION_DONE) { endTyping(); return true; }
                    return false;
                }
            });
            bClr.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) { request("clearance"); } });
            bPush.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) { request("pushback"); } });
            bTaxi.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) { request("taxi"); } });
            bRwy.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) { request(Phase.air ? "land" : "takeoff"); } });
            bClimb.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) { requestAlt("climb"); } });
            bDescent.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) { requestAlt("descent"); } });
            bRepeat = small(Api.t(ctx, "Repeat last instruction", "Repetir última instrução"), Ui.SECONDARY);
            bRepeat.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) {
                    String t = RadioLog.lastAtc();
                    if (t.isEmpty()) return;
                    PilotService.speakAgain(t);
                    setStatus(Api.t(ctx, "Repeating...", "Repetindo..."), 3000);
                }
            });
            for (Button rb : new Button[] { bClr, bPush, bTaxi, bRwy, bRepeat }) {
                rb.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
                rb.setPadding(dp(8), 0, dp(8), 0);
                rb.setTextSize(12);
                LinearLayout.LayoutParams lpr = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(30));
                lpr.topMargin = dp(2);
                reqGrid.addView(rb, lpr);
            }
            noProc = new TextView(ctx);
            noProc.setTextSize(10);
            noProc.setTextColor(Ui.DIM);
            noProc.setText(Api.t(ctx, "Nothing to request right now", "Nada a solicitar agora"));
            noProc.setPadding(dp(4), dp(4), dp(4), dp(2));
            reqGrid.addView(noProc);
            LinearLayout altRow = new LinearLayout(ctx);
            altRow.setOrientation(LinearLayout.HORIZONTAL);
            altRow.setGravity(Gravity.CENTER_VERTICAL);
            LinearLayout.LayoutParams ap2 = weight(); ap2.weight = 0.9f;
            altRow.addView(altIn, ap2);
            altRow.addView(bClimb, weight()); altRow.addView(bDescent, weight());
            LinearLayout.LayoutParams arp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            arp.topMargin = dp(2);
            reqGrid.addView(altRow, arp);
            LinearLayout.LayoutParams rp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            rp.topMargin = dp(3);
            reqGrid.setVisibility(View.GONE);

            // ATIS view: replaces the request grid while open (keeps the panel the same height)
            atisBox = new LinearLayout(ctx);
            atisBox.setOrientation(LinearLayout.VERTICAL);
            LinearLayout atHead = new LinearLayout(ctx);
            atHead.setOrientation(LinearLayout.HORIZONTAL);
            atHead.setGravity(Gravity.CENTER_VERTICAL);
            TextView atTitle = new TextView(ctx);
            atTitle.setText("ATIS");
            atTitle.setTextSize(11);
            atTitle.setTypeface(Typeface.DEFAULT_BOLD);
            atTitle.setTextColor(Ui.CYAN);
            atHead.addView(atTitle, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
            bAtisSwap = small("", Ui.SECONDARY);
            bAtisSwap.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) { atisArr = !atisArr; atisPicked = true; loadAtis(); }
            });
            atHead.addView(bAtisSwap, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(28)));
            atisBox.addView(atHead);
            atisText = new TextView(ctx);
            atisText.setTextSize(11);
            atisText.setTextColor(Ui.TXT);
            atisText.setPadding(0, dp(4), 0, dp(2));
            atisScroll = new ScrollView(ctx) {
                @Override protected void onMeasure(int w, int hs) {
                    DisplayMetrics dm = new DisplayMetrics();
                    wm.getDefaultDisplay().getRealMetrics(dm);
                    int cap = Math.max(dp(60), Math.min(dp(110), dm.heightPixels - dp(260)));
                    super.onMeasure(w, MeasureSpec.makeMeasureSpec(cap, MeasureSpec.AT_MOST));
                }
            };
            atisScroll.setVerticalScrollBarEnabled(true);
            atisScroll.addView(atisText);
            atisBox.addView(atisScroll);
            atisBox.setVisibility(View.GONE);
            LinearLayout.LayoutParams abp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            abp.topMargin = dp(3);

            // Emergency (Mayday): two taps, the second within 4 s; once declared the same button cancels it.
            bEmerg = small("Mayday", Ui.DANGER);
            bProc = small("", Ui.SECONDARY);
            bProc.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) {
                    procOpen = !procOpen;
                    if (procOpen && atisOpen) toggleAtis();
                    refresh();
                }
            });
            bEmerg.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) {
                    if (PilotService.emergency) { request("mayday_cancel"); return; }
                    if (!emergArmed) {
                        emergArmed = true;
                        h.removeCallbacks(disarm); h.postDelayed(disarm, 4000);
                        refresh();
                    } else {
                        emergArmed = false; h.removeCallbacks(disarm);
                        request("mayday");
                    }
                }
            });
            bAtis = small("ATIS", Ui.SECONDARY);
            bAtis.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) { toggleAtis(); } });
            LinearLayout emRow = new LinearLayout(ctx);
            emRow.setOrientation(LinearLayout.HORIZONTAL);
            LinearLayout.LayoutParams emw = new LinearLayout.LayoutParams(0, dp(30), 1.1f);
            emw.leftMargin = dp(1);
            LinearLayout.LayoutParams atw = new LinearLayout.LayoutParams(0, dp(30), 1f);
            atw.leftMargin = dp(1);
            LinearLayout.LayoutParams pw = new LinearLayout.LayoutParams(0, dp(30), 1.6f);
            pw.rightMargin = dp(1);
            emRow.addView(bProc, pw);
            emRow.addView(bAtis, atw);
            emRow.addView(bEmerg, emw);
            LinearLayout.LayoutParams ep = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            ep.topMargin = dp(3);
            ctxView = new TextView(ctx);
            ctxView.setTextSize(10);
            ctxView.setTextColor(Ui.CYAN);
            ctxView.setSingleLine(true);
            ctxView.setEllipsize(android.text.TextUtils.TruncateAt.END);
            ctxView.setPadding(dp(2), dp(4), dp(2), 0);
            panel.addView(ctxView);
            panel.addView(emRow, ep);
            panel.addView(reqGrid, rp);
            panel.addView(atisBox, abp);

            buildFreqRows();



            // Pilot -> ATC text: the window only takes focus while the field is being used, so the sim keeps its input otherwise.
            LinearLayout chatRow = new LinearLayout(ctx);
            chatRow.setOrientation(LinearLayout.HORIZONTAL);
            chatRow.setGravity(Gravity.CENTER_VERTICAL);
            chatIn = new EditText(ctx);
            chatIn.setHint(Api.t(ctx, "Message to ATC", "Mensagem ao ATC"));
            chatIn.setHintTextColor(Ui.DIM);
            chatIn.setTextColor(Ui.TXT);
            chatIn.setTextSize(12);
            chatIn.setSingleLine(true);
            chatIn.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
            chatIn.setImeOptions(EditorInfo.IME_ACTION_SEND | EditorInfo.IME_FLAG_NO_EXTRACT_UI);
            chatIn.setFilters(new android.text.InputFilter[] { new android.text.InputFilter.LengthFilter(200) });
            chatIn.setPadding(dp(6), 0, dp(6), 0);
            chatIn.setBackground(Ui.shape(ctx, Ui.FIELD, Ui.STROKE, 10));
            chatIn.setOnTouchListener(new View.OnTouchListener() {
                @Override public boolean onTouch(View v, MotionEvent e) {
                    if (e.getActionMasked() == MotionEvent.ACTION_DOWN && !typing) beginTyping();
                    return false;
                }
            });
            chatIn.setOnEditorActionListener(new android.widget.TextView.OnEditorActionListener() {
                @Override public boolean onEditorAction(TextView v, int actionId, KeyEvent ev) {
                    if (actionId == EditorInfo.IME_ACTION_SEND) { sendChat(); return true; }
                    return false;
                }
            });
            chatRow.addView(chatIn, new LinearLayout.LayoutParams(0, dp(30), 1f));
            // push-to-talk: hold to record (max 20 s), release to send; only with Voice on in Settings and the mic permission
            micBtn = new View(ctx) {
                private final Paint pt = new Paint(Paint.ANTI_ALIAS_FLAG);
                private final RectF rf = new RectF();
                @Override protected void onDraw(Canvas c) {
                    super.onDraw(c);
                    float w = getWidth(), hh = getHeight();
                    pt.setColor(0xFF00414B);
                    pt.setStyle(Paint.Style.FILL);
                    rf.set(w * 0.39f, hh * 0.18f, w * 0.61f, hh * 0.56f);
                    c.drawRoundRect(rf, w * 0.11f, w * 0.11f, pt);
                    pt.setStyle(Paint.Style.STROKE);
                    pt.setStrokeWidth(w * 0.06f);
                    pt.setStrokeCap(Paint.Cap.ROUND);
                    rf.set(w * 0.29f, hh * 0.30f, w * 0.71f, hh * 0.70f);
                    c.drawArc(rf, 10, 160, false, pt);
                    c.drawLine(w * 0.5f, hh * 0.70f, w * 0.5f, hh * 0.82f, pt);
                    c.drawLine(w * 0.38f, hh * 0.82f, w * 0.62f, hh * 0.82f, pt);
                }
            };
            micBtn.setBackground(Ui.ripple(ctx, Ui.CYAN, Ui.CYAN, 10));
            micBtn.setContentDescription(Api.t(ctx, "Hold to talk", "Segure para falar"));
            micBtn.setOnTouchListener(new View.OnTouchListener() {
                @Override public boolean onTouch(View v, MotionEvent e) {
                    int a = e.getActionMasked();
                    if (a == MotionEvent.ACTION_DOWN) micDown();
                    else if (a == MotionEvent.ACTION_UP || a == MotionEvent.ACTION_CANCEL) micUp();
                    return true;
                }
            });
            if (Mic.available(ctx)) {
                LinearLayout.LayoutParams mp = new LinearLayout.LayoutParams(dp(30), dp(30));
                mp.leftMargin = dp(3);
                chatRow.addView(micBtn, mp);
            }
            android.widget.Button replayBtn = new android.widget.Button(ctx);
            replayBtn.setText("↻");
            replayBtn.setTextSize(14);
            replayBtn.setContentDescription(Api.t(ctx, "Replay last voice transmission", "Repetir última transmissão de voz"));
            replayBtn.setMinWidth(0);
            replayBtn.setMinimumWidth(0);
            replayBtn.setMinHeight(0); replayBtn.setMinimumHeight(0);
            replayBtn.setPadding(0, 0, 0, 0);
            replayBtn.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) { PilotService.replayLastVoice(ctx); }
            });
            LinearLayout.LayoutParams rbp = new LinearLayout.LayoutParams(dp(30), dp(30));
            rbp.leftMargin = dp(3);
            chatRow.addView(replayBtn, rbp);
            // send symbol: a paper plane drawn on a canvas (no text, no emoji font dependency)
            sendBtn = new View(ctx) {
                private final Paint pt = new Paint(Paint.ANTI_ALIAS_FLAG);
                private final Path path = new Path();
                @Override protected void onDraw(Canvas c) {
                    super.onDraw(c);
                    float w = getWidth(), hh = getHeight();
                    pt.setColor(isEnabled() ? 0xFF00414B : 0x8000414B);
                    pt.setStyle(Paint.Style.FILL);
                    path.reset();
                    path.moveTo(w * 0.24f, hh * 0.24f);          // nose-left of the plane
                    path.lineTo(w * 0.80f, hh * 0.50f);          // tip
                    path.lineTo(w * 0.24f, hh * 0.76f);
                    path.lineTo(w * 0.34f, hh * 0.54f);          // tail notch
                    path.lineTo(w * 0.56f, hh * 0.50f);
                    path.lineTo(w * 0.34f, hh * 0.46f);
                    path.close();
                    c.drawPath(path, pt);
                }
            };
            sendBtn.setBackground(Ui.ripple(ctx, Ui.CYAN, Ui.CYAN, 10));
            sendBtn.setContentDescription(Api.t(ctx, "Send", "Enviar"));
            sendBtn.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) { sendChat(); } });
            LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(dp(30), dp(30));
            sp.leftMargin = dp(3);
            chatRow.addView(sendBtn, sp);
            LinearLayout.LayoutParams crp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            crp.topMargin = dp(4);
            panel.addView(chatRow, crp);
            panel = mainPanel;
            panel.addView(radioPane);
            buildFlightPane();
            panel.addView(flightPane);

            panel.setVisibility(View.GONE);
            root.addView(panel, new FrameLayout.LayoutParams(dp(PW), FrameLayout.LayoutParams.WRAP_CONTENT));

            lp = new WindowManager.LayoutParams(
                    dp(34), dp(34),   // explicit sizes per state: a wrap-content window stayed bubble-sized and clipped the panel
                    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                            | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
                    PixelFormat.TRANSLUCENT);
            lp.gravity = Gravity.TOP | Gravity.START;
            lp.x = Api.prefs(ctx).getInt("ov_x", dp(12));
            lp.y = Api.prefs(ctx).getInt("ov_y", dp(120));
            wm.addView(root, lp);
            inst = this;
            active = true;
            PipReply.overlayHook = refreshRun;
            ctx.registerComponentCallbacks(cfgCb);
            PilotService.refreshNotif(ctx);
            root.post(new Runnable() { @Override public void run() { clamp(); } });
            refresh();
        } catch (Throwable t) {
            // permission revoked, or the window could not be added: the PiP / notification fallback stays in use
            root = null;
            active = false;
            PipReply.overlayHook = null;
        }
    }

    // ---------- drag ----------
    private final View.OnTouchListener dragger = new View.OnTouchListener() {
        private float sx, sy; private int ox, oy; private boolean moved;
        @Override public boolean onTouch(View v, MotionEvent e) {
            switch (e.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    sx = e.getRawX(); sy = e.getRawY(); ox = lp.x; oy = lp.y; moved = false;
                    return true;
                case MotionEvent.ACTION_MOVE: {
                    float mx = e.getRawX() - sx, my = e.getRawY() - sy;
                    if (!moved && Math.hypot(mx, my) > dp(8)) moved = true;
                    if (moved) { lp.x = Math.round(ox + mx); lp.y = Math.round(oy + my); clamp(); }
                    return true;
                }
                case MotionEvent.ACTION_UP:
                    if (moved) {
                        Api.prefs(ctx).edit().putInt("ov_x", lp.x).putInt("ov_y", lp.y).apply();
                    } else if (v == bubble) {
                        autoExpanded = false;
                        setExpanded(true);
                    }
                    return true;
                default:
                    return true;
            }
        }
    };

    /** Screen rotated: fit the window into the new screen size once the system has settled. */
    private final android.content.ComponentCallbacks cfgCb = new android.content.ComponentCallbacks() {
        @Override public void onConfigurationChanged(android.content.res.Configuration c) {
            h.postDelayed(new Runnable() { @Override public void run() { clamp(); } }, 300);
            h.postDelayed(new Runnable() { @Override public void run() { clamp(); } }, 1000);
        }
        @Override public void onLowMemory() { }
    };

    /** Keeps the window on the screen and applies the new position. */
    private void clamp() {
        if (root == null) return;
        DisplayMetrics dm = new DisplayMetrics();
        wm.getDefaultDisplay().getRealMetrics(dm);   // current rotation
        int w = dp(34), hh = dp(34);
        if (expanded) {
            // measure the panel ourselves: a wrap-content window gets cut at the screen edge and then reports the cut size
            w = dp(PW);
            panel.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(dm.heightPixels, View.MeasureSpec.AT_MOST));
            hh = Math.min(panel.getMeasuredHeight(), dm.heightPixels);
            lp.height = hh;
        }
        lp.x = Math.max(0, Math.min(lp.x, dm.widthPixels - w));
        lp.y = Math.max(0, Math.min(lp.y, dm.heightPixels - hh));
        try { wm.updateViewLayout(root, lp); } catch (Exception ignored) { }
    }

    /** Max height of the message area: leaves room for header, buttons and status on this screen. */
    private int maxMsgHeight() {
        DisplayMetrics dm = new DisplayMetrics();
        wm.getDefaultDisplay().getRealMetrics(dm);
        return Math.max(dp(48), Math.min(dp(110), dm.heightPixels - dp(300)));
    }

    private int maxLogHeight() {
        DisplayMetrics dm = new DisplayMetrics();
        wm.getDefaultDisplay().getRealMetrics(dm);
        return Math.max(dp(48), Math.min(dp(110), dm.heightPixels - dp(330)));
    }

    private TextView cell(LinearLayout row, String label) {
        LinearLayout c = new LinearLayout(ctx);
        c.setOrientation(LinearLayout.VERTICAL);
        TextView l = new TextView(ctx);
        l.setText(label); l.setTextSize(8); l.setTextColor(Ui.DIM); l.setTypeface(Typeface.DEFAULT_BOLD);
        TextView v = new TextView(ctx);
        v.setTextSize(15); v.setTextColor(Ui.TXT); v.setTypeface(Typeface.DEFAULT_BOLD); v.setSingleLine(true);
        c.addView(l); c.addView(v);
        row.addView(c, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        return v;
    }

    private void buildFlightPane() {
        flightPane = new LinearLayout(ctx);
        flightPane.setOrientation(LinearLayout.VERTICAL);
        flightPane.setVisibility(View.GONE);
        LinearLayout card = new LinearLayout(ctx);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(8), dp(6), dp(8), dp(6));
        card.setBackground(Ui.shape(ctx, Ui.FIELD, Ui.STROKE, 10));
        LinearLayout r1 = new LinearLayout(ctx), r2 = new LinearLayout(ctx);
        r1.setOrientation(LinearLayout.HORIZONTAL); r2.setOrientation(LinearLayout.HORIZONTAL);
        tAlt = cell(r1, Api.t(ctx, "ALTITUDE", "ALTITUDE"));
        tHdg = cell(r1, Api.t(ctx, "HDG TRUE", "PROA VERD."));
        tGs = cell(r2, Api.t(ctx, "GROUND SPEED", "VEL. SOLO"));
        tVs = cell(r2, Api.t(ctx, "V/S", "V/S"));
        card.addView(r1);
        LinearLayout.LayoutParams p2 = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        p2.topMargin = dp(4);
        card.addView(r2, p2);
        tPos = new TextView(ctx);
        tPos.setTextSize(10); tPos.setTextColor(Ui.DIM); tPos.setTypeface(Typeface.MONOSPACE); tPos.setSingleLine(true);
        tPos.setPadding(0, dp(5), 0, 0);
        card.addView(tPos);
        flightPane.addView(card);

        DisplayMetrics dm = new DisplayMetrics();
        wm.getDefaultDisplay().getRealMetrics(dm);
        int mh = Math.max(dp(80), Math.min(dp(140), dm.heightPixels - dp(300)));
        mini = new MiniMap(ctx, mh, dp(10));
        LinearLayout.LayoutParams mmp = (LinearLayout.LayoutParams) mini.view().getLayoutParams();
        mmp.topMargin = dp(4);
        flightPane.addView(mini.view(), mmp);

        tPlan = new TextView(ctx);
        tPlan.setTextSize(11); tPlan.setTextColor(Ui.TXT);
        tPlan.setMaxLines(2);
        tPlan.setEllipsize(android.text.TextUtils.TruncateAt.END);
        tPlan.setPadding(dp(8), dp(6), dp(8), dp(6));
        tPlan.setBackground(Ui.shape(ctx, Ui.FIELD, Ui.STROKE, 10));
        LinearLayout.LayoutParams pp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        pp.topMargin = dp(4);
        flightPane.addView(tPlan, pp);

        tLink = new TextView(ctx);
        tLink.setTextSize(9); tLink.setTextColor(Ui.DIM); tLink.setSingleLine(true);
        tLink.setEllipsize(android.text.TextUtils.TruncateAt.END);
        tLink.setPadding(dp(2), dp(4), dp(2), 0);
        flightPane.addView(tLink);

        bMap = small("", Ui.SECONDARY);
        bMap.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                try {
                    ctx.startActivity(new android.content.Intent(ctx, MapActivity.class)
                            .setAction(MapActivity.ACT_TOGGLE).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
                } catch (Exception ignored) { }
                h.postDelayed(refreshRun, 800);
            }
        });
        LinearLayout.LayoutParams mp2 = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(30));
        mp2.topMargin = dp(4);
        flightPane.addView(bMap, mp2);
    }

    private void updateFlight() {
        if (tAlt == null) return;
        boolean pt = "pt".equals(Api.uiLang(ctx));
        if (PilotService.hasPos) {
            tAlt.setText(Math.round(PilotService.lastAlt) + " ft");
            tHdg.setText(String.format(java.util.Locale.US, "%03d\u00B0", Math.round(PilotService.lastHdg) % 360));
            tGs.setText(Math.round(PilotService.lastGs) + " kt");
            tVs.setText(Math.round(PilotService.lastVs) + " fpm");
            tPos.setText(String.format(java.util.Locale.US, "%+.4f  %+.4f", PilotService.lastLat, PilotService.lastLon));
        } else {
            tAlt.setText("-"); tHdg.setText("-"); tGs.setText("-"); tVs.setText("-"); tPos.setText(Api.t(ctx, "Waiting for the sim...", "Aguardando o simulador..."));
        }
        String dep = Api.field(ctx, "dep").trim().toUpperCase(), arr = Api.field(ctx, "arr").trim().toUpperCase();
        String dr = Api.field(ctx, "deprwy").trim().toUpperCase(), ar = Api.field(ctx, "arrrwy").trim().toUpperCase();
        String cr = Api.field(ctx, "cruise").trim(), rt = Api.field(ctx, "route").trim();
        StringBuilder sb = new StringBuilder();
        sb.append(dep.isEmpty() ? "----" : dep).append(dr.isEmpty() ? "" : " " + dr).append("  \u2192  ")
                .append(arr.isEmpty() ? "----" : arr).append(ar.isEmpty() ? "" : " " + ar);
        if (!cr.isEmpty()) sb.append("\n").append(Api.t(ctx, "Cruise ", "Cruzeiro ")).append(cr);
        if (!rt.isEmpty()) sb.append("\n").append(rt);
        tPlan.setText(sb.toString());
        tLink.setText("Sim: " + PilotService.simState + "  \u00B7  " + Api.t(ctx, "Server: ", "Servidor: ") + PilotService.serverState);
        bMap.setText(PilotService.mapShown ? Api.t(ctx, "Close full map", "Fechar mapa completo") : Api.t(ctx, "Open full map", "Abrir mapa completo"));
    }

    private String contextLine() {
        boolean pt = "pt".equals(Api.uiLang(ctx));
        if (!PilotService.hasPos) return "";
        if (Phase.air) {
            StringBuilder b = new StringBuilder(Api.t(ctx, "Airborne", "Em voo"));
            if (Phase.arrNm >= 0) b.append("  \u00B7  ").append(Math.round(Phase.arrNm)).append(" nm");
            if (Phase.etaMin >= 0) b.append("  \u00B7  ETA ").append(Phase.etaMin).append(" min");
            return b.toString();
        }
        if (!Phase.onRwy.isEmpty()) return Api.t(ctx, "On runway ", "Na pista ") + Phase.onRwy;
        if (!Phase.nearRwy.isEmpty() && Phase.nearM >= 0)
            return Api.t(ctx, "Near runway ", "Perto da pista ") + Phase.nearRwy + "  \u00B7  " + Phase.nearM + " m";
        return Api.t(ctx, "On the ground", "No solo");
    }

    private void renderLog() {
        int v = RadioLog.version();
        if (v == logVer) return;
        logVer = v;
        logList.removeAllViews();
        java.util.List<RadioLog.Entry> es = RadioLog.snapshot();
        for (RadioLog.Entry e : es) {
            LinearLayout row = new LinearLayout(ctx);
            row.setOrientation(LinearLayout.HORIZONTAL);
            View bar = new View(ctx);
            bar.setBackgroundColor(e.pilot ? 0xFFFFB020 : Ui.CYAN);
            row.addView(bar, new LinearLayout.LayoutParams(dp(2), LinearLayout.LayoutParams.MATCH_PARENT));
            LinearLayout col = new LinearLayout(ctx);
            col.setOrientation(LinearLayout.VERTICAL);
            col.setPadding(dp(5), 0, 0, 0);
            TextView hd = new TextView(ctx);
            hd.setText((e.pilot ? Api.t(ctx, "PILOT", "PILOTO") : e.who.toUpperCase()) + "  " + e.time);
            hd.setTextSize(8); hd.setTypeface(Typeface.DEFAULT_BOLD);
            hd.setTextColor(e.pilot ? 0xFFFFB020 : Ui.CYAN);
            TextView tx = new TextView(ctx);
            tx.setText(e.text); tx.setTextSize(11); tx.setTextColor(Ui.TXT);
            col.addView(hd); col.addView(tx);
            row.addView(col, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
            LinearLayout.LayoutParams rl = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            rl.topMargin = dp(3);
            logList.addView(row, rl);
        }
        logScroll.setVisibility(es.isEmpty() ? View.GONE : View.VISIBLE);
        logScroll.post(new Runnable() { @Override public void run() { logScroll.fullScroll(View.FOCUS_DOWN); } });
    }

    private void tabStyle(Button b, boolean on) {
        b.setBackground(on ? Ui.shape(ctx, 0xFF1E7480, 0xFF1E7480, 6) : null);
        b.setTextColor(on ? Ui.TXT : Ui.DIM);
    }

    private void setExpanded(boolean e) {
        if (root == null) return;
        if (!e) endTyping();
        expanded = e;
        if (!e && mini != null) mini.stop();
        h.removeCallbacks(tick);
        if (e) h.postDelayed(tick, 1000);
        bubble.setVisibility(e ? View.GONE : View.VISIBLE);
        panel.setVisibility(e ? View.VISIBLE : View.GONE);
        lp.width = e ? dp(PW) : dp(34);
        lp.height = e ? WindowManager.LayoutParams.WRAP_CONTENT : dp(34);
        try { wm.updateViewLayout(root, lp); } catch (Exception ignored) { }
        root.post(new Runnable() { @Override public void run() { clamp(); } });
        h.postDelayed(new Runnable() { @Override public void run() { clamp(); } }, 150);   // after the panel has been measured
    }

    // ---------- content ----------
    private void setStatus(String s, long clearAfterMs) {
        statusMsg = s == null ? "" : s;
        h.removeCallbacks(clearStatus);
        if (!statusMsg.isEmpty() && clearAfterMs > 0) h.postDelayed(clearStatus, clearAfterMs);
        refresh();
    }

    private void refresh() {
        if (root == null) return;
        PipReply.Item it = PipReply.current();
        if (it != null) {
            msgText.setText(it.text);
            msgText.setVisibility(View.VISIBLE);
            msgScroll.setVisibility(View.VISIBLE);
            if (!it.id.equals(shownId)) msgScroll.scrollTo(0, 0);
            msgRow.setVisibility(View.VISIBLE);
            h.removeCallbacks(autoCollapse);
            if (!it.id.equals(shownId)) {
                shownId = it.id;
                if (!expanded) { autoExpanded = true; setExpanded(true); }   // a new message must not be missed
            }
        } else {
            msgText.setVisibility(View.GONE);
            msgScroll.setVisibility(View.GONE);
            msgRow.setVisibility(View.GONE);
            if (expanded && autoExpanded && alertText.isEmpty()) { h.removeCallbacks(autoCollapse); h.postDelayed(autoCollapse, 6000); }
        }
        msgCard.setVisibility(it != null ? View.VISIBLE : View.GONE);
        if (it != null) msgHead.setText(instruction(it.text) ? Api.t(ctx, "READBACK REQUIRED", "COLACIONE") : Api.t(ctx, "INFORMATION", "INFORMAÇÃO"));
        radioPane.setVisibility(flightTab ? View.GONE : View.VISIBLE);
        flightPane.setVisibility(flightTab ? View.VISIBLE : View.GONE);
        tabStyle(tabRadio, !flightTab); tabStyle(tabFlight, flightTab);
        if (expanded && flightTab) mini.start(); else mini.stop();
        if (!flightTab) { renderLog(); ctxView.setText(contextLine()); }
        alertView.setText(alertText);
        alertView.setVisibility(alertText.isEmpty() ? View.GONE : View.VISIBLE);
        reqGrid.setVisibility(procOpen && !atisOpen ? View.VISIBLE : View.GONE);
        bProc.setText(procOpen ? Api.t(ctx, "Procedures \u2304", "Procedimentos \u2304") : Api.t(ctx, "Procedures \u203A", "Procedimentos \u203A"));
        bubbleBg.setStroke(dp(it != null ? 2 : 1), it != null ? 0xFFFFB020 : Ui.STROKE);
        atisBox.setVisibility(atisOpen ? View.VISIBLE : View.GONE);
        bAtis.setText(atisOpen ? Api.t(ctx, "Back", "Voltar") : (atisShownLetter.isEmpty() ? "ATIS" : "ATIS " + atisShownLetter));
bRwy.setText(Phase.air ? Api.t(ctx, "Request landing", "Pedir pouso") : Api.t(ctx, "Ready for departure", "Pronto para decolagem"));
        show(bClr, Phase.clearance); show(bPush, Phase.pushback); show(bTaxi, Phase.taxi);
        show(bRwy, Phase.air ? Phase.land : Phase.takeoff);
        show(bRepeat, !RadioLog.lastAtc().isEmpty());
        noProc.setVisibility(!Phase.clearance && !Phase.pushback && !Phase.taxi && !(Phase.air ? Phase.land : Phase.takeoff) && !Phase.air ? View.VISIBLE : View.GONE);
        altIn.setVisibility(Phase.air ? View.VISIBLE : View.GONE); bClimb.setVisibility(Phase.air ? View.VISIBLE : View.GONE); bDescent.setVisibility(Phase.air ? View.VISIBLE : View.GONE);
        dim(bClimb, Phase.air); dim(bDescent, Phase.air);
        if (it != null) bWilco.setText(instruction(it.text) ? Api.t(ctx, "Read back", "Colacionar") : Api.t(ctx, "Roger", "Ciente"));
        bWilco.setEnabled(!replyBusy); bUnable.setEnabled(!replyBusy);
        bEmerg.setEnabled(!reqBusy);
        bEmerg.setText(PilotService.emergency ? Api.t(ctx, "Cancel", "Cancelar")
                : emergArmed ? Api.t(ctx, "Confirm?", "Confirmar?") : "Mayday");
        updateFreqUi();
        String st = statusMsg;
        if (st.isEmpty() && !PilotService.contact.isEmpty()) st = Api.t(ctx, "Controller: ", "Controlador: ") + PilotService.contact;
        statusView.setText(st);
        
        if (expanded) root.post(new Runnable() { @Override public void run() { clamp(); } });
    }

    /** Fits the phase: normal and tappable (unless a request is in flight); otherwise dimmed and inactive. */
    private void show(Button b, boolean fits) {
        b.setVisibility(fits ? View.VISIBLE : View.GONE);
        b.setEnabled(!reqBusy);
    }

    private void dim(Button b, boolean fits) {
        b.setEnabled(fits && !reqBusy);
        b.setAlpha(fits ? 1f : 0.35f);
    }

    private void reply(final String r) {
        final PipReply.Item it = PipReply.current();
        if (it == null || replyBusy) return;
        replyBusy = true;
        refresh();
        new Thread(new Runnable() {
            @Override public void run() {
                final boolean ok = ReplyReceiver.sendReply(ctx, it.id, r, it.nid);
                h.post(new Runnable() {
                    @Override public void run() {
                        replyBusy = false;
                        if (ok) {
                            boolean pt = "pt".equals(Api.uiLang(ctx));
                            String cs = Api.callsign(ctx).trim().toUpperCase();
                            RadioLog.add(true, "PILOT", r.equals("unable") ? (pt ? "Impossível" : "Unable") + (cs.isEmpty() ? "." : ", " + cs + ".")
                                    : RadioLog.readback(pt, instruction(it.text), it.text, cs));
                        }
                        setStatus(ok ? "" : Api.t(ctx, "Not sent, try again", "Não enviado, tente de novo"), 5000);
                    }
                });
            }
        }).start();
    }

    // ---------- ATIS ----------
    private String atisIcao() {
        return (atisArr ? Api.field(ctx, "arr") : Api.field(ctx, "dep")).trim().toUpperCase();
    }

    private void toggleAtis() {
        atisOpen = !atisOpen;
        if (atisOpen) {
            procOpen = false;
            if (!atisPicked) {   // default: arrival airport once airborne, otherwise departure
                String dep = Api.field(ctx, "dep").trim(), arr = Api.field(ctx, "arr").trim();
                atisArr = (!arr.isEmpty() && "air".equals(Phase.phaseName)) || dep.isEmpty();
            }
            loadAtis();
            h.removeCallbacks(atisTick); h.postDelayed(atisTick, 60000);
        } else {
            h.removeCallbacks(atisTick);
        }
        refresh();
    }

    private final Runnable atisTick = new Runnable() {
        @Override public void run() {
            if (!atisOpen || root == null) return;
            loadAtis();
            h.postDelayed(this, 60000);
        }
    };

    private void loadAtis() {
        if (atisBusy) return;
        final String icao = atisIcao();
        String other = (atisArr ? Api.field(ctx, "dep") : Api.field(ctx, "arr")).trim().toUpperCase();
        bAtisSwap.setText((atisArr ? "ARR " : "DEP ") + (icao.isEmpty() ? "-" : icao) + "  >");
        bAtisSwap.setVisibility(other.isEmpty() ? View.GONE : View.VISIBLE);
        atisBusy = true;
        if (!icao.equals(atisShownIcao)) atisText.setText(Api.t(ctx, "Loading...", "Carregando..."));
        new Thread(new Runnable() {
            @Override public void run() {
                final Atis.Result r = Atis.fetch(ctx, icao);
                h.post(new Runnable() {
                    @Override public void run() {
                        atisBusy = false;
                        if (root == null) return;
                        String t = r.text;
                        if (!r.letter.isEmpty() && icao.equals(atisShownIcao) && !atisShownLetter.isEmpty() && !r.letter.equals(atisShownLetter))
                            t = Api.t(ctx, "NEW INFORMATION ", "NOVA INFORMAÇÃO ") + r.letter + "\n" + t;
                        atisShownIcao = icao;
                        atisShownLetter = r.letter;
                        atisText.setText(t);
                        refresh();
                        if (atisOpen && !icao.equals(atisIcao())) loadAtis();   // swapped while this one was loading
                    }
                });
            }
        }, "atis").start();
    }

    // ---------- typing ----------
    /** Gives the overlay window keyboard focus (and parks it at the top so the keyboard does not cover it). */
    private void beginTyping() { beginTyping(chatIn); }

    private void beginTyping(EditText field) {
        if (root == null || typing) return;
        typing = true;
        typingField = field;
        autoExpanded = false;
        savedY = lp.y;
        lp.flags &= ~WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
        lp.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING;
        lp.y = 0;
        try { wm.updateViewLayout(root, lp); } catch (Exception ignored) { }
        h.post(new Runnable() {
            @Override public void run() {
                if (!typing || typingField == null) return;
                typingField.requestFocus();
                InputMethodManager imm = (InputMethodManager) ctx.getSystemService(Context.INPUT_METHOD_SERVICE);
                if (imm != null) imm.showSoftInput(typingField, InputMethodManager.SHOW_IMPLICIT);
            }
        });
    }

    /** Hides the keyboard, makes the window non-focusable again so the sim gets its input back, restores the position. */
    private void endTyping() {
        if (!typing) return;
        typing = false;
        EditText f = typingField != null ? typingField : chatIn;
        typingField = null;
        if (f == freqIn) commitFreqText();
        try {
            InputMethodManager imm = (InputMethodManager) ctx.getSystemService(Context.INPUT_METHOD_SERVICE);
            if (imm != null && f != null) imm.hideSoftInputFromWindow(f.getWindowToken(), 0);
            if (f != null) f.clearFocus();
        } catch (Exception ignored) { }
        if (root == null) return;
        lp.flags |= WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
        lp.y = savedY;
        clamp();
    }

    private final Runnable micAuto = new Runnable() { @Override public void run() { micUp(); } };

    private void micDown() {
        if (micRec) return;
        if (PilotService.freq.isEmpty()) { setStatus(Api.t(ctx, "Tune a frequency to talk", "Sintonize uma frequência para falar"), 4000); return; }
        // live over the socket when it is up; otherwise the old record-then-send clip
        micLive = false;   // pilot -> ATC goes as a clip (autoplays + history on /atc); ATC -> pilot stays live
        String err = micLive ? LiveVoice.startTx(ctx) : Mic.start(ctx);
        if (err != null) { setStatus(err, 5000); return; }
        micRec = true;
        micBtn.setBackground(Ui.ripple(ctx, Ui.RED, Ui.RED, 10));
        setStatus(micLive ? Api.t(ctx, "LIVE... release to stop", "AO VIVO... solte para parar") : Api.t(ctx, "Recording... release to send", "Gravando... solte para enviar"), 0);
        h.postDelayed(micAuto, micLive ? LiveVoice.MAX_MS : Mic.MAX_MS);
    }

    private void micUp() {
        if (!micRec) return;
        micRec = false;
        h.removeCallbacks(micAuto);
        micBtn.setBackground(Ui.ripple(ctx, Ui.CYAN, Ui.CYAN, 10));
        if (micLive) {
            final long lms = LiveVoice.stopTx();
            setStatus(lms < 300 ? Api.t(ctx, "Too short", "Muito curto") : Api.t(ctx, "Sent live", "Enviado ao vivo"), 3000);
            return;
        }
        final long ms = Mic.elapsed();
        final byte[] data = Mic.stop();
        if (data == null || ms < 500) { setStatus(Api.t(ctx, "Too short", "Muito curto"), 3000); return; }
        setStatus(Api.t(ctx, "Sending...", "Enviando..."), 0);
        PilotService.voiceSend(ctx, data, Math.min(ms, Mic.MAX_MS), new PilotService.ReqCb() {
            @Override public void done(final String feedback) {
                h.post(new Runnable() { @Override public void run() { setStatus(feedback, 6000); } });
            }
        });
    }

    private void sendChat() {
        if (chatBusy || chatIn == null) return;
        final String text = chatIn.getText().toString().trim();
        if (text.isEmpty()) return;
        chatBusy = true;
        sendBtn.setEnabled(false); sendBtn.invalidate();
        chatIn.setText("");
        endTyping();
        setStatus(Api.t(ctx, "Sending...", "Enviando..."), 0);
        PilotService.chat(ctx, text, new PilotService.ReqCb() {
            @Override public void done(final String feedback) {
                h.post(new Runnable() {
                    @Override public void run() {
                        chatBusy = false;
                        if (feedback != null && (feedback.startsWith("Sent") || feedback.startsWith("Enviado"))) RadioLog.add(true, "PILOT", text);
                        if (sendBtn != null) { sendBtn.setEnabled(true); sendBtn.invalidate(); }
                        setStatus(feedback, 6000);
                    }
                });
            }
        });
    }

    // ---------- radio frequency (VHF airband 118.000-136.975, 25 kHz channels) ----------
    private static int parseKhz(String s) {
        if (s == null) return -1;
        String t = s.trim().replace(',', '.');
        if (t.matches("\\d{4,6}")) t = t.substring(0, 3) + "." + t.substring(3);
        if (!t.matches("\\d{3}\\.\\d{1,3}")) return -1;
        int dot = t.indexOf('.');
        String dec = (t.substring(dot + 1) + "00").substring(0, 3);
        int k = Integer.parseInt(t.substring(0, dot)) * 1000 + Integer.parseInt(dec);
        return k >= 118000 && k <= 136975 ? k : -1;
    }

    private static String fmtKhz(int k) { return String.format(java.util.Locale.US, "%d.%03d", k / 1000, k % 1000); }

    private void setFreq(String f) {
        PilotService.freq = f == null ? "" : f;
        try { Api.prefs(ctx).edit().putString("freq", PilotService.freq).apply(); } catch (Exception ignored) { }
        updateFreqUi();
    }

    /** Tap = next 25 kHz channel; hold = 1 MHz jumps. */
    private void stepFreq(int dir, boolean big) {
        int k = parseKhz(PilotService.freq);
        if (k < 0) k = 118000;
        else if (big) k += dir * 1000;
        else if (dir > 0) k = (k / 25 + 1) * 25;
        else k = (k % 25 == 0) ? k - 25 : (k / 25) * 25;
        k = Math.max(118000, Math.min(136975, k));
        setFreq(fmtKhz(k));
    }

    private void commitFreqText() {
        if (freqIn == null) return;
        String t = freqIn.getText().toString().trim();
        if (t.isEmpty()) { setFreq(""); return; }
        int k = parseKhz(t);
        if (k < 0) { setStatus(Api.t(ctx, "Frequency must be 118.000-136.975", "Frequência deve ser 118.000-136.975"), 4000); updateFreqUi(); return; }
        setFreq(fmtKhz(k));
    }

    private int fqDir;
    private boolean fqHeldBig;
    private final Runnable fqHold = new Runnable() {
        @Override public void run() {
            fqHeldBig = true;
            stepFreq(fqDir, true);
            h.postDelayed(this, 220);
        }
    };

    private View.OnTouchListener stepTouch(final int dir) {
        return new View.OnTouchListener() {
            @Override public boolean onTouch(View v, MotionEvent e) {
                switch (e.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        fqDir = dir; fqHeldBig = false;
                        v.setPressed(true);
                        h.removeCallbacks(fqHold);
                        h.postDelayed(fqHold, 450);
                        return true;
                    case MotionEvent.ACTION_UP:
                        v.setPressed(false);
                        h.removeCallbacks(fqHold);
                        if (!fqHeldBig) stepFreq(dir, false);
                        fqHeldBig = false;
                        return true;
                    case MotionEvent.ACTION_CANCEL:
                        v.setPressed(false);
                        h.removeCallbacks(fqHold);
                        fqHeldBig = false;
                        return true;
                }
                return true;
            }
        };
    }

    private void buildFreqRows() {
        LinearLayout row = new LinearLayout(ctx);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        bFqAll = small(Api.t(ctx, "ALL", "TODOS"), Ui.SECONDARY);
        bFqAll.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) { setFreq(""); } });
        bFqDn = small("\u2039", Ui.SECONDARY);
        bFqDn.setOnTouchListener(stepTouch(-1));
        bFqUp = small("\u203A", Ui.SECONDARY);
        bFqUp.setOnTouchListener(stepTouch(1));
        freqIn = new EditText(ctx);
        freqIn.setHint(Api.t(ctx, "FREQ (all)", "FREQ (todas)"));
        freqIn.setHintTextColor(Ui.DIM);
        freqIn.setTextColor(Ui.TXT);
        freqIn.setTextSize(12);
        freqIn.setGravity(Gravity.CENTER);
        freqIn.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        freqIn.setSingleLine(true);
        freqIn.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_DECIMAL);
        freqIn.setImeOptions(EditorInfo.IME_ACTION_DONE | EditorInfo.IME_FLAG_NO_EXTRACT_UI);
        freqIn.setFilters(new android.text.InputFilter[] { new android.text.InputFilter.LengthFilter(7) });
        freqIn.setPadding(dp(4), 0, dp(4), 0);
        freqIn.setBackground(Ui.shape(ctx, Ui.FIELD, Ui.STROKE, 10));
        freqIn.setOnTouchListener(new View.OnTouchListener() {
            @Override public boolean onTouch(View v, MotionEvent e) {
                if (e.getActionMasked() == MotionEvent.ACTION_DOWN && !typing) beginTyping(freqIn);
                return false;
            }
        });
        freqIn.setOnEditorActionListener(new android.widget.TextView.OnEditorActionListener() {
            @Override public boolean onEditorAction(TextView v, int actionId, KeyEvent ev) {
                if (actionId == EditorInfo.IME_ACTION_DONE) { endTyping(); return true; }
                return false;
            }
        });
        LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(dp(30), dp(30));
        bp.rightMargin = dp(2);
        LinearLayout.LayoutParams ap = new LinearLayout.LayoutParams(dp(40), dp(30));
        ap.rightMargin = dp(2);
        row.addView(bFqAll, ap);
        row.addView(bFqDn, bp);
        LinearLayout.LayoutParams fp = new LinearLayout.LayoutParams(0, dp(30), 1f);
        fp.rightMargin = dp(2);
        row.addView(freqIn, fp);
        row.addView(bFqUp, new LinearLayout.LayoutParams(dp(30), dp(30)));
        LinearLayout.LayoutParams rp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        rp.topMargin = dp(3);
        panel.addView(row, rp);

        quickRow = new LinearLayout(ctx);
        quickRow.setOrientation(LinearLayout.HORIZONTAL);
        quickRow.setVisibility(View.GONE);
        LinearLayout.LayoutParams qp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        qp.topMargin = dp(3);
        panel.addView(quickRow, qp);
        PilotService.freq = Api.prefs(ctx).getString("freq", "");
    }

    /** Quick buttons: frequencies typed by staffed positions first, then OurAirports data for the airport we are at / heading to. */
    private java.util.List<String[]> quickList() {
        java.util.LinkedHashMap<String, String> m = new java.util.LinkedHashMap<String, String>();
        String[] order = { "DEL", "GND", "TWR", "APP", "CTR" };
        String ours = "air".equals(Phase.phaseName) && !PilotService.fqArr.isEmpty() ? PilotService.fqArr : PilotService.fqDep;
        for (String src : new String[] { PilotService.stations, ours }) {
            for (String kv : src.split(";")) {
                String[] p = kv.split("=");
                if (p.length != 2) continue;
                String role = p[0].trim().toUpperCase();
                int k = parseKhz(p[1]);
                if (k < 0 || m.containsKey(role)) continue;
                m.put(role, fmtKhz(k));
            }
        }
        java.util.List<String[]> out = new java.util.ArrayList<String[]>();
        for (String r : order) if (m.containsKey(r)) out.add(new String[] { r, m.get(r) });
        for (String r : m.keySet()) { boolean known = false; for (String o2 : order) if (o2.equals(r)) known = true; if (!known && out.size() < 5) out.add(new String[] { r, m.get(r) }); }
        return out;
    }

    private void updateFreqUi() {
        if (freqIn == null) return;
        if (!typing || typingField != freqIn) {
            String f = PilotService.freq;
            if (!freqIn.getText().toString().equals(f)) freqIn.setText(f);
        }
        java.util.List<String[]> q = quickList();
        StringBuilder sb = new StringBuilder();
        for (String[] e : q) sb.append(e[0]).append('=').append(e[1]).append(';');
        String sig = sb.toString();
        if (!sig.equals(quickSig)) {
            quickSig = sig;
            quickRow.removeAllViews();
            for (final String[] e : q) {
                Button b = small(e[0] + "\n" + e[1], Ui.SECONDARY);
                b.setTextSize(9);
                b.setSingleLine(false);
                b.setMaxLines(2);
                b.setLineSpacing(0, 0.9f);
                b.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) { setFreq(e[1]); } });
                quickRow.addView(b, weight());
            }
        }
        quickRow.setVisibility(q.isEmpty() ? View.GONE : View.VISIBLE);
        for (int i = 0; i < quickRow.getChildCount(); i++) {
            quickRow.getChildAt(i).setAlpha(((Button) quickRow.getChildAt(i)).getText().toString().endsWith(PilotService.freq) && !PilotService.freq.isEmpty() ? 1f : 0.75f);
        }
    }

    /** Instruction (needs a readback) versus plain information (just "Roger"). */
    private static boolean instruction(String t) {
        String l = t == null ? "" : t.toLowerCase(java.util.Locale.ROOT);
        if (l.matches(".*\\d.*")) return true;
        String[] k = {"cleared", "taxi", "hold", "line up", "climb", "descend", "suba", "desça", "squawk", "contact", "proceed",
                "turn", "vire", "autoriz", "mantenha", "reduce", "increase", "pushback", "approved", "aprovad", "go around", "cross"};
        for (String w : k) if (l.contains(w)) return true;
        return false;
    }

    private void requestAlt(String type) {
        if (reqBusy) return;
        String a = altIn.getText().toString().trim();
        if (a.isEmpty()) { setStatus(Api.t(ctx, "Type an altitude (100 = FL100, 5000 = ft)", "Digite uma altitude (100 = FL100, 5000 = ft)"), 4000); return; }
        request(type, a);
    }

    private void request(String type) { request(type, null); }

    private void request(String type, String altitude) {
        if (reqBusy) return;
        reqBusy = true;
        procOpen = false;
        autoExpanded = false;
        setStatus(Api.t(ctx, "Sending...", "Enviando..."), 0);
        PilotService.request(ctx, type, altitude, new PilotService.ReqCb() {
            @Override public void done(final String feedback) {
                h.post(new Runnable() {
                    @Override public void run() {
                        if (feedback != null && (feedback.startsWith("Request sent") || feedback.startsWith("Pedido enviado")))
                            RadioLog.add(true, "PILOT", RadioLog.callFor("pt".equals(Api.uiLang(ctx)), type, altitude,
                                    Api.callsign(ctx).trim().toUpperCase(), Phase.air, PilotService.contact));
                        setStatus(feedback, 5000);
                        h.postDelayed(unlockReq, 2500);   // the server allows one request every 2 s
                    }
                });
            }
        });
    }
}
