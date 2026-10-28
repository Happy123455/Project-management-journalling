package com.hapi.dynamicjournal

import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.result.contract.ActivityResultContracts
import androidx.documentfile.provider.DocumentFile
import org.json.JSONArray
import android.os.Bundle
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import org.json.JSONObject

class MainActivity : TauriActivity() {
  private var webView: WebView? = null

  /** The sync folder (Google Drive via the system picker); access is kept across restarts. */
  private val pickSyncFolder = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
    if (uri != null) {
      contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
      getSharedPreferences("sync", Context.MODE_PRIVATE).edit().putString("tree", uri.toString()).apply()
    }
    webView?.evaluateJavascript("window.__journalSyncPicked && window.__journalSyncPicked(${uri != null})", null)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    webView.addJavascriptInterface(SyncBridge(), "JournalSync")
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
    /**
     * The clipboard as text, as JSON {focused, text}. Android only shares the clipboard with
     * the app whose window has focus; before that "focused" is false and the page retries.
     * coerceToText also covers rich text (HTML) and links, which the Tauri plugin refuses.
     */
    @JavascriptInterface
    fun text(): String {
      val focused = hasWindowFocus()
      val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
      val clip = if (focused) clipboard.primaryClip else null
      val text = if (clip != null && clip.itemCount > 0) clip.getItemAt(0).coerceToText(this@MainActivity)?.toString() else null
      return JSONObject().put("focused", focused).put("text", text ?: JSONObject.NULL).toString()
    }

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

  /**
   * File access inside the picked sync folder, by relative path ("events/<device>/2026-10.jsonl").
   * Calls run on a background thread, so slow Drive reads don't freeze the screen.
   */
  inner class SyncBridge {
    private fun root(): DocumentFile? {
      val tree = getSharedPreferences("sync", Context.MODE_PRIVATE).getString("tree", null) ?: return null
      val uri = Uri.parse(tree)
      val permitted = contentResolver.persistedUriPermissions.any { it.uri == uri && it.isWritePermission }
      return if (permitted) DocumentFile.fromTreeUri(this@MainActivity, uri) else null
    }

    private fun find(path: String, create: Boolean, isDir: Boolean): DocumentFile? {
      var node = root() ?: return null
      val parts = path.split("/").filter { it.isNotEmpty() }
      for ((i, name) in parts.withIndex()) {
        val last = i == parts.size - 1
        val next = node.findFile(name)
        node = when {
          next != null -> next
          !create -> return null
          last && !isDir -> node.createFile("application/octet-stream", name) ?: return null
          else -> node.createDirectory(name) ?: return null
        }
      }
      return node
    }

    /** The picked folder's name, or "" when none is picked (or access was lost). */
    @JavascriptInterface
    fun folderName(): String = root()?.name ?: ""

    @JavascriptInterface
    fun pick() {
      runOnUiThread { pickSyncFolder.launch(null) }
    }

    @JavascriptInterface
    fun list(path: String): String {
      val dir = if (path.isEmpty()) root() else find(path, create = false, isDir = true)
      val names = JSONArray()
      dir?.listFiles()?.forEach { f -> f.name?.let { names.put(it) } }
      return names.toString()
    }

    /** The file's bytes as base64, or "!" when it doesn't exist. */
    @JavascriptInterface
    fun read(path: String): String {
      val file = find(path, create = false, isDir = false) ?: return "!"
      return try {
        contentResolver.openInputStream(file.uri)?.use { Base64.encodeToString(it.readBytes(), Base64.NO_WRAP) } ?: "!"
      } catch (e: Exception) {
        "!"
      }
    }

    @JavascriptInterface
    fun write(path: String, data: String): Boolean {
      val file = find(path, create = true, isDir = false) ?: return false
      return try {
        contentResolver.openOutputStream(file.uri, "wt")?.use { it.write(Base64.decode(data, Base64.NO_WRAP)) }
        true
      } catch (e: Exception) {
        false
      }
    }

    @JavascriptInterface
    fun exists(path: String): Boolean = find(path, create = false, isDir = false) != null
  }
}
