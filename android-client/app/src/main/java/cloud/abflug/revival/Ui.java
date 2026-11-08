package cloud.abflug.revival;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.widget.Button;
import android.view.View;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.SeekBar;
import android.widget.Spinner;
import android.widget.Switch;
import android.widget.TextView;

/** "Cockpit dark" look: palette plus small factories for cards, buttons, fields and controls. */
final class Ui {
    private Ui() { }

    // Palette built around #00414B (the background image's base colour).
    static final int BG = 0xFF00414B, CARD = 0xDD012C33, FIELD = 0xFF01242A, STROKE = 0xFF1E7480;
    static final int CYAN = 0xFF4FE3D0, AMBER = 0xFFFFB020, RED = 0xFFE5584D, GREEN = 0xFF5CE0A0;
    static final int TXT = 0xFFE8F6F5, DIM = 0xFF8FBCC0, ON_ACCENT = 0xFF00262C;
    static final int PRIMARY = 0, SECONDARY = 1, DANGER = 2;

    static int dp(Context c, float v) {
        return Math.round(v * c.getResources().getDisplayMetrics().density);
    }

    static GradientDrawable shape(Context c, int fill, int stroke, float radiusDp) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(fill);
        g.setCornerRadius(dp(c, radiusDp));
        if (stroke != 0) g.setStroke(dp(c, 1), stroke);
        return g;
    }

    static RippleDrawable ripple(Context c, int fill, int stroke, float radiusDp) {
        return new RippleDrawable(ColorStateList.valueOf(0x33FFFFFF),
                shape(c, fill, stroke, radiusDp), shape(c, 0xFFFFFFFF, 0, radiusDp));
    }

    /** Full-width layout params with a top margin in dp. */
    static LinearLayout.LayoutParams lp(Context c, float topDp) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        p.topMargin = dp(c, topDp);
        return p;
    }

    /** Wraps a screen in the cockpit background image (cropped to fill) with a light dim for readability. */
    static View withBackground(Context c, View content, int imageRes) {
        FrameLayout f = new FrameLayout(c);
        ImageView iv = new ImageView(c);
        iv.setImageResource(imageRes);
        iv.setScaleType(ImageView.ScaleType.CENTER_CROP);
        f.addView(iv, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        View dim = new View(c);
        dim.setBackgroundColor(0x55002B32);
        f.addView(dim, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        f.addView(content, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        return f;
    }

    static LinearLayout card(Context c) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.VERTICAL);
        int p = dp(c, 16);
        l.setPadding(p, p, p, p);
        l.setBackground(shape(c, CARD, STROKE, 16));
        return l;
    }

    /** Small spaced caps title at the top of a card. */
    static TextView heading(Context c, String s) {
        TextView t = new TextView(c);
        t.setText(s);
        t.setAllCaps(true);
        t.setLetterSpacing(0.12f);
        t.setTextSize(12);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setTextColor(CYAN);
        return t;
    }

    static void kind(Context c, Button b, int kind) {
        if (kind == PRIMARY) { b.setBackground(ripple(c, CYAN, 0, 12)); b.setTextColor(ON_ACCENT); }
        else if (kind == DANGER) { b.setBackground(ripple(c, RED, 0, 12)); b.setTextColor(0xFFFFFFFF); }
        else { b.setBackground(ripple(c, FIELD, STROKE, 12)); b.setTextColor(CYAN); }
    }

    static Button button(Context c, String text, int kind) {
        Button b = new Button(c);
        b.setText(text);
        b.setAllCaps(false);
        b.setTextSize(15);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setMinHeight(dp(c, 48));
        b.setMinimumHeight(dp(c, 48));
        b.setStateListAnimator(null);   // no raised-button shadow
        kind(c, b, kind);
        return b;
    }

    static void field(Context c, EditText e) {
        e.setBackground(shape(c, FIELD, STROKE, 10));
        e.setPadding(dp(c, 12), dp(c, 10), dp(c, 12), dp(c, 10));
        e.setTextSize(15);
        e.setTextColor(new ColorStateList(
                new int[][]{{-android.R.attr.state_enabled}, {}}, new int[]{DIM, TXT}));
        e.setHintTextColor(DIM);
    }

    static void spinner(Context c, Spinner s) {
        s.setPopupBackgroundDrawable(shape(c, CARD, STROKE, 12));
    }

    static void toggle(Switch s) {
        s.setTextColor(TXT);
        s.setThumbTintList(new ColorStateList(
                new int[][]{{android.R.attr.state_checked}, {}}, new int[]{CYAN, 0xFF9FB3CC}));
        s.setTrackTintList(new ColorStateList(
                new int[][]{{android.R.attr.state_checked}, {}}, new int[]{0x664FE3D0, 0x44FFFFFF}));
    }

    static void seek(SeekBar s) {
        s.setProgressTintList(ColorStateList.valueOf(CYAN));
        s.setThumbTintList(ColorStateList.valueOf(CYAN));
        s.setProgressBackgroundTintList(ColorStateList.valueOf(0x44FFFFFF));
    }
}
