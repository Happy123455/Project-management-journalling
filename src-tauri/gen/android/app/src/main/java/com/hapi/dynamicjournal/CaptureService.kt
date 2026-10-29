package com.hapi.dynamicjournal

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.MediaRecorder
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import android.view.WindowManager
import java.io.File

/** Holds the screen-capture session: one screenshot, or a recording until Stop is tapped in its notification. */
class CaptureService : Service() {
  companion object {
    const val EXTRA_RESULT_CODE = "resultCode"
    const val EXTRA_DATA = "data"
    const val EXTRA_RECORD = "record"
    const val ACTION_STOP = "com.hapi.dynamicjournal.CAPTURE_STOP"
    private const val CHANNEL = "capture"
    private const val NOTIFICATION_ID = 7
    /** Wait for the capture screen and the system dialog to go before taking the screenshot. */
    private const val SCREENSHOT_DELAY_MS = 450L
  }

  private val main = Handler(Looper.getMainLooper())
  private var projection: MediaProjection? = null
  private var display: VirtualDisplay? = null
  private var reader: ImageReader? = null
  private var recorder: MediaRecorder? = null
  private var output: File? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopRecording()
      return START_NOT_STICKY
    }
    val record = intent?.getBooleanExtra(EXTRA_RECORD, false) ?: false
    startForegroundNotice(record)
    val code = intent?.getIntExtra(EXTRA_RESULT_CODE, 0) ?: 0
    @Suppress("DEPRECATION")
    val data = intent?.getParcelableExtra<Intent>(EXTRA_DATA)
    if (data == null) return stop()
    val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
    val p = manager.getMediaProjection(code, data) ?: return stop()
    projection = p
    // Required before creating the virtual display (Android 14+); the user can also end it from the system.
    p.registerCallback(object : MediaProjection.Callback() {
      override fun onStop() {
        if (recorder != null) main.post { stopRecording() }
      }
    }, main)
    try {
      if (record) startRecording(p) else main.postDelayed({ screenshot(p) }, SCREENSHOT_DELAY_MS)
    } catch (e: Exception) {
      Log.e("CaptureService", "capture failed", e)
      stop()
    }
    return START_NOT_STICKY
  }

  private fun startForegroundNotice(record: Boolean) {
    val manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26) {
      manager.createNotificationChannel(NotificationChannel(CHANNEL, "Screen capture", NotificationManager.IMPORTANCE_LOW))
    }
    val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(this)
    builder
      .setSmallIcon(android.R.drawable.ic_menu_camera)
      .setContentTitle(if (record) "Recording the screen for today's note" else "Taking a screenshot…")
      .setOngoing(true)
    if (record) {
      // Through the (invisible) capture screen: a service started from a notification may not open screens.
      val stop = PendingIntent.getActivity(
        this, 0,
        Intent(this, CaptureActivity::class.java).setAction(ACTION_STOP).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        PendingIntent.FLAG_IMMUTABLE,
      )
      builder.setContentText("Tap to stop and save").setContentIntent(stop)
      @Suppress("DEPRECATION")
      builder.addAction(android.R.drawable.ic_media_pause, "Stop", stop)
    }
    val notification = builder.build()
    if (Build.VERSION.SDK_INT >= 29) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private data class Size(val width: Int, val height: Int, val dpi: Int)

  private fun screenSize(): Size {
    val wm = getSystemService(WindowManager::class.java)
    val dpi = resources.displayMetrics.densityDpi
    if (Build.VERSION.SDK_INT >= 30) {
      val bounds = wm.maximumWindowMetrics.bounds
      return Size(bounds.width(), bounds.height(), dpi)
    }
    val metrics = android.util.DisplayMetrics()
    @Suppress("DEPRECATION")
    wm.defaultDisplay.getRealMetrics(metrics)
    return Size(metrics.widthPixels, metrics.heightPixels, dpi)
  }

  private fun screenshot(p: MediaProjection) {
    val size = screenSize()
    val r = ImageReader.newInstance(size.width, size.height, PixelFormat.RGBA_8888, 2)
    reader = r
    r.setOnImageAvailableListener({ source ->
      val image = source.acquireLatestImage() ?: return@setOnImageAvailableListener
      source.setOnImageAvailableListener(null, null)
      val plane = image.planes[0]
      // Rows can be padded: copy into a wide enough bitmap, then trim.
      val rowWidth = plane.rowStride / plane.pixelStride
      val padded = Bitmap.createBitmap(rowWidth, size.height, Bitmap.Config.ARGB_8888)
      padded.copyPixelsFromBuffer(plane.buffer)
      image.close()
      val bitmap = Bitmap.createBitmap(padded, 0, 0, size.width, size.height)
      val file = File(File(cacheDir, "capture").apply { mkdirs() }, "screen.png")
      file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
      startActivity(
        Intent(this, CaptureActivity::class.java)
          .setAction(CaptureActivity.ACTION_CROP)
          .putExtra(CaptureActivity.EXTRA_PATH, file.path)
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      )
      stop()
    }, main)
    display = p.createVirtualDisplay("journal-screenshot", size.width, size.height, size.dpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, r.surface, null, main)
  }

  private fun startRecording(p: MediaProjection) {
    val full = screenSize()
    // Half resolution keeps a few minutes under the share size limit; sizes must be even for the encoder.
    val width = (full.width / 2) and 1.inv()
    val height = (full.height / 2) and 1.inv()
    val file = File(File(cacheDir, "capture").apply { mkdirs() }, "screen-recording-${System.currentTimeMillis()}.mp4")
    output = file
    val r = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(this) else @Suppress("DEPRECATION") MediaRecorder()
    r.setVideoSource(MediaRecorder.VideoSource.SURFACE)
    r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
    r.setVideoEncoder(MediaRecorder.VideoEncoder.H264)
    r.setVideoSize(width, height)
    r.setVideoFrameRate(30)
    r.setVideoEncodingBitRate(3_000_000)
    r.setOutputFile(file.path)
    r.prepare()
    recorder = r
    display = p.createVirtualDisplay("journal-recording", width, height, full.dpi / 2, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, r.surface, null, main)
    r.start()
  }

  private fun stopRecording() {
    val r = recorder ?: run {
      stop()
      return
    }
    recorder = null
    val saved = try {
      r.stop()
      true
    } catch (e: RuntimeException) {
      // Stopped before any frame was written.
      false
    }
    r.release()
    val file = output
    stop()
    if (saved && file != null) {
      startActivity(
        Intent(this, CaptureActivity::class.java)
          .setAction(CaptureActivity.ACTION_NOTE)
          .putExtra(CaptureActivity.EXTRA_PATH, file.path)
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      )
    }
  }

  private fun stop(): Int {
    display?.release()
    display = null
    reader?.close()
    reader = null
    projection?.stop()
    projection = null
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
    return START_NOT_STICKY
  }
}
