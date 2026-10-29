package com.hapi.dynamicjournal

import android.animation.ValueAnimator
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.view.animation.OvershootInterpolator
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sin
import org.json.JSONArray
import org.json.JSONObject

/**
 * The floating bubble: a liquid-glass drop over other apps (SYSTEM_ALERT_WINDOW). Drag it (it
 * wobbles and snaps to the edge), tap for the quick-capture menu, long-press or drop it on ✕ to hide.
 * Android only keeps an overlay alive from a foreground service, hence the quiet notification.
 */
class BubbleService : Service() {
  companion object {
    private const val CHANNEL = "bubble"
    private const val NOTIFICATION_ID = 8
    private const val PREFS = "bubble"
    const val ACTION_HIDE = "com.hapi.dynamicjournal.BUBBLE_HIDE"

    fun enabled(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("enabled", false)

    fun setEnabled(context: Context, on: Boolean) {
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("enabled", on).apply()
      val intent = Intent(context, BubbleService::class.java)
      if (on && Settings.canDrawOverlays(context)) {
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
      } else if (!on) {
        context.stopService(intent)
      }
    }

    /** Notes typed in the bubble, waiting for the journal page to add them to today. */
    fun queueNote(context: Context, text: String) {
      val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      val notes = JSONArray(prefs.getString("notes", "[]"))
      notes.put(JSONObject().put("text", text).put("at", System.currentTimeMillis()))
      prefs.edit().putString("notes", notes.toString()).apply()
      MainActivity.notifyShared()
    }

    fun takeNotes(context: Context): String {
      val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      val notes = prefs.getString("notes", "[]")!!
      prefs.edit().remove("notes").apply()
      return notes
    }
  }

  private lateinit var wm: WindowManager
  private val main = Handler(Looper.getMainLooper())
  private var bubble: DropView? = null
  private lateinit var bubbleParams: WindowManager.LayoutParams
  private var trash: TextView? = null
  private var menu: View? = null
  private var noteBox: View? = null

  private fun dp(v: Float) = v * resources.displayMetrics.density
  private fun dp(v: Int) = dp(v.toFloat()).toInt()
  private val screenW get() = resources.displayMetrics.widthPixels
  private val screenH get() = resources.displayMetrics.heightPixels

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_HIDE) {
      hide()
      return START_NOT_STICKY
    }
    startForegroundNotice()
    if (!Settings.canDrawOverlays(this)) {
      stopSelf()
      return START_NOT_STICKY
    }
    if (bubble == null) showBubble()
    return START_STICKY
  }

  private fun startForegroundNotice() {
    val manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26) {
      manager.createNotificationChannel(NotificationChannel(CHANNEL, "Floating bubble", NotificationManager.IMPORTANCE_MIN))
    }
    val hide = PendingIntent.getService(this, 2, Intent(this, BubbleService::class.java).setAction(ACTION_HIDE), PendingIntent.FLAG_IMMUTABLE)
    val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(this)
    val notification = builder
      .setSmallIcon(android.R.drawable.ic_menu_edit)
      .setContentTitle("Journal bubble is on")
      .setContentText("Tap to hide it")
      .setContentIntent(hide)
      .setOngoing(true)
      .build()
    if (Build.VERSION.SDK_INT >= 34) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun overlayParams(w: Int, h: Int, focusable: Boolean = false) = WindowManager.LayoutParams(
    w, h,
    if (Build.VERSION.SDK_INT >= 26) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE,
    (if (focusable) 0 else WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE) or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
    PixelFormat.TRANSLUCENT,
  ).apply { gravity = Gravity.TOP or Gravity.START }

  // ───────────── The drop ─────────────

  /** A see-through water drop: tinted glass, a bright rim and a highlight. */
  private inner class DropView(context: Context) : View(context) {
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val rim = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      style = Paint.Style.STROKE
      strokeWidth = dp(1.5f)
      color = Color.argb(170, 255, 255, 255)
    }
    private val shine = Paint(Paint.ANTI_ALIAS_FLAG)
    private val pen = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.argb(220, 255, 255, 255)
      textAlign = Paint.Align.CENTER
      textSize = dp(20f)
    }

    override fun onDraw(canvas: Canvas) {
      val r = dp(26f)
      val cx = width / 2f
      val cy = height / 2f
      fill.shader = RadialGradient(cx - r * 0.3f, cy - r * 0.35f, r * 1.4f,
        intArrayOf(Color.argb(120, 255, 255, 255), Color.argb(90, 150, 200, 255), Color.argb(150, 90, 120, 220)),
        floatArrayOf(0f, 0.55f, 1f), Shader.TileMode.CLAMP)
      canvas.drawCircle(cx, cy, r, fill)
      canvas.drawCircle(cx, cy, r, rim)
      shine.shader = RadialGradient(cx - r * 0.35f, cy - r * 0.45f, r * 0.45f,
        Color.argb(200, 255, 255, 255), Color.argb(0, 255, 255, 255), Shader.TileMode.CLAMP)
      canvas.drawOval(RectF(cx - r * 0.7f, cy - r * 0.8f, cx + r * 0.05f, cy - r * 0.15f), shine)
      canvas.drawText("✎", cx, cy + dp(7f), pen)
    }
  }

  private fun showBubble() {
    val view = DropView(this)
    val size = dp(72)
    bubbleParams = overlayParams(size, size).apply {
      x = screenW - size
      y = screenH / 3
    }
    val slop = ViewConfiguration.get(this).scaledTouchSlop
    var downX = 0f
    var downY = 0f
    var startX = 0
    var startY = 0
    var dragging = false
    var lastX = 0f
    var lastT = 0L
    val longPress = Runnable {
      if (!dragging) hideWithToast()
    }
    view.setOnTouchListener { v, e ->
      when (e.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          downX = e.rawX
          downY = e.rawY
          startX = bubbleParams.x
          startY = bubbleParams.y
          dragging = false
          lastX = e.rawX
          lastT = e.eventTime
          main.postDelayed(longPress, ViewConfiguration.getLongPressTimeout().toLong() + 200)
        }
        MotionEvent.ACTION_MOVE -> {
          val dx = e.rawX - downX
          val dy = e.rawY - downY
          if (!dragging && hypot(dx, dy) > slop) {
            dragging = true
            main.removeCallbacks(longPress)
            closeMenu()
            showTrash()
          }
          if (dragging) {
            bubbleParams.x = (startX + dx).toInt()
            bubbleParams.y = (startY + dy).toInt()
            wm.updateViewLayout(v, bubbleParams)
            // Squash and stretch with the speed of the drag: the "water drop" feel.
            val dt = (e.eventTime - lastT).coerceAtLeast(1)
            val speed = ((e.rawX - lastX) / dt).coerceIn(-3f, 3f)
            v.scaleX = 1f + abs(speed) * 0.12f
            v.scaleY = 1f - abs(speed) * 0.08f
            lastX = e.rawX
            lastT = e.eventTime
            trash?.alpha = if (overTrash()) 1f else 0.6f
          }
        }
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
          main.removeCallbacks(longPress)
          if (dragging) {
            val dismiss = overTrash()
            hideTrash()
            if (dismiss) {
              hideWithToast()
            } else {
              wobble(v)
              snapToEdge(v)
            }
          } else if (e.actionMasked == MotionEvent.ACTION_UP && e.eventTime - e.downTime < ViewConfiguration.getLongPressTimeout()) {
            wobble(v)
            if (menu == null) showMenu() else closeMenu()
          }
        }
      }
      true
    }
    wm = getSystemService(WindowManager::class.java)
    wm.addView(view, bubbleParams)
    bubble = view
  }

  private fun wobble(v: View) {
    v.animate().scaleX(1f).scaleY(1f).setInterpolator(OvershootInterpolator(6f)).setDuration(420).start()
  }

  private fun snapToEdge(v: View) {
    val target = if (bubbleParams.x + v.width / 2 < screenW / 2) 0 else screenW - v.width
    bubbleParams.y = bubbleParams.y.coerceIn(dp(24), screenH - v.height - dp(48))
    ValueAnimator.ofInt(bubbleParams.x, target).apply {
      duration = 260
      interpolator = OvershootInterpolator(1.4f)
      addUpdateListener {
        if (bubble == null) return@addUpdateListener
        bubbleParams.x = it.animatedValue as Int
        wm.updateViewLayout(v, bubbleParams)
      }
      start()
    }
  }

  // ───────────── ✕ to dismiss ─────────────

  private fun showTrash() {
    if (trash != null) return
    val view = TextView(this).apply {
      text = "✕"
      textSize = 22f
      setTextColor(Color.WHITE)
      gravity = Gravity.CENTER
      alpha = 0.6f
      background = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(Color.argb(160, 30, 30, 40))
        setStroke(dp(1), Color.argb(150, 255, 255, 255))
      }
    }
    val size = dp(64)
    wm.addView(view, overlayParams(size, size).apply {
      x = (screenW - size) / 2
      y = screenH - size - dp(72)
    })
    trash = view
  }

  private fun overTrash(): Boolean {
    val t = trash ?: return false
    val p = t.layoutParams as WindowManager.LayoutParams
    val bx = bubbleParams.x + dp(36)
    val by = bubbleParams.y + dp(36)
    return hypot((bx - (p.x + p.width / 2)).toFloat(), (by - (p.y + p.height / 2)).toFloat()) < dp(70)
  }

  private fun hideTrash() {
    trash?.let { wm.removeView(it) }
    trash = null
  }

  private fun hideWithToast() {
    Toast.makeText(this, "Bubble hidden. Turn it back on in the journal's Settings.", Toast.LENGTH_SHORT).show()
    hide()
  }

  private fun hide() {
    getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("enabled", false).apply()
    stopSelf()
  }

  // ───────────── The radial menu ─────────────

  private fun glassButton(label: String, action: () -> Unit) = TextView(this).apply {
    text = label
    textSize = 20f
    gravity = Gravity.CENTER
    setTextColor(Color.WHITE)
    background = GradientDrawable().apply {
      shape = GradientDrawable.OVAL
      colors = intArrayOf(Color.argb(150, 160, 200, 255), Color.argb(170, 70, 90, 170))
      gradientType = GradientDrawable.RADIAL_GRADIENT
      gradientRadius = dp(40f)
      setStroke(dp(1), Color.argb(170, 255, 255, 255))
    }
    elevation = dp(6f)
    setOnClickListener {
      closeMenu()
      action()
    }
  }

  private fun showMenu() {
    val layer = FrameLayout(this)
    layer.setOnClickListener { closeMenu() }
    val items = listOf(
      "⭕" to { startActivity(Intent(this, CaptureActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) },
      "✏️" to { showNoteBox(fromClipboard = false) },
      "📋" to { showNoteBox(fromClipboard = true) },
      "🎙" to {
        startActivity(Intent(this, MainActivity::class.java).setAction(MainActivity.VOICE_NOTE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      },
    )
    val size = dp(52)
    val radius = dp(92f)
    val cx = bubbleParams.x + dp(36)
    val cy = bubbleParams.y + dp(36)
    val onLeft = cx < screenW / 2
    items.forEachIndexed { i, (label, action) ->
      // A fan of four, opening towards the middle of the screen.
      val angle = Math.toRadians(-60.0 + i * 40.0)
      val dx = (cos(angle) * radius).toInt() * (if (onLeft) 1 else -1)
      val dy = (sin(angle) * radius).toInt()
      val button = glassButton(label, action)
      layer.addView(button, FrameLayout.LayoutParams(size, size).apply {
        leftMargin = (cx + dx - size / 2).coerceIn(0, screenW - size)
        topMargin = (cy + dy - size / 2).coerceIn(0, screenH - size)
      })
      button.scaleX = 0f
      button.scaleY = 0f
      button.animate().scaleX(1f).scaleY(1f).setStartDelay(i * 35L).setInterpolator(OvershootInterpolator(3f)).setDuration(260).start()
    }
    wm.addView(layer, overlayParams(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT))
    menu = layer
    // Keep the drop above its menu.
    bubble?.let {
      wm.removeView(it)
      wm.addView(it, bubbleParams)
    }
  }

  private fun closeMenu() {
    menu?.let { wm.removeView(it) }
    menu = null
  }

  // ───────────── Quick note ─────────────

  /** A small glass box that adds its text to today without opening the journal. */
  private fun showNoteBox(fromClipboard: Boolean) {
    if (noteBox != null) return
    val input = EditText(this).apply {
      hint = if (fromClipboard) "Clipboard" else "Quick note for today"
      minLines = 3
      maxLines = 8
      gravity = Gravity.TOP or Gravity.START
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
      setTextColor(Color.WHITE)
      setHintTextColor(Color.argb(160, 255, 255, 255))
      background = null
    }
    val box = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(16), dp(14), dp(16), dp(8))
      background = GradientDrawable().apply {
        cornerRadius = dp(24f)
        colors = intArrayOf(Color.argb(215, 70, 80, 130), Color.argb(225, 35, 40, 70))
        setStroke(dp(1), Color.argb(150, 255, 255, 255))
      }
      addView(TextView(this@BubbleService).apply {
        text = if (fromClipboard) "📋 Paste to today" else "✏️ Quick note"
        setTextColor(Color.WHITE)
        textSize = 15f
      })
      addView(input)
    }
    val close = { noteBox?.let { wm.removeView(it) }; noteBox = null }
    val buttons = LinearLayout(this).apply {
      gravity = Gravity.END
      addView(Button(this@BubbleService).apply {
        text = "Cancel"
        setOnClickListener { close() }
      })
      addView(Button(this@BubbleService).apply {
        text = "Add to today"
        setOnClickListener {
          val text = input.text.toString().trim()
          if (text.isNotEmpty()) {
            queueNote(this@BubbleService, text)
            Toast.makeText(this@BubbleService, "Added to today", Toast.LENGTH_SHORT).show()
          }
          close()
        }
      })
    }
    box.addView(buttons)
    val params = overlayParams(dp(320), WindowManager.LayoutParams.WRAP_CONTENT, focusable = true).apply {
      gravity = Gravity.CENTER
      softInputMode = WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE or WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
    }
    wm.addView(box, params)
    noteBox = box
    input.requestFocus()
    if (fromClipboard) {
      // Android only lets the focused window read the clipboard, so wait until this box has focus.
      box.viewTreeObserver.addOnWindowFocusChangeListener { focused ->
        if (focused && input.text.isEmpty()) {
          val clip = (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).primaryClip
          val text = clip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this)?.toString().orEmpty()
          if (text.isEmpty()) input.hint = "The clipboard is empty" else input.setText(text)
        }
      }
    }
  }

  override fun onDestroy() {
    closeMenu()
    hideTrash()
    noteBox?.let { wm.removeView(it) }
    bubble?.let { wm.removeView(it) }
    bubble = null
    super.onDestroy()
  }
}
