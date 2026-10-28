package com.hapi.dynamicjournal

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.FileProvider
import java.io.File

/**
 * Circle to capture: pick a screenshot (then draw a circle round the part to keep) or a screen recording.
 * Either one, with an optional note, is handed to MainActivity as a share, so it lands in today's note.
 */
class CaptureActivity : Activity() {
  companion object {
    const val ACTION_CROP = "com.hapi.dynamicjournal.CAPTURE_CROP"
    const val ACTION_NOTE = "com.hapi.dynamicjournal.CAPTURE_NOTE"
    const val EXTRA_PATH = "path"
    private const val REQUEST_PROJECTION = 1
    private const val REQUEST_NOTIFICATIONS = 2
  }

  private var record = false
  // While this screen waits invisibly for the service, it must not stay over the phone if nothing comes back.
  private val handler = android.os.Handler(android.os.Looper.getMainLooper())
  private val giveUp = Runnable { finish() }
  private fun waitForService() = handler.postDelayed(giveUp, 6000)

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    route(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    route(intent)
  }

  private fun route(intent: Intent) {
    handler.removeCallbacks(giveUp)
    // Only files this app captured (the screen is reachable from the launcher shortcut).
    val path = intent.getStringExtra(EXTRA_PATH)?.takeIf { File(it).canonicalPath.startsWith(File(cacheDir, "capture").canonicalPath + "/") }
    when {
      intent.action == ACTION_CROP && path != null -> showCrop(File(path))
      intent.action == ACTION_NOTE && path != null -> askNote { note -> share(File(path), "video/mp4", note) }
      // Stop from the recording notification; the service then brings back ACTION_NOTE.
      intent.action == CaptureService.ACTION_STOP -> {
        startService(Intent(this, CaptureService::class.java).setAction(CaptureService.ACTION_STOP))
        waitForService()
      }
      else -> chooseMode()
    }
  }

