package org.abflug.community

import android.app.Activity
import android.os.Bundle
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/** Stage 0: proves the build pipeline works and the phone can reach the server. */
class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pad = (16 * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad * 3, pad, pad)
        }
        val title = TextView(this).apply { text = "Abflug Community"; textSize = 26f }
        val info = TextView(this).apply {
            text = "Build ${BuildConfig.VERSION_NAME}\nServer: ${BuildConfig.SERVER_URL}"
            setPadding(0, pad / 2, 0, pad)
        }
        val out = TextView(this).apply { textSize = 16f; setPadding(0, pad, 0, 0) }
        val btn = Button(this).apply { text = "Test server connection" }
        btn.setOnClickListener {
            out.text = "Contacting server..."
            thread {
                val result = try {
                    val c = URL(BuildConfig.SERVER_URL + "/api/health").openConnection() as HttpURLConnection
                    c.connectTimeout = 8000
                    c.readTimeout = 8000
                    val body = c.inputStream.bufferedReader().readText()
                    "HTTP ${c.responseCode}\n$body"
                } catch (e: Exception) {
                    "Failed: ${e.javaClass.simpleName}: ${e.message}"
                }
                runOnUiThread { out.text = result }
            }
        }
        root.addView(title); root.addView(info); root.addView(btn); root.addView(out)
        setContentView(root)
    }
}
