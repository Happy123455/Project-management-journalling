package com.hapi.dynamicjournal

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.widget.RemoteViews
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONArray

/**
 * Reminder notifications and the Coming up widget. The page works out what is due when (times
 * written in reminders, a morning nudge for the rest, repeats) and hands the whole list over;
 * this side only schedules it with the system, shows it, and keeps it across restarts.
 */
object Reminders {
  const val OPEN_DAY = "com.hapi.dynamicjournal.OPEN_DAY"
  private const val CHANNEL = "reminders"
  private const val PREFS = "reminders"
  private const val ALARM = "com.hapi.dynamicjournal.REMINDER"

  private fun prefs(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  /** Replaces every scheduled reminder with `json` ([{id, at, title, body, day}]). */
  fun schedule(c: Context, json: String) {
    val am = c.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    // Cancel what was scheduled before (by its request code).
    val old = prefs(c).getString("codes", "") ?: ""
    for (code in old.split(",").filter { it.isNotBlank() }) {
      val pi = PendingIntent.getBroadcast(c, code.toInt(), Intent(c, ReminderReceiver::class.java).setAction(ALARM), PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE)
      if (pi != null) {
        am.cancel(pi)
        pi.cancel()
      }
    }
    val list = try { JSONArray(json) } catch (e: Exception) { JSONArray() }
    val codes = mutableListOf<Int>()
    val now = System.currentTimeMillis()
    for (i in 0 until list.length()) {
      val a = list.getJSONObject(i)
      val at = a.optLong("at")
      if (at <= now) continue
      val code = a.optString("id").hashCode()
      val intent = Intent(c, ReminderReceiver::class.java).setAction(ALARM)
        .putExtra("id", a.optString("id"))
        .putExtra("title", a.optString("title"))
        .putExtra("body", a.optString("body"))
        .putExtra("day", a.optString("day"))
      val pi = PendingIntent.getBroadcast(c, code, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      try {
        // On time when Android allows exact alarms; otherwise within a few minutes.
        if (Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
        else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
      } catch (e: SecurityException) {
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
      }
      codes.add(code)
    }
    prefs(c).edit().putString("alarms", json).putString("codes", codes.joinToString(",")).apply()
  }

  /** After a restart the system has forgotten the alarms: schedule them again. */
  fun reschedule(c: Context) {
    schedule(c, prefs(c).getString("alarms", "[]") ?: "[]")
  }

  fun notify(c: Context, intent: Intent) {
    val manager = c.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(CHANNEL) == null) {
      manager.createNotificationChannel(NotificationChannel(CHANNEL, "Reminders", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "Notes you wrote on a future day, at the time you wrote"
      })
    }
    val day = intent.getStringExtra("day") ?: ""
    val open = Intent(c, MainActivity::class.java).setAction(OPEN_DAY).putExtra("day", day)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    val tap = PendingIntent.getActivity(c, (intent.getStringExtra("id") ?: day).hashCode(), open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val body = intent.getStringExtra("body") ?: ""
    val n = NotificationCompat.Builder(c, CHANNEL)
      .setSmallIcon(android.R.drawable.ic_popup_reminder)
      .setContentTitle(intent.getStringExtra("title") ?: "Reminder")
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setCategory(NotificationCompat.CATEGORY_REMINDER)
      .setContentIntent(tap)
      .setAutoCancel(true)
      .build()
    try {
      NotificationManagerCompat.from(c).notify((intent.getStringExtra("id") ?: day).hashCode(), n)
    } catch (e: SecurityException) {
      // Notifications not allowed: nothing to show.
    }
  }

  /** The widget's rows ([{day, label, text, left, repeat}]), then redraws every widget. */
  fun setUpcoming(c: Context, json: String) {
    prefs(c).edit().putString("upcoming", json).apply()
    UpcomingWidget.updateAll(c)
  }

  fun upcoming(c: Context): JSONArray = try { JSONArray(prefs(c).getString("upcoming", "[]")) } catch (e: Exception) { JSONArray() }
}

class ReminderReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    when (intent.action) {
      Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED, "android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED" -> {
        Reminders.reschedule(context)
        UpcomingWidget.updateAll(context)
      }
      else -> Reminders.notify(context, intent)
    }
  }
}

/** Home-screen widget: what's coming up, soonest first, with days left. Tap a row to open its day. */
class UpcomingWidget : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    for (id in ids) manager.updateAppWidget(id, views(context))
  }

  companion object {
    private val ROWS = intArrayOf(R.id.widget_row0, R.id.widget_row1, R.id.widget_row2, R.id.widget_row3, R.id.widget_row4)
    private val DAYS = intArrayOf(R.id.widget_day0, R.id.widget_day1, R.id.widget_day2, R.id.widget_day3, R.id.widget_day4)
    private val TEXTS = intArrayOf(R.id.widget_text0, R.id.widget_text1, R.id.widget_text2, R.id.widget_text3, R.id.widget_text4)
    private val LEFTS = intArrayOf(R.id.widget_left0, R.id.widget_left1, R.id.widget_left2, R.id.widget_left3, R.id.widget_left4)

    fun updateAll(c: Context) {
      val manager = AppWidgetManager.getInstance(c)
      val ids = manager.getAppWidgetIds(ComponentName(c, UpcomingWidget::class.java))
      for (id in ids) manager.updateAppWidget(id, views(c))
    }

    private fun openIntent(c: Context, day: String?, code: Int): PendingIntent {
      val open = Intent(c, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      if (day != null) open.setAction(Reminders.OPEN_DAY).putExtra("day", day)
      return PendingIntent.getActivity(c, code, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    fun views(c: Context): RemoteViews {
      val v = RemoteViews(c.packageName, R.layout.widget_upcoming)
      val list = Reminders.upcoming(c)
      v.setOnClickPendingIntent(R.id.widget_title, openIntent(c, null, 9000))
      v.setViewVisibility(R.id.widget_empty, if (list.length() == 0) android.view.View.VISIBLE else android.view.View.GONE)
      for (i in ROWS.indices) {
        if (i < list.length()) {
          val r = list.getJSONObject(i)
          val left = r.optInt("left")
          v.setViewVisibility(ROWS[i], android.view.View.VISIBLE)
          v.setTextViewText(DAYS[i], r.optString("label") + if (r.optBoolean("repeat")) " 🔁" else "")
          v.setTextViewText(TEXTS[i], r.optString("text"))
          v.setTextViewText(LEFTS[i], if (left <= 1) "tomorrow" else "${left}d")
          v.setOnClickPendingIntent(ROWS[i], openIntent(c, r.optString("day"), 9001 + i))
        } else v.setViewVisibility(ROWS[i], android.view.View.GONE)
      }
      return v
    }
  }
}