  private fun dialog() = AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)

  private fun chooseMode() {
    dialog()
      .setTitle("Capture to today")
      .setItems(arrayOf("⭕ Circle a screenshot", "⏺ Record the screen")) { _, which ->
        record = which == 1
        if (record && Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
          // The Stop button lives in a notification.
          requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS)
        } else {
          askProjection()
        }
      }
      .setOnCancelListener { finish() }
      .show()
  }

  override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode == REQUEST_NOTIFICATIONS) askProjection()
  }

  private fun askProjection() {
    val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
    // Whole screen straight away (the capture is of whatever app is underneath).
    val ask = if (Build.VERSION.SDK_INT >= 34) {
      manager.createScreenCaptureIntent(android.media.projection.MediaProjectionConfig.createConfigForDefaultDisplay())
    } else {
      manager.createScreenCaptureIntent()
    }
    @Suppress("DEPRECATION")
    startActivityForResult(ask, REQUEST_PROJECTION)
  }

  @Deprecated("Deprecated in Java")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    @Suppress("DEPRECATION")
    super.onActivityResult(requestCode, resultCode, data)
    if (requestCode != REQUEST_PROJECTION) return
    if (resultCode != RESULT_OK || data == null) return finish()
    val service = Intent(this, CaptureService::class.java)
      .putExtra(CaptureService.EXTRA_RESULT_CODE, resultCode)
      .putExtra(CaptureService.EXTRA_DATA, data)
      .putExtra(CaptureService.EXTRA_RECORD, record)
    if (Build.VERSION.SDK_INT >= 26) startForegroundService(service) else startService(service)
    // A recording runs over whatever app is open. A screenshot keeps this (empty, see-through) screen
    // open so the service may bring it back to crop.
    if (record) finish() else waitForService()
  }

  /** The screenshot full screen: draw round the part to keep, add a note, save. */
  private fun showCrop(file: File) {
    val bitmap = BitmapFactory.decodeFile(file.path) ?: return finish()
    val circle = CircleView(this, bitmap)
    val note = EditText(this).apply {
      hint = "Note (optional)"
      setTextColor(Color.WHITE)
      setHintTextColor(Color.LTGRAY)
      layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
    }
    val save = Button(this).apply {
      text = "Save"
      setOnClickListener {
        share(writePng(circle.cropped(), "circle-capture-${System.currentTimeMillis()}.png"), "image/png", note.text.toString())
      }
    }
    val cancel = Button(this).apply {
      text = "✕"
      setOnClickListener { finish() }
    }
    val bar = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      setBackgroundColor(0xCC000000.toInt())
      setPadding(24, 16, 24, 48)
      addView(cancel)
      addView(note)
      addView(save)
    }
    val hint = TextView(this).apply {
      text = "Draw a circle round what to keep (or just Save for the whole screen)"
      setTextColor(Color.WHITE)
      setBackgroundColor(0x99000000.toInt())
      setPadding(24, 120, 24, 16)
    }
    setContentView(FrameLayout(this).apply {
      setBackgroundColor(Color.BLACK)
      addView(circle, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
      addView(hint, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP))
      addView(bar, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
    })
  }

  private fun askNote(done: (String) -> Unit) {
    val note = EditText(this).apply { hint = "Note (optional)" }
    dialog()
      .setTitle("Save the recording to today")
      .setView(note)
      .setPositiveButton("Save") { _, _ -> done(note.text.toString()) }
      .setNegativeButton("Discard") { _, _ -> finish() }
      .setOnCancelListener { finish() }
      .show()
  }

  private fun writePng(bitmap: Bitmap, name: String): File {
    val file = File(File(cacheDir, "capture").apply { mkdirs() }, name)
    file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    return file
  }

  /** Hands the file (and note) to the journal exactly like a share from another app. */
  private fun share(file: File, mime: String, note: String) {
    val uri: Uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
    val intent = Intent(this, MainActivity::class.java)
      .setAction(Intent.ACTION_SEND)
      .setType(mime)
      .putExtra(Intent.EXTRA_STREAM, uri)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
    if (note.isNotBlank()) intent.putExtra(Intent.EXTRA_TEXT, note.trim())
    startActivity(intent)
    finish()
  }

  /** Shows the screenshot fitted to the screen and records the finger's loop. */
  private class CircleView(context: Context, private val bitmap: Bitmap) : View(context) {
    private val path = Path()
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      style = Paint.Style.STROKE
      strokeWidth = 10f
      strokeCap = Paint.Cap.ROUND
      strokeJoin = Paint.Join.ROUND
      color = 0xFF8AB4F8.toInt()
    }
    private val shade = Paint().apply { color = 0x66000000 }
    private val image = RectF()
    private var drawn = false

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
      val scale = minOf(w.toFloat() / bitmap.width, h.toFloat() / bitmap.height)
      val iw = bitmap.width * scale
      val ih = bitmap.height * scale
      image.set((w - iw) / 2, (h - ih) / 2, (w + iw) / 2, (h + ih) / 2)
    }

    override fun onDraw(canvas: Canvas) {
      canvas.drawBitmap(bitmap, null, image, null)
      if (drawn) {
        canvas.drawRect(image, shade)
        canvas.drawPath(path, stroke)
      }
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
      when (event.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          path.reset()
          path.moveTo(event.x, event.y)
          drawn = true
        }
        MotionEvent.ACTION_MOVE -> path.lineTo(event.x, event.y)
        MotionEvent.ACTION_UP -> path.close()
      }
      invalidate()
      return true
    }

    /** The loop's bounding box in screenshot pixels (the whole screenshot if nothing usable was drawn). */
    fun cropped(): Bitmap {
      if (!drawn) return bitmap
      val box = RectF()
      path.computeBounds(box, true)
      if (!box.intersect(image)) return bitmap
      val scale = bitmap.width / image.width()
      val left = ((box.left - image.left) * scale).toInt().coerceIn(0, bitmap.width - 1)
      val top = ((box.top - image.top) * scale).toInt().coerceIn(0, bitmap.height - 1)
      val width = (box.width() * scale).toInt().coerceIn(1, bitmap.width - left)
      val height = (box.height() * scale).toInt().coerceIn(1, bitmap.height - top)
      if (width < 24 || height < 24) return bitmap
      return Bitmap.createBitmap(bitmap, left, top, width, height)
    }
  }
}
