package com.hapi.dynamicjournal

import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import org.json.JSONObject

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    // Keyboards that insert images directly (commitContent): hand each item to the page.
    ViewCompat.setOnReceiveContentListener(webView, arrayOf("image/*", "video/*")) { _, payload ->
      val split = payload.partition { it.uri != null }
      val media = split.first
      if (media != null) {
        val clip = media.getClip()
        for (i in 0 until clip.itemCount) {
          val uri = clip.getItemAt(i).uri ?: continue
          val item = readUri(uri) ?: continue
          val js = "window.__journalReceiveContent && window.__journalReceiveContent(${JSONObject.quote(item.first)}, '${item.second}')"
          webView.post { webView.evaluateJavascript(js, null) }
        }
      }
      split.second
    }

    // Gboard copies a GIF or sticker to the clipboard when it can't insert it here.
    // Tell the page when the clipboard changes, and let it read media with its original bytes
    // (so GIFs keep their animation).
    webView.addJavascriptInterface(ClipboardBridge(), "JournalClipboard")
    val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.addPrimaryClipChangedListener {
      webView.post { webView.evaluateJavascript("window.__journalClipboardChanged && window.__journalClipboardChanged()", null) }
    }
  }

  /** (mime, base64 bytes) of a content URI, or null when it can't be read. */
  private fun readUri(uri: android.net.Uri): Pair<String, String>? {
    val mime = contentResolver.getType(uri) ?: return null
    val bytes = try {
      contentResolver.openInputStream(uri)?.use { it.readBytes() }
    } catch (e: Exception) {
      null
    } ?: return null
    return Pair(mime, Base64.encodeToString(bytes, Base64.NO_WRAP))
  }

  inner class ClipboardBridge {
    /** The clipboard's first image or video as JSON {mime, data}, or "" when there is none. */
    @JavascriptInterface
    fun media(): String {
      val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
      val clip = clipboard.primaryClip ?: return ""
      for (i in 0 until clip.itemCount) {
        val uri = clip.getItemAt(i).uri ?: continue
        val item = readUri(uri) ?: continue
        if (!item.first.startsWith("image/") && !item.first.startsWith("video/")) continue
        return JSONObject().put("mime", item.first).put("data", item.second).toString()
      }
      return ""
    }
  }
}
