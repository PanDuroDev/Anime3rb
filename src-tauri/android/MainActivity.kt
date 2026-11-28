package app.anime3rb.player

import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    // Match the app's dark surface behind the status bar and keep its icons visible.
    val statusBarBackground = Color.rgb(15, 15, 15)
    window.statusBarColor = statusBarBackground
    WindowInsetsControllerCompat(window, window.decorView).isAppearanceLightStatusBars = false

    val content = findViewById<View>(android.R.id.content)
    content.setBackgroundColor(statusBarBackground)

    // Android 15+ enforces edge-to-edge for apps targeting API 35 or newer.
    // Keep the WebView below the status bar and display cutout instead of drawing
    // the app header underneath them. Older Android versions use the normal
    // decor fitting behavior because Tauri's enableEdgeToEdge() is not enabled.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
      val initialLeft = content.paddingLeft
      val initialTop = content.paddingTop
      val initialRight = content.paddingRight
      val initialBottom = content.paddingBottom

      ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
        val safeInsets = insets.getInsets(
          WindowInsetsCompat.Type.statusBars() or WindowInsetsCompat.Type.displayCutout()
        )

        view.setPadding(
          initialLeft + safeInsets.left,
          initialTop + safeInsets.top,
          initialRight + safeInsets.right,
          initialBottom
        )

        insets
      }

      ViewCompat.requestApplyInsets(content)
    }
  }
}
