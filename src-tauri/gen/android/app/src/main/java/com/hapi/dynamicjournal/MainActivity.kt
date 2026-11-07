package com.hapi.dynamicjournal

import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.Scope
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

  /** Google Drive sign-in for sync. Drive's Android app doesn't offer its folders to other apps, so we use the Drive API. */
  private val driveScope = Scope("https://www.googleapis.com/auth/drive")
  private var driveRequest = ""
  /** Weather: one quick, coarse location fix (asked once), answered through window.__journalLocation(id, json). */
  private var locationWaiting: String? = null
  private val askLocation = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
    val id = locationWaiting ?: return@registerForActivityResult
    locationWaiting = null
    if (granted) fixLocation(id) else answerLocation(id, null)
  }

  private fun answerLocation(id: String, loc: android.location.Location?) {
    val json = if (loc == null) "null" else JSONObject().put("lat", loc.latitude).put("lon", loc.longitude).toString()
    val js = "window.__journalLocation && window.__journalLocation(${JSONObject.quote(id)}, $json)"
    webView?.post { webView?.evaluateJavascript(js, null) }
  }

  private fun fixLocation(id: String) {
    val lm = getSystemService(Context.LOCATION_SERVICE) as android.location.LocationManager
    try {
      val provider = listOf(android.location.LocationManager.NETWORK_PROVIDER, android.location.LocationManager.GPS_PROVIDER)
        .firstOrNull { lm.isProviderEnabled(it) }
      val last = listOf(android.location.LocationManager.NETWORK_PROVIDER, android.location.LocationManager.GPS_PROVIDER, android.location.LocationManager.PASSIVE_PROVIDER)
        .mapNotNull { runCatching { lm.getLastKnownLocation(it) }.getOrNull() }
        .maxByOrNull { it.time }
      // A recent fix is enough for the weather; otherwise ask for one now (the location turns off right after).
      if (last != null && System.currentTimeMillis() - last.time < 30 * 60_000L || provider == null || android.os.Build.VERSION.SDK_INT < 30) {
        return answerLocation(id, last)
      }
      lm.getCurrentLocation(provider, null, mainExecutor) { loc -> answerLocation(id, loc ?: last) }
    } catch (e: SecurityException) {
      answerLocation(id, null)
    }
  }

  inner class LocationBridge {
    @JavascriptInterface
    fun request(id: String) = runOnUiThread {
      if (checkSelfPermission(android.Manifest.permission.ACCESS_COARSE_LOCATION) == android.content.pm.PackageManager.PERMISSION_GRANTED) fixLocation(id)
      else {
        locationWaiting = id
        askLocation.launch(android.Manifest.permission.ACCESS_COARSE_LOCATION)
      }
    }
  }

  private val authorizeDrive = registerForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { result ->
    val token = try {
      Identity.getAuthorizationClient(this).getAuthorizationResultFromIntent(result.data).accessToken
    } catch (e: Exception) {
      null
    }
    driveTokenDone(driveRequest, token)
  }

  private fun driveTokenDone(id: String, token: String?) {
    val js = "window.__journalDriveToken && window.__journalDriveToken(${JSONObject.quote(id)}, ${JSONObject.quote(token ?: "")})"
    webView?.post { webView?.evaluateJavascript(js, null) }
  }

  companion object {
    const val QUICK_NOTE = "com.hapi.dynamicjournal.QUICK_NOTE"
    /** From the floating bubble: open today and start a voice note. */
    const val VOICE_NOTE = "com.hapi.dynamicjournal.VOICE_NOTE"
    private var current: java.lang.ref.WeakReference<MainActivity>? = null

    /** Something is waiting to be added to today (e.g. a bubble note): tell the page if it's open. */
    fun notifyShared() {
      val activity = current?.get() ?: return
      activity.webView?.post { activity.webView?.evaluateJavascript("window.dispatchEvent(new Event('journal:shared'))", null) }
    }
    /** Shared files bigger than this are skipped (they'd go through the page as text). */
    private const val MAX_SHARED_BYTES = 60L * 1024 * 1024
  }

  /** A day page to open, from a tapped reminder or the Coming up widget. */
  @Volatile private var pendingOpenDay: String? = null
  private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

  /** Reminders: phone notifications, the Coming up widget and opening a day from them. Page: src/calendar/reminderBridge.ts. */
  inner class ReminderBridge {
    @JavascriptInterface fun schedule(json: String) = Reminders.schedule(this@MainActivity, json)
    @JavascriptInterface fun setUpcoming(json: String) = Reminders.setUpcoming(this@MainActivity, json)
    @JavascriptInterface fun takeOpenDay(): String {
      val day = pendingOpenDay ?: return ""
      pendingOpenDay = null
      return day
    }
    @JavascriptInterface fun askNotify() = runOnUiThread {
      if (android.os.Build.VERSION.SDK_INT >= 33 &&
        checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED
      ) askNotifications.launch(android.Manifest.permission.POST_NOTIFICATIONS)
    }
  }

  /** Samsung Health (through Health Connect): asks for read access to exercise and sleep. */
  private val askHealth = registerForActivityResult(androidx.health.connect.client.PermissionController.createRequestPermissionResultContract()) { }

  /** Exercise and sleep for the routine. Page: src/routine/health.ts. */
  inner class HealthBridge {
    @JavascriptInterface fun status(): String = try { Health.status(this@MainActivity) } catch (e: Exception) { "unavailable" }
    @JavascriptInterface fun askAccess() = runOnUiThread {
      try {
        when (androidx.health.connect.client.HealthConnectClient.getSdkStatus(this@MainActivity)) {
          androidx.health.connect.client.HealthConnectClient.SDK_AVAILABLE -> askHealth.launch(Health.PERMISSIONS)
          androidx.health.connect.client.HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED ->
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=com.google.android.apps.healthdata&url=healthconnect%3A%2F%2Fonboarding")))
          else -> {}
        }
      } catch (e: Exception) {
      }
    }
    @JavascriptInterface fun read(id: String, from: Long, to: Long) = Health.read(this@MainActivity, from, to) { json ->
      val js = "window.__journalHealth && window.__journalHealth(${JSONObject.quote(id)}, ${JSONObject.quote(json)})"
      webView?.post { webView?.evaluateJavascript(js, null) }
    }
  }

  private val askSms = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
    webView?.post { webView?.evaluateJavascript("window.dispatchEvent(new CustomEvent('journal:finance-access', { detail: ${if (granted) "true" else "false"} }))", null) }
  }

  /** Bank SMS and payment notifications for the money tracker. Page: src/finance/capture.ts. */
  inner class FinanceBridge {
    @JavascriptInterface fun smsStatus(): String = try { Finance.smsStatus(this@MainActivity) } catch (e: Exception) { "unavailable" }
    @JavascriptInterface fun askSms() = runOnUiThread { try { askSms.launch(android.Manifest.permission.READ_SMS) } catch (e: Exception) { } }
    @JavascriptInterface fun readSms(id: String, from: Long) = Finance.readSms(this@MainActivity, from) { json ->
      val js = "window.__journalFinance && window.__journalFinance(${JSONObject.quote(id)}, ${JSONObject.quote(json)})"
      webView?.post { webView?.evaluateJavascript(js, null) }
    }
    @JavascriptInterface fun notifyStatus(): String = try { Finance.notifyStatus(this@MainActivity) } catch (e: Exception) { "unavailable" }
    @JavascriptInterface fun openNotifyAccess() = runOnUiThread {
      try { startActivity(Intent(android.provider.Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) } catch (e: Exception) { }
    }
    @JavascriptInterface fun notifications(): String = try { Finance.peek(this@MainActivity) } catch (e: Exception) { "[]" }
    @JavascriptInterface fun clearNotifications(upTo: Long) = try { Finance.clear(this@MainActivity, upTo) } catch (e: Exception) { }
  }

  /** What was shared in (or a quick-note request), waiting for the page to take it. */
  @Volatile private var pendingShare: String? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    current = java.lang.ref.WeakReference(this)
    if (BubbleService.enabled(this)) BubbleService.setEnabled(this, true)
    // Instant sync talks to the Mac on the Wi-Fi; Android 17 needs this asked for once.
    val localNetwork = "android.permission.ACCESS_LOCAL_NETWORK"
    if (android.os.Build.VERSION.SDK_INT >= 37 && checkSelfPermission(localNetwork) != android.content.pm.PackageManager.PERMISSION_GRANTED)
      requestPermissions(arrayOf(localNetwork), 77)
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
    if (action == Reminders.OPEN_DAY) {
      pendingOpenDay = intent.getStringExtra("day")
      intent.action = null
      webView?.post { webView?.evaluateJavascript("window.dispatchEvent(new Event('journal:open-day'))", null) }
      return
    }
    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE && action != QUICK_NOTE && action != VOICE_NOTE) return
    val payload = JSONObject().put("quickNote", action == QUICK_NOTE || action == VOICE_NOTE).put("voice", action == VOICE_NOTE)
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
    // Back (button or edge swipe) is the journal's: it closes the panel on top or goes back a note.
    // Only when the journal has nothing to go back to does the app go to the background (never
    // closing it, which also lost the WebView's state).
    onBackPressedDispatcher.addCallback(this, object : androidx.activity.OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val view = this@MainActivity.webView ?: return
        view.evaluateJavascript("(function(){try{return !!(window.journalBack&&window.journalBack());}catch(e){return false;}})()") { handled ->
          if (handled != "true") moveTaskToBack(true)
        }
      }
    })
    // Same colour as the window until the page paints (no white flash at start).
    val night = (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES
    webView.setBackgroundColor(if (night) 0xFF16171C.toInt() else 0xFFE6EAF0.toInt())
    // A WebView left paused by an earlier journal window (see wakePage) would never run its timers.
    webView.resumeTimers()
    webView.addJavascriptInterface(SyncBridge(), "JournalSync")
    webView.addJavascriptInterface(ShareBridge(), "JournalShare")
    webView.addJavascriptInterface(SecretsBridge(), "JournalSecrets")
    webView.addJavascriptInterface(speech, "JournalSpeech")
    webView.addJavascriptInterface(BubbleBridge(), "JournalBubble")
    webView.addJavascriptInterface(HapticsBridge(), "JournalHaptics")
    webView.addJavascriptInterface(LocationBridge(), "JournalLocation")
    webView.addJavascriptInterface(ReminderBridge(), "JournalReminders")
    webView.addJavascriptInterface(PowerBridge(), "JournalPower")
    webView.addJavascriptInterface(HealthBridge(), "JournalHealth")
    webView.addJavascriptInterface(FinanceBridge(), "JournalFinance")
    webView.addJavascriptInterface(WatchBridge(), "JournalWatch")
    webView.addJavascriptInterface(DropBridge(), "JournalDrop")
    Watch.onInbox = { webView.post { webView.evaluateJavascript("window.dispatchEvent(new Event('journal:watch'))", null) } }
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

  /**
   * Glass haptics: the phone's crisp predefined ticks (S23 supports composition primitives), so a
   * touch feels like a light tap on glass and a swipe like a fine ripple, not a buzz.
   */
  inner class HapticsBridge {
    private val vibrator by lazy {
      if (android.os.Build.VERSION.SDK_INT >= 31)
        (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as android.os.VibratorManager).defaultVibrator
      else getSystemService(Context.VIBRATOR_SERVICE) as android.os.Vibrator
    }

    /** kind: "tap" (touching an element), "tick" (each step of a swipe), "press" (a button down), "edge" (end of a swipe). */
    @JavascriptInterface
    fun play(kind: String, strength: Float) {
      val v = vibrator
      if (!v.hasVibrator()) return
      val s = strength.coerceIn(0.05f, 1f)
      // The typing speed guide: a short double buzz, clearly more than a tap.
      if (kind == "warn") {
        val amp = (80 + 175 * s).toInt().coerceIn(1, 255)
        v.vibrate(android.os.VibrationEffect.createWaveform(longArrayOf(0, 35, 60, 35), intArrayOf(0, amp, 0, amp), -1))
        return
      }
      if (android.os.Build.VERSION.SDK_INT >= 30) {
        val primitive = when (kind) {
          "tick" -> android.os.VibrationEffect.Composition.PRIMITIVE_LOW_TICK
          "press" -> android.os.VibrationEffect.Composition.PRIMITIVE_CLICK
          "edge" -> android.os.VibrationEffect.Composition.PRIMITIVE_TICK
          else -> android.os.VibrationEffect.Composition.PRIMITIVE_TICK
        }
        if (v.areAllPrimitivesSupported(primitive)) {
          v.vibrate(android.os.VibrationEffect.startComposition().addPrimitive(primitive, s).compose())
          return
        }
      }
      if (android.os.Build.VERSION.SDK_INT >= 29) {
        val effect = if (kind == "press") android.os.VibrationEffect.EFFECT_CLICK else android.os.VibrationEffect.EFFECT_TICK
        v.vibrate(android.os.VibrationEffect.createPredefined(effect))
      } else {
        v.vibrate(if (kind == "press") 12L else 6L)
      }
    }
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

    /**
     * What's on the clipboard without reading it (no "pasted from your clipboard" notice), as JSON
     * {t: when it was copied, mimes: [...]}: the shared clipboard only reads it when this changed.
     */
    @JavascriptInterface
    fun stamp(): String {
      val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
      val d = try { clipboard.primaryClipDescription } catch (e: Exception) { null }
      val mimes = JSONArray()
      if (d != null) for (i in 0 until d.mimeTypeCount) mimes.put(d.getMimeType(i))
      val t = if (d != null && android.os.Build.VERSION.SDK_INT >= 26) d.timestamp else 0L
      return JSONObject().put("t", t).put("mimes", mimes).toString()
    }

    /** Puts an image (base64 bytes) on the clipboard, e.g. one copied on the Mac. */
    @JavascriptInterface
    fun setImage(mime: String, data: String): Boolean = try {
      val bytes = Base64.decode(data, Base64.DEFAULT)
      val dir = java.io.File(cacheDir, "shared-clip")
      dir.mkdirs()
      dir.listFiles()?.forEach { it.delete() }
      val ext = mime.substringAfter('/').substringBefore('+').ifEmpty { "png" }
      val file = java.io.File(dir, "clip-${System.currentTimeMillis()}.$ext")
      file.writeBytes(bytes)
      val uri = androidx.core.content.FileProvider.getUriForFile(this@MainActivity, "$packageName.fileprovider", file)
      val clip = android.content.ClipData.newUri(contentResolver, "Image from your Mac", uri)
      val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
      runOnUiThread { try { clipboard.setPrimaryClip(clip) } catch (e: Exception) { } }
      true
    } catch (e: Exception) {
      false
    }
  }

  /** An access token for Google Drive, answered through window.__journalDriveToken(id, token or ""). */
  inner class SyncBridge {
    /** interactive: may show the account chooser and consent screen; otherwise answers "" when they'd be needed. */
    @JavascriptInterface
    fun driveToken(id: String, interactive: Boolean) {
      val request = AuthorizationRequest.builder().setRequestedScopes(listOf(driveScope)).build()
      Identity.getAuthorizationClient(this@MainActivity).authorize(request)
        .addOnSuccessListener { r ->
          val intent = r.pendingIntent
          when {
            !r.hasResolution() -> driveTokenDone(id, r.accessToken)
            interactive && intent != null -> runOnUiThread {
              driveRequest = id
              authorizeDrive.launch(IntentSenderRequest.Builder(intent.intentSender).build())
            }
            else -> driveTokenDone(id, null)
          }
        }
        .addOnFailureListener { driveTokenDone(id, null) }
    }
  }

  /** Lets the page take what was shared in, and open the keyboard for a quick note. */
  /** Nexus › Send: a file from the Mac saved into Downloads (no permission needed on Android 10+). */
  inner class DropBridge {
    @JavascriptInterface
    fun save(name: String, mime: String, data: String): Boolean = try {
      val bytes = Base64.decode(data, Base64.DEFAULT)
      if (android.os.Build.VERSION.SDK_INT >= 29) {
        val values = android.content.ContentValues().apply {
          put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, name)
          put(android.provider.MediaStore.MediaColumns.MIME_TYPE, mime.ifEmpty { "application/octet-stream" })
          put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, "Download/Dynamic Journal")
        }
        val uri = contentResolver.insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        uri != null && contentResolver.openOutputStream(uri)?.use { it.write(bytes); true } == true
      } else {
        val dir = java.io.File(getExternalFilesDir(null), "Dynamic Journal").apply { mkdirs() }
        java.io.File(dir, name).writeBytes(bytes)
        true
      }
    } catch (e: Exception) { false }
  }

  /** Settings → Floating bubble. */
  inner class WatchBridge {
    @JavascriptInterface fun publish(json: String) = Watch.publish(this@MainActivity, json)
    @JavascriptInterface fun take(): String = try { Watch.take(this@MainActivity) } catch (e: Exception) { "[]" }
    @JavascriptInterface fun pending(): Boolean = Watch.pending(this@MainActivity)
  }

  inner class BubbleBridge {
    @JavascriptInterface fun enabled(): Boolean = BubbleService.enabled(this@MainActivity) && android.provider.Settings.canDrawOverlays(this@MainActivity)
    @JavascriptInterface fun canDraw(): Boolean = android.provider.Settings.canDrawOverlays(this@MainActivity)

    /** Turns it on (asking for "Display over other apps" first if needed) or off. Returns whether it's on. */
    @JavascriptInterface fun setEnabled(on: Boolean): Boolean {
      if (on && !android.provider.Settings.canDrawOverlays(this@MainActivity)) {
        // Remember the wish; onResume turns it on once the permission is granted.
        getSharedPreferences("bubble", Context.MODE_PRIVATE).edit().putBoolean("enabled", true).apply()
        startActivity(Intent(android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
        return false
      }
      BubbleService.setEnabled(this@MainActivity, on)
      return on
    }
  }

  // ───── Battery: let the page sleep in the background (page side: src/lib/power.ts) ─────
  // A WebView keeps running its JavaScript timers after the app leaves the screen. Once the app has
  // been out of sight for a while (the page has saved and sent its edits by then), its timers are
  // paused until it comes back, unless the page says something is playing or recording.
  private val sleepHandler = android.os.Handler(android.os.Looper.getMainLooper())
  @Volatile private var pageBusy = false
  private var pageAsleep = false
  private var inBackground = false
  private val sleepAfter = 30_000L
  private val sleepNow = Runnable {
    if (inBackground && !pageBusy && !pageAsleep) {
      webView?.pauseTimers()
      pageAsleep = true
    }
  }

  inner class PowerBridge {
    @JavascriptInterface fun setBusy(busy: Boolean) = runOnUiThread {
      pageBusy = busy
      if (busy && pageAsleep) wakePage()
      if (!busy && inBackground) {
        sleepHandler.removeCallbacks(sleepNow)
        sleepHandler.postDelayed(sleepNow, sleepAfter)
      }
    }
  }

  private fun wakePage() {
    sleepHandler.removeCallbacks(sleepNow)
    // Always: pauseTimers() holds every WebView in the process, so when the journal was closed
    // while asleep, the next one started with its timers stopped (a blank screen on opening).
    webView?.resumeTimers()
    pageAsleep = false
  }

  override fun onStart() {
    super.onStart()
    inBackground = false
    wakePage()
  }

  override fun onStop() {
    super.onStop()
    inBackground = true
    sleepHandler.removeCallbacks(sleepNow)
    sleepHandler.postDelayed(sleepNow, sleepAfter)
  }

  override fun onResume() {
    super.onResume()
    if (BubbleService.enabled(this) && android.provider.Settings.canDrawOverlays(this)) BubbleService.setEnabled(this, true)
    // Notes added from the bubble while the journal was in the background.
    notifyShared()
  }

  inner class ShareBridge {
    @JavascriptInterface
    fun takeNotes(): String = BubbleService.takeNotes(this@MainActivity)

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

    @JavascriptInterface
    fun hideKeyboard() {
      runOnUiThread {
        val view = webView ?: return@runOnUiThread
        (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(view.windowToken, 0)
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
            val parts = utteranceId.split(":")
            val offset = parts.getOrNull(1)?.toIntOrNull() ?: return
            emit("range", parts[0], offset + start)
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
        var piece = text.substring(start, end)
        // The system voice drops the end of a last word with no closing punctuation ("Understand").
        if (end >= text.length && piece.trimEnd().lastOrNull()?.isLetterOrDigit() == true) piece = piece.trimEnd() + "."
        engine.speak(piece, TextToSpeech.QUEUE_ADD, null, "$id:$start:0")
        start = end
      }
      // A moment of silence after the text, so the device plays the last sound out before "done".
      engine.playSilentUtterance(350, TextToSpeech.QUEUE_ADD, "$id:end:1")
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
