package com.hapi.dynamicjournal.watch

import android.content.Context
import android.os.VibrationEffect
import android.os.Vibrator
import androidx.wear.tiles.TileService
import com.google.android.gms.wearable.Asset
import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.Wearable
import com.google.android.gms.wearable.WearableListenerService
import kotlinx.coroutines.tasks.await
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** What the phone last sent (routine, reminders, tasks, projects, favourite formulas). */
data class Step(val id: String, val icon: String, val label: String, val span: Boolean, val running: Boolean, val done: Boolean, val next: Long?)
data class Habit(val id: String, val icon: String, val label: String, val today: Int)
data class Agenda(val id: String, val at: Long, val text: String, val done: Boolean)
data class Task(val day: String, val path: JSONArray, val text: String, val done: Boolean)
data class Variable(val name: String, val value: Double, val step: Double, val label: String?)
data class Formula(val name: String, val expr: String, val lhs: String, val vars: List<Variable>)
data class State(val at: Long, val steps: List<Step>, val habits: List<Habit>, val agenda: List<Agenda>, val tasks: List<Task>, val projects: List<String>, val formulas: List<Formula>)

object Link {
  private const val PREFS = "journal"

  fun parse(json: String?): State? = try {
    val o = JSONObject(json ?: return null)
    fun <T> list(key: String, f: (JSONObject) -> T): List<T> {
      val a = o.optJSONArray(key) ?: return emptyList()
      return (0 until a.length()).mapNotNull { a.optJSONObject(it)?.let(f) }
    }
    State(
      at = o.optLong("at"),
      steps = list("steps") { Step(it.optString("id"), it.optString("icon"), it.optString("label"), it.optBoolean("span"), it.optBoolean("running"), it.optBoolean("done"), if (it.has("next")) it.optLong("next") else null) },
      habits = list("habits") { Habit(it.optString("id"), it.optString("icon"), it.optString("label"), it.optInt("today")) },
      agenda = list("agenda") { Agenda(it.optString("id"), it.optLong("at"), it.optString("text"), it.optBoolean("done")) },
      tasks = list("tasks") { Task(it.optString("day"), it.optJSONArray("path") ?: JSONArray(), it.optString("text"), it.optBoolean("done")) },
      projects = (o.optJSONArray("projects") ?: JSONArray()).let { a -> (0 until a.length()).map { a.optString(it) } },
      formulas = list("formulas") { f ->
        val vs = f.optJSONArray("vars") ?: JSONArray()
        Formula(f.optString("name"), f.optString("expr"), f.optString("lhs"), (0 until vs.length()).mapNotNull { i ->
          vs.optJSONObject(i)?.let { Variable(it.optString("name"), it.optDouble("value", 1.0), it.optDouble("step", 1.0).takeIf { s -> s > 0 } ?: 1.0, it.optString("label").ifEmpty { null }) }
        })
      },
    )
  } catch (e: Exception) { null }

  fun saved(ctx: Context): State? = parse(ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("state", null))

  fun save(ctx: Context, json: String) {
    ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("state", json).apply()
    try { TileService.getUpdater(ctx).requestUpdate(JournalTile::class.java) } catch (e: Exception) { }
  }

  /** The newest state the phone has published (also when it arrived while the app was closed). */
  suspend fun fetch(ctx: Context): State? {
    try {
      val items = Wearable.getDataClient(ctx).dataItems.await()
      try {
        for (item in items) if (item.uri.path == "/journal/state") {
          val json = DataMapItem.fromDataItem(item).dataMap.getString("json") ?: continue
          save(ctx, json)
        }
      } finally { items.release() }
    } catch (e: Exception) { }
    return saved(ctx)
  }

  /** One thing for the journal: queued by Play services until the phone is in reach. */
  suspend fun send(ctx: Context, json: JSONObject, audio: File? = null) {
    json.put("at", json.optLong("at", System.currentTimeMillis()))
    val req = PutDataMapRequest.create("/journal/inbox/${UUID.randomUUID()}").apply {
      dataMap.putString("json", json.toString())
      if (audio != null) dataMap.putAsset("audio", Asset.createFromBytes(audio.readBytes()))
    }.asPutDataRequest().setUrgent()
    Wearable.getDataClient(ctx).putDataItem(req).await()
  }

  fun tick(ctx: Context, strong: Boolean = false) {
    try {
      val v = ctx.getSystemService(Vibrator::class.java) ?: return
      v.vibrate(VibrationEffect.createPredefined(if (strong) VibrationEffect.EFFECT_CLICK else VibrationEffect.EFFECT_TICK))
    } catch (e: Exception) { }
  }
}

/** The phone's state arriving while the app isn't open: kept for the app and the tile. */
class StateListener : WearableListenerService() {
  override fun onDataChanged(events: DataEventBuffer) {
    for (e in events) {
      if (e.type != DataEvent.TYPE_CHANGED || e.dataItem.uri.path != "/journal/state") continue
      val json = DataMapItem.fromDataItem(e.dataItem).dataMap.getString("json") ?: continue
      Link.save(this, json)
    }
  }
}
