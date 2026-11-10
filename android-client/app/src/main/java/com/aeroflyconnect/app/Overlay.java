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
    private Button bWilco, bUnable, bClr, bTaxi, bTakeoff, bLand, bEmerg;
    private EditText chatIn;
    private View micBtn;
    private boolean micRec;
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
                if (micRec) { micRec = false; Mic.stop(); }
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
        b.setTextSize(13);
        b.setMinHeight(dp(40));
        b.setMinimumHeight(dp(40));
        b.setPadding(dp(4), 0, dp(4), 0);
        b.setSingleLine(true);
        return b;
    }

    private LinearLayout.LayoutParams weight() {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        p.leftMargin = dp(2); p.rightMargin = dp(2);
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

            bubble = new TextView(ctx);
            bubble.setText("ATC");
            bubble.setTextSize(12);
            bubble.setTypeface(Typeface.DEFAULT_BOLD);
            bubble.setTextColor(Ui.CYAN);
            bubble.setGravity(Gravity.CENTER);
            GradientDrawable g = new GradientDrawable();
            g.setShape(GradientDrawable.OVAL);
            g.setColor(0xF0012C33);
            g.setStroke(dp(2), Ui.CYAN);
            bubble.setBackground(g);
            bubble.setOnTouchListener(dragger);
            root.addView(bubble, new FrameLayout.LayoutParams(dp(52), dp(52)));

            panel = new LinearLayout(ctx);
            panel.setOrientation(LinearLayout.VERTICAL);
            panel.setPadding(dp(10), dp(6), dp(10), dp(10));
            panel.setBackground(Ui.shape(ctx, 0xF2012C33, Ui.STROKE, 16));

            LinearLayout head = new LinearLayout(ctx);
            head.setOrientation(LinearLayout.HORIZONTAL);
            head.setGravity(Gravity.CENTER_VERTICAL);
            TextView title = new TextView(ctx);
            title.setText("ATC  ·  " + Api.t(ctx, "drag to move", "arraste para mover"));
            title.setTextSize(12);
            title.setTypeface(Typeface.DEFAULT_BOLD);
            title.setTextColor(Ui.CYAN);
            title.setGravity(Gravity.CENTER_VERTICAL);
            title.setOnTouchListener(dragger);
            head.addView(title, new LinearLayout.LayoutParams(0, dp(40), 1f));
            TextView min = new TextView(ctx);
            min.setText("–");
            min.setTextSize(22);
            min.setTextColor(Ui.TXT);
            min.setGravity(Gravity.CENTER);
            min.setBackground(Ui.ripple(ctx, Ui.FIELD, Ui.STROKE, 10));
            min.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) { autoExpanded = false; setExpanded(false); }
            });
            head.addView(min, new LinearLayout.LayoutParams(dp(40), dp(40)));
            panel.addView(head);

            alertView = new TextView(ctx);
            alertView.setTextSize(14);
            alertView.setTypeface(Typeface.DEFAULT_BOLD);
            alertView.setTextColor(0xFFFFFFFF);
            alertView.setPadding(dp(8), dp(6), dp(8), dp(6));
            alertView.setBackground(Ui.shape(ctx, 0xFFB3261E, 0xFFFF6B5E, 8));
            alertView.setVisibility(View.GONE);
            LinearLayout.LayoutParams alp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            alp.bottomMargin = dp(4);
            panel.addView(alertView, alp);

            msgText = new TextView(ctx);
            msgText.setTextSize(15);
            msgText.setTextColor(Ui.TXT);
            msgText.setPadding(0, dp(4), 0, dp(6));
            msgScroll = new ScrollView(ctx) {
                @Override protected void onMeasure(int w, int hs) {
                    // long messages scroll inside a capped height so Wilco / Unable never leave the screen
                    super.onMeasure(w, MeasureSpec.makeMeasureSpec(maxMsgHeight(), MeasureSpec.AT_MOST));
                }
            };
            msgScroll.setVerticalScrollBarEnabled(true);
            msgScroll.setVisibility(View.GONE);
            msgScroll.addView(msgText);
            panel.addView(msgScroll);

            msgRow = new LinearLayout(ctx);
            msgRow.setOrientation(LinearLayout.HORIZONTAL);
            bWilco = small("Wilco", Ui.PRIMARY);
            bUnable = small(Api.t(ctx, "Unable", "Impossível"), Ui.DANGER);
            bWilco.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) { reply("wilco"); } });
            bUnable.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) { reply("unable"); } });
            msgRow.addView(bWilco, weight());
            msgRow.addView(bUnable, weight());
            msgRow.setVisibility(View.GONE);
            panel.addView(msgRow);

            // 2x2 grid, always visible: buttons that do not fit the flight phase are dimmed and inactive.
            reqGrid = new LinearLayout(ctx);
            reqGrid.setOrientation(LinearLayout.VERTICAL);
            bClr = small(Api.t(ctx, "Clearance", "Autorização"), Ui.SECONDARY);
            bTaxi = small(Api.t(ctx, "Taxi", "Táxi"), Ui.SECONDARY);
            bTakeoff = small(Api.t(ctx, "Take off", "Decolar"), Ui.SECONDARY);
            bLand = small(Api.t(ctx, "Landing", "Pouso"), Ui.SECONDARY);
            bClr.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) { request("clearance"); } });
            bTaxi.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) { request("taxi"); } });
            bTakeoff.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) { request("takeoff"); } });
            bLand.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) { request("land"); } });
            LinearLayout r1 = new LinearLayout(ctx), r2 = new LinearLayout(ctx);
            r1.setOrientation(LinearLayout.HORIZONTAL); r2.setOrientation(LinearLayout.HORIZONTAL);
            r1.addView(bClr, weight()); r1.addView(bTaxi, weight());
            r2.addView(bTakeoff, weight()); r2.addView(bLand, weight());
            reqGrid.addView(r1);
            LinearLayout.LayoutParams r2p = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            r2p.topMargin = dp(4);
            reqGrid.addView(r2, r2p);
            LinearLayout.LayoutParams rp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            rp.topMargin = dp(6);
            panel.addView(reqGrid, rp);

            // Emergency (Mayday): two taps, the second within 4 s; once declared the same button cancels it.
            bEmerg = small(Api.t(ctx, "Emergency", "Emergência"), Ui.DANGER);
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
            LinearLayout.LayoutParams ep = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            ep.topMargin = dp(6);
            panel.addView(bEmerg, ep);

            statusView = new TextView(ctx);
            statusView.setTextSize(12);
            statusView.setTextColor(Ui.DIM);
            statusView.setPadding(0, dp(6), 0, 0);
            statusView.setVisibility(View.GONE);
            panel.addView(statusView);

            // Pilot -> ATC text: the window only takes focus while the field is being used, so the sim keeps its input otherwise.
            LinearLayout chatRow = new LinearLayout(ctx);
            chatRow.setOrientation(LinearLayout.HORIZONTAL);
            chatRow.setGravity(Gravity.CENTER_VERTICAL);
            chatIn = new EditText(ctx);
            chatIn.setHint(Api.t(ctx, "Message to ATC", "Mensagem ao ATC"));
            chatIn.setHintTextColor(Ui.DIM);
            chatIn.setTextColor(Ui.TXT);
            chatIn.setTextSize(14);
            chatIn.setSingleLine(true);
            chatIn.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
            chatIn.setImeOptions(EditorInfo.IME_ACTION_SEND | EditorInfo.IME_FLAG_NO_EXTRACT_UI);
            chatIn.setFilters(new android.text.InputFilter[] { new android.text.InputFilter.LengthFilter(200) });
            chatIn.setPadding(dp(10), 0, dp(10), 0);
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
            chatRow.addView(chatIn, new LinearLayout.LayoutParams(0, dp(40), 1f));
            // push-to-talk: hold to record (max 10 s), release to send; only with Voice on in Settings and the mic permission
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
                LinearLayout.LayoutParams mp = new LinearLayout.LayoutParams(dp(40), dp(40));
                mp.leftMargin = dp(4);
                chatRow.addView(micBtn, mp);
            }
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
            LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(dp(40), dp(40));
            sp.leftMargin = dp(4);
            chatRow.addView(sendBtn, sp);
            LinearLayout.LayoutParams crp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            crp.topMargin = dp(8);
            panel.addView(chatRow, crp);

            panel.setVisibility(View.GONE);
            root.addView(panel, new FrameLayout.LayoutParams(dp(236), FrameLayout.LayoutParams.WRAP_CONTENT));

            lp = new WindowManager.LayoutParams(
                    dp(52), dp(52),   // explicit sizes per state: a wrap-content window stayed bubble-sized and clipped the panel
                    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                            | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
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
        int w = dp(52), hh = dp(52);
        if (expanded) {
            // measure the panel ourselves: a wrap-content window gets cut at the screen edge and then reports the cut size
            w = dp(236);
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
        return Math.max(dp(48), Math.min(dp(170), dm.heightPixels - dp(370)));
    }

    private void setExpanded(boolean e) {
        if (root == null) return;
        if (!e) endTyping();
        expanded = e;
        bubble.setVisibility(e ? View.GONE : View.VISIBLE);
        panel.setVisibility(e ? View.VISIBLE : View.GONE);
        lp.width = e ? dp(236) : dp(52);
        lp.height = e ? WindowManager.LayoutParams.WRAP_CONTENT : dp(52);
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
        alertView.setText(alertText);
        alertView.setVisibility(alertText.isEmpty() ? View.GONE : View.VISIBLE);
        dim(bClr, Phase.clearance); dim(bTaxi, Phase.taxi); dim(bTakeoff, Phase.takeoff); dim(bLand, Phase.land);
        bWilco.setEnabled(!replyBusy); bUnable.setEnabled(!replyBusy);
        bEmerg.setEnabled(!reqBusy);
        bEmerg.setText(PilotService.emergency ? Api.t(ctx, "Cancel Mayday", "Cancelar Mayday")
                : emergArmed ? Api.t(ctx, "Tap again: MAYDAY", "Toque de novo: MAYDAY") : Api.t(ctx, "Emergency", "Emergência"));
        String st = statusMsg;
        if (st.isEmpty() && !PilotService.contact.isEmpty()) st = Api.t(ctx, "Controller: ", "Controlador: ") + PilotService.contact;
        statusView.setText(st);
        statusView.setVisibility(st.isEmpty() ? View.GONE : View.VISIBLE);
        if (expanded) root.post(new Runnable() { @Override public void run() { clamp(); } });
    }

    /** Fits the phase: normal and tappable (unless a request is in flight); otherwise dimmed and inactive. */
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
                        setStatus(ok ? "" : Api.t(ctx, "Not sent, try again", "Não enviado, tente de novo"), 5000);
                    }
                });
            }
        }).start();
    }

    // ---------- typing ----------
    /** Gives the overlay window keyboard focus (and parks it at the top so the keyboard does not cover it). */
    private void beginTyping() {
        if (root == null || typing) return;
        typing = true;
        autoExpanded = false;
        savedY = lp.y;
        lp.flags &= ~WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
        lp.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING;
        lp.y = 0;
        try { wm.updateViewLayout(root, lp); } catch (Exception ignored) { }
        h.post(new Runnable() {
            @Override public void run() {
                if (!typing || chatIn == null) return;
                chatIn.requestFocus();
                InputMethodManager imm = (InputMethodManager) ctx.getSystemService(Context.INPUT_METHOD_SERVICE);
                if (imm != null) imm.showSoftInput(chatIn, InputMethodManager.SHOW_IMPLICIT);
            }
        });
    }

    /** Hides the keyboard, makes the window non-focusable again so the sim gets its input back, restores the position. */
    private void endTyping() {
        if (!typing) return;
        typing = false;
        try {
            InputMethodManager imm = (InputMethodManager) ctx.getSystemService(Context.INPUT_METHOD_SERVICE);
            if (imm != null && chatIn != null) imm.hideSoftInputFromWindow(chatIn.getWindowToken(), 0);
            if (chatIn != null) chatIn.clearFocus();
        } catch (Exception ignored) { }
        if (root == null) return;
        lp.flags |= WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
        lp.y = savedY;
        clamp();
    }

    private final Runnable micAuto = new Runnable() { @Override public void run() { micUp(); } };

    private void micDown() {
        if (micRec) return;
        String err = Mic.start(ctx);
        if (err != null) { setStatus(err, 5000); return; }
        micRec = true;
        micBtn.setBackground(Ui.ripple(ctx, Ui.RED, Ui.RED, 10));
        setStatus(Api.t(ctx, "Recording... release to send", "Gravando... solte para enviar"), 0);
        h.postDelayed(micAuto, Mic.MAX_MS);
    }

    private void micUp() {
        if (!micRec) return;
        micRec = false;
        h.removeCallbacks(micAuto);
        micBtn.setBackground(Ui.ripple(ctx, Ui.CYAN, Ui.CYAN, 10));
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
                        if (sendBtn != null) { sendBtn.setEnabled(true); sendBtn.invalidate(); }
                        setStatus(feedback, 6000);
                    }
                });
            }
        });
    }

    private void request(String type) {
        if (reqBusy) return;
        reqBusy = true;
        autoExpanded = false;
        setStatus(Api.t(ctx, "Sending...", "Enviando..."), 0);
        PilotService.request(ctx, type, new PilotService.ReqCb() {
            @Override public void done(final String feedback) {
                h.post(new Runnable() {
                    @Override public void run() {
                        setStatus(feedback, 5000);
                        h.postDelayed(unlockReq, 2500);   // the server allows one request every 2 s
                    }
                });
            }
        });
    }
}
