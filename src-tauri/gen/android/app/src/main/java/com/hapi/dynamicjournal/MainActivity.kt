package com.hapi.dynamicjournal

import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.result.contract.ActivityResultContracts
import androidx.documentfile.provider.DocumentFile
import android.provider.OpenableColumns
import android.view.inputmethod.InputMethodManager
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONArray
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import java.util.Locale
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

  companion object {
    const val QUICK_NOTE = "com.hapi.dynamicjournal.QUICK_NOTE"
    /** Shared files bigger than this are skipped (they'd go through the page as text). */
    private const val MAX_SHARED_BYTES = 60L * 1024 * 1024
  }

  /** What was shared in (or a quick-note request), waiting for the page to take it. */
  @Volatile private var pendingShare: String? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    handleIntent(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    handleIntent(intent)
    webView?.evaluateJavascript("window.dispatchEvent(new Event('journal:shared'))", null)
  }

  /** Turns a share or a quick-note launch into JSON {quickNote, text, files:[{name, mime, data}], skipped}. */
  private fun handleIntent(intent: Intent?) {
    if (intent == null) return
    val action = intent.action
    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE && action != QUICK_NOTE) return
    val payload = JSONObject().put("quickNote", action == QUICK_NOTE)
    val text = listOfNotNull(intent.getStringExtra(Intent.EXTRA_SUBJECT), intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString())
      .filter { it.isNotBlank() }
      .distinct()
      .joinToString("\n")
    if (text.isNotEmpty()) payload.put("text", text)
    val uris = mutableListOf<Uri>()
    intent.clipData?.let { clip -> for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let { uris.add(it) } }
    @Suppress("DEPRECATION")
    if (uris.isEmpty()) {
      (intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))?.let { uris.add(it) }
      intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.let { uris.addAll(it) }
    }
    val files = JSONArray()
    val skipped = JSONArray()
    for (uri in uris.distinct()) {
      val name = displayName(uri) ?: "shared"
      val size = fileSize(uri)
      if (size != null && size > MAX_SHARED_BYTES) {
        skipped.put(name)
        continue
      }
      val item = readUri(uri) ?: continue
      files.put(JSONObject().put("name", name).put("mime", item.first).put("data", item.second))
    }
    payload.put("files", files).put("skipped", skipped)
    pendingShare = payload.toString()
    // Handled once: don't add it again if the activity is recreated.
    intent.action = null
  }

  private fun displayName(uri: Uri): String? = try {
    contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
  } catch (e: Exception) {
    null
  }

  private fun fileSize(uri: Uri): Long? = try {
    contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { c -> if (c.moveToFirst() && !c.isNull(0)) c.getLong(0) else null }
  } catch (e: Exception) {
    null
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    webView.addJavascriptInterface(SyncBridge(), "JournalSync")
    webView.addJavascriptInterface(ShareBridge(), "JournalShare")
    webView.addJavascriptInterface(SecretsBridge(), "JournalSecrets")
    webView.addJavascriptInterface(speech, "JournalSpeech")
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
    val mime = contentResolver.getType(uri) ?: "application/octet-stream"
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

  /** Lets the page take what was shared in, and open the keyboard for a quick note. */
  inner class ShareBridge {
    /** The waiting share as JSON (see handleIntent), or "" when there is none. Taking it clears it. */
    @JavascriptInterface
    fun take(): String {
      val share = pendingShare ?: return ""
      pendingShare = null
      return share
    }

    @JavascriptInterface
    fun showKeyboard() {
      runOnUiThread {
        val view = webView ?: return@runOnUiThread
        view.requestFocus()
        (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).showSoftInput(view, InputMethodManager.SHOW_IMPLICIT)
      }
    }
  }

  /**
   * Secrets (AI keys) for this device only: encrypted with a key that never leaves the
   * Android Keystore, stored in app-private preferences, not in the journal, sync or backups.
   */
  inner class SecretsBridge {
    private val alias = "dynamic-journal-secrets"
    private fun prefs() = getSharedPreferences("secrets", Context.MODE_PRIVATE)

    private fun key(): SecretKey {
      val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
      (store.getKey(alias, null) as? SecretKey)?.let { return it }
      val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
      generator.init(
        KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
          .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
          .setKeySize(256)
          .build()
      )
      return generator.generateKey()
    }

    @JavascriptInterface
    fun get(name: String): String {
      val stored = prefs().getString(name, null) ?: return ""
      return try {
        val bytes = Base64.decode(stored, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, 12))
        String(cipher.doFinal(bytes, 12, bytes.size - 12), Charsets.UTF_8)
      } catch (e: Exception) {
        ""
      }
    }

    @JavascriptInterface
    fun set(name: String, value: String): Boolean = try {
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.ENCRYPT_MODE, key())
      val sealed = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
      prefs().edit().putString(name, Base64.encodeToString(sealed, Base64.NO_WRAP)).apply()
      true
    } catch (e: Exception) {
      false
    }

    @JavascriptInterface
    fun remove(name: String) {
      prefs().edit().remove(name).apply()
    }
  }

  // Created with the WebView, after the activity has its context (a field initialiser runs too early).
  private val speech by lazy { SpeechBridge() }

  override fun onDestroy() {
    speech.shutdown()
    super.onDestroy()
  }

  /** Read aloud with the best installed voice (Google's high-quality voices when downloaded). Pages: src/lib/readAloud.ts. */
  inner class SpeechBridge {
    private var tts: TextToSpeech? = null
    private var ready = false
    private var waiting: (() -> Unit)? = null

    private fun emit(event: String, id: String, index: Int = 0) {
      val js = "window.__journalSpeech && window.__journalSpeech('$event', ${JSONObject.quote(id)}, $index)"
      webView?.post { webView?.evaluateJavascript(js, null) }
    }

    private fun withTts(action: (TextToSpeech) -> Unit) {
      tts?.let { if (ready) return action(it) }
      waiting = { tts?.let(action) }
      if (tts != null) return
      tts = TextToSpeech(this@MainActivity) { status ->
        if (status != TextToSpeech.SUCCESS) return@TextToSpeech
        val engine = tts ?: return@TextToSpeech
        bestVoice(engine)?.let { engine.voice = it }
        engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
          // Utterance ids are "<run>:<offset of this chunk>:<last?>".
          override fun onStart(utteranceId: String) {}
          override fun onRangeStart(utteranceId: String, start: Int, end: Int, frame: Int) {
            val (run, offset) = utteranceId.split(":")
            emit("range", run, offset.toInt() + start)
          }
          override fun onDone(utteranceId: String) {
            val parts = utteranceId.split(":")
            if (parts[2] == "1") emit("done", parts[0])
          }
          @Deprecated("Deprecated in Java")
          override fun onError(utteranceId: String) = emit("error", utteranceId.split(":")[0])
          override fun onError(utteranceId: String, errorCode: Int) = emit("error", utteranceId.split(":")[0])
        })
        ready = true
        waiting?.invoke()
        waiting = null
      }
    }

    /** On-device first, then the highest quality, preferring the phone's own language and country. */
    private fun bestVoice(engine: TextToSpeech): Voice? {
      val locale = Locale.getDefault()
      return engine.voices
        ?.filter { it.locale.language == locale.language && !it.features.contains("notInstalled") }
        ?.sortedWith(
          compareBy<Voice>({ it.isNetworkConnectionRequired }, { -it.quality }, { it.locale.country != locale.country }, { it.latency }),
        )
        ?.firstOrNull()
    }

    private val kokoro by lazy {
      KokoroSpeech(this@MainActivity) { json ->
        webView?.post { webView?.evaluateJavascript("window.__journalVoiceProgress && window.__journalVoiceProgress($json)", null) }
      }
    }

    /** Kokoro when its voice is downloaded, else (or if it fails to load) the system voice. */
    @JavascriptInterface
    fun speak(text: String, rate: Float, id: String) {
      tts?.stop()
      if (!kokoro.available()) return systemSpeak(text, rate, id)
      kokoro.speak(text, rate, id) { event, run, index ->
        if (event == "error") systemSpeak(text, rate, run) else emit(event, run, index)
      }
    }

    @JavascriptInterface fun voiceInfo(): String = kokoro.info()
    @JavascriptInterface fun downloadVoice(model: String) = kokoro.download(model)
    @JavascriptInterface fun removeVoice(model: String) = kokoro.remove(model)
    @JavascriptInterface fun setVoiceModel(model: String) {
      kokoro.model = model
    }
    @JavascriptInterface fun setVoice(voice: Int) {
      kokoro.voice = voice
    }

    private fun systemSpeak(text: String, rate: Float, id: String) = withTts { engine ->
      engine.stop()
      engine.setSpeechRate(rate)
      // Long text goes in chunks the engine accepts, split after a sentence or a space.
      val max = TextToSpeech.getMaxSpeechInputLength() - 100
      var start = 0
      while (start < text.length) {
        var end = minOf(text.length, start + max)
        if (end < text.length) {
          val cut = maxOf(text.lastIndexOf(". ", end), text.lastIndexOf("\n", end), text.lastIndexOf(' ', end))
          if (cut > start) end = cut + 1
        }
        val last = if (end >= text.length) "1" else "0"
        engine.speak(text.substring(start, end), TextToSpeech.QUEUE_ADD, null, "$id:$start:$last")
        start = end
      }
    }

    @JavascriptInterface
    fun stop() {
      kokoro.stop()
      tts?.stop()
    }

    fun shutdown() {
      kokoro.shutdown()
      tts?.shutdown()
      tts = null
      ready = false
    }
  }
}
