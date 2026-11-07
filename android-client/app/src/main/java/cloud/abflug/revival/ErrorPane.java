package cloud.abflug.revival;

import android.content.Context;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Native "no connection" screen shown instead of the WebView's own error page. */
final class ErrorPane {
    private ErrorPane() { }

    static View build(Context c, final Runnable retry, final Runnable back) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setGravity(Gravity.CENTER);
        l.setBackgroundColor(0xFF152238);
        int p = (int) (24 * c.getResources().getDisplayMetrics().density);
        l.setPadding(p, p, p, p);
        TextView t = new TextView(c);
        t.setText(Api.t(c, "No connection", "Sem conexão"));
        t.setTextColor(0xFFFFFFFF); t.setTextSize(24); t.setGravity(Gravity.CENTER);
        TextView m = new TextView(c);
        m.setText(Api.t(c, "Could not reach the server.\nCheck your internet connection and try again.", "Não foi possível acessar o servidor.\nVerifique sua internet e tente novamente."));
        m.setTextColor(0xFFB8C0CC); m.setTextSize(15); m.setGravity(Gravity.CENTER);
        m.setPadding(0, p / 2, 0, p);
        Button r = new Button(c);
        r.setText(Api.t(c, "Retry", "Tentar de novo"));
        r.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) { retry.run(); } });
        Button b = new Button(c);
        b.setText(Api.t(c, "Back", "Voltar"));
        b.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) { back.run(); } });
        l.addView(t); l.addView(m); l.addView(r); l.addView(b);
        l.setVisibility(View.GONE);
        l.setClickable(true);
        return l;
    }
}
