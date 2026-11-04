package com.hapi.dynamicjournal

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/**
 * Money in and out, read on the phone only (nothing leaves it except into the journal):
 * - bank and card SMS alerts from the inbox (READ_SMS, asked once), and
 * - payment notifications from Google Pay, PhonePe, Paytm, BHIM and bank apps (notification access,
 *   switched on by the person in Android's settings), kept in a small queue until the journal opens.
 * The page (src/finance/capture.ts) reads the text and decides what is a transaction.
 */
object Finance {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private const val PREFS = "journal-finance"
  private const val QUEUE = "notifications"

  /** Payment apps whose notifications are kept (when notification access is on). */
  val APPS = setOf(
    "com.google.android.apps.nbu.paisa.user", // Google Pay
    "com.phonepe.app",
    "net.one97.paytm",
    "in.org.npci.upiapp", // BHIM
    "com.csam.icici.bank.imobile",
    "com.snapwork.hdfc",
    "com.sbi.lotusintouch",
    "com.sbi.SBIFreedomPlus",
    "com.axis.mobile",
    "com.msf.kbank.mobile",
    "com.dreamplug.androidapp", // CRED
    "com.amazon.mShop.android.shopping", // Amazon Pay
  )

  fun smsStatus(context: Context): String =
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_SMS) == PackageManager.PERMISSION_GRANTED) "ready" else "ask"

  fun notifyStatus(context: Context): String {
    val enabled = Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners") ?: ""
    val me = ComponentName(context, FinanceNotifications::class.java).flattenToString()
    return if (enabled.split(":").any { it == me }) "ready" else "ask"
  }

  /** Inbox messages since `from` (ms) that mention an amount, as JSON [{sender, body, at}]. */
  fun readSms(context: Context, from: Long, answer: (String) -> Unit) {
    if (smsStatus(context) != "ready") return answer("null")
    scope.launch {
      val json = try {
        val out = JSONArray()
        context.contentResolver.query(
          Uri.parse("content://sms/inbox"),
          arrayOf("address", "body", "date"),
          "date > ?",
          arrayOf(from.toString()),
          "date ASC",
        )?.use { c ->
          val money = Regex("(?i)(rs\\.?|inr|₹|debited|credited)")
          while (c.moveToNext() && out.length() < 3000) {
            val body = c.getString(1) ?: continue
            if (!money.containsMatchIn(body)) continue
            out.put(JSONObject().put("sender", c.getString(0) ?: "").put("body", body).put("at", c.getLong(2)))
          }
        }
        out.toString()
      } catch (e: Exception) {
        "null"
      }
      answer(json)
    }
  }

  fun keep(context: Context, pkg: String, title: String, text: String, at: Long) {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    synchronized(this) {
      val list = try { JSONArray(prefs.getString(QUEUE, "[]")) } catch (e: Exception) { JSONArray() }
      // The same notification is often posted again (updated): keep it once.
      for (i in 0 until list.length()) {
        val o = list.getJSONObject(i)
        if (o.optString("title") == title && o.optString("text") == text && Math.abs(o.optLong("at") - at) < 10 * 60_000) return
      }
      list.put(JSONObject().put("app", pkg).put("title", title).put("text", text).put("at", at))
      // The newest 400 at most.
      val trimmed = JSONArray()
      for (i in maxOf(0, list.length() - 400) until list.length()) trimmed.put(list.get(i))
      prefs.edit().putString(QUEUE, trimmed.toString()).apply()
    }
  }

  /** Kept notifications, oldest first, as JSON; they stay until `clear` (after the page has written them). */
  fun peek(context: Context): String = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(QUEUE, "[]") ?: "[]"

  /** Removes the kept notifications up to and including time `upTo` (ms). */
  fun clear(context: Context, upTo: Long) {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    synchronized(this) {
      val list = try { JSONArray(prefs.getString(QUEUE, "[]")) } catch (e: Exception) { JSONArray() }
      val rest = JSONArray()
      for (i in 0 until list.length()) if (list.getJSONObject(i).optLong("at") > upTo) rest.put(list.get(i))
      prefs.edit().putString(QUEUE, rest.toString()).apply()
    }
  }
}

/** Keeps payment notifications (see Finance.APPS) that mention an amount. Turned on in Android's notification access settings. */
class FinanceNotifications : NotificationListenerService() {
  override fun onNotificationPosted(sbn: StatusBarNotification) {
    try {
      if (sbn.packageName !in Finance.APPS) return
      val extras = sbn.notification.extras
      val title = extras.getCharSequence("android.title")?.toString() ?: ""
      val text = (extras.getCharSequence("android.bigText") ?: extras.getCharSequence("android.text"))?.toString() ?: ""
      if (!Regex("(?i)(₹|rs\\.?\\s?\\d|inr)").containsMatchIn("$title $text")) return
      Finance.keep(applicationContext, sbn.packageName, title, text, sbn.postTime)
    } catch (e: Exception) {
    }
  }
}
