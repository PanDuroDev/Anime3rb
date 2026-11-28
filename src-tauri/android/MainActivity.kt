package app.anime3rb.player

import android.content.pm.ActivityInfo
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  private var playerFullscreen = false
  private var playerControlsHidden = false

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    playerFullscreen = savedInstanceState?.getBoolean(STATE_PLAYER_FULLSCREEN) ?: false
    playerControlsHidden = savedInstanceState?.getBoolean(STATE_PLAYER_CONTROLS_HIDDEN) ?: false
    if (playerFullscreen) {
      requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR
    }

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

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    // The app WebView loads the bundled local UI; video media is embedded as <video> sources.
    webView.addJavascriptInterface(PlayerUiBridge(this), "Anime3rbAndroid")
  }

  override fun onSaveInstanceState(outState: Bundle) {
    outState.putBoolean(STATE_PLAYER_FULLSCREEN, playerFullscreen)
    outState.putBoolean(STATE_PLAYER_CONTROLS_HIDDEN, playerControlsHidden)
    super.onSaveInstanceState(outState)
  }

  override fun onResume() {
    super.onResume()
    applyPlayerSystemUi()
  }

  internal fun setPlayerUiState(fullscreen: Boolean, controlsHidden: Boolean) {
    runOnUiThread {
      if (playerFullscreen != fullscreen) {
        requestedOrientation = if (fullscreen) {
          ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR
        } else {
          ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        }
      }

      playerFullscreen = fullscreen
      playerControlsHidden = fullscreen && controlsHidden
      applyPlayerSystemUi()
    }
  }

  private fun applyPlayerSystemUi() {
    val controller = WindowInsetsControllerCompat(window, window.decorView)
    controller.systemBarsBehavior =
      WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE

    if (playerFullscreen && playerControlsHidden) {
      controller.hide(WindowInsetsCompat.Type.statusBars())
    } else {
      controller.show(WindowInsetsCompat.Type.statusBars())
    }
  }

  companion object {
    private const val STATE_PLAYER_FULLSCREEN = "player_fullscreen"
    private const val STATE_PLAYER_CONTROLS_HIDDEN = "player_controls_hidden"
  }
}

class PlayerUiBridge(private val activity: MainActivity) {
  @JavascriptInterface
  fun setPlayerUiState(fullscreen: Boolean, controlsHidden: Boolean) {
    activity.setPlayerUiState(fullscreen, controlsHidden)
  }
}
