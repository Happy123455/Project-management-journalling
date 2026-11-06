package com.hapi.dynamicjournal

import android.content.Context
import android.net.Uri
import android.util.Base64
import com.google.android.gms.wearable.Asset
import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.Wearable
import com.google.android.gms.wearable.WearableListenerService
import com.google.android.gms.tasks.Tasks
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Galaxy Watch link (Wear OS Data Layer). Both apps share the package name and signing key.
 * - Phone → watch: the page publishes a small JSON state (routine steps, habits, today's reminders
 *   and tasks, projects, favourite formulas) as the data item /journal/state.
 * - Watch → phone: every tap, note or voice recording is its own data item /journal/inbox/<id>
 *   (queued by Play services until the phone is reachable). The listener below copies it into a
 *   small inbox on disk and deletes the item; the page takes the inbox when it's open (or on return)
 *   and writes it into the journal like any edit.
 */
object Watch {
  @Volatile var onInbox: (() -> Unit)? = null
  private val lock = Any()

  private fun dir(ctx: Context) = File(ctx.filesDir, "watch").apply { mkdirs() }
  private fun inboxFile(ctx: Context) = File(dir(ctx), "inbox.json")

  fun publish(ctx: Context, json: String) {
    try {
      val req = PutDataMapRequest.create("/journal/state").apply {
        dataMap.putString("json", json)
        dataMap.putLong("at", System.currentTimeMillis())
      }.asPutDataRequest().setUrgent()
      Wearable.getDataClient(ctx).putDataItem(req)
    } catch (e: Exception) {
      // No Play services / no watch: nothing to do.
    }
  }

  fun add(ctx: Context, item: JSONObject) {
    synchronized(lock) {
      val f = inboxFile(ctx)
      val list = try { JSONArray(f.readText()) } catch (e: Exception) { JSONArray() }
      list.put(item)
      f.writeText(list.toString())
    }
    onInbox?.invoke()
  }

  /** Everything the watch sent, oldest first, with recordings inlined as base64; the inbox is emptied. */
  fun take(ctx: Context): String {
    synchronized(lock) {
      val f = inboxFile(ctx)
      if (!f.exists()) return "[]"
      val list = try { JSONArray(f.readText()) } catch (e: Exception) { JSONArray() }
      f.delete()
      for (i in 0 until list.length()) {
        val o = list.optJSONObject(i) ?: continue
        val path = o.optString("file", "")
        if (path.isNotEmpty()) {
          val audio = File(path)
          if (audio.exists()) {
            o.put("data", Base64.encodeToString(audio.readBytes(), Base64.NO_WRAP))
            audio.delete()
          }
          o.remove("file")
        }
      }
      return list.toString()
    }
  }

  fun pending(ctx: Context): Boolean = synchronized(lock) { inboxFile(ctx).exists() }

  /** Copies one watch data item into the inbox (recording to a file) and deletes it from the Data Layer. */
  fun receive(ctx: Context, uri: Uri, item: DataMapItem) {
    val map = item.dataMap
    val json = map.getString("json") ?: return
    val o = try { JSONObject(json) } catch (e: Exception) { return }
    val asset: Asset? = map.getAsset("audio")
    if (asset != null) {
      try {
        val fd = Tasks.await(Wearable.getDataClient(ctx).getFdForAsset(asset))
        val name = o.optString("name", "watch-${System.currentTimeMillis()}.m4a").replace("/", "_")
        val out = File(dir(ctx), name)
        fd.inputStream.use { input -> out.outputStream().use { input.copyTo(it) } }
        o.put("file", out.absolutePath)
      } catch (e: Exception) {
        o.put("lost", true)
      }
    }
    add(ctx, o)
    try { Wearable.getDataClient(ctx).deleteDataItems(uri) } catch (e: Exception) { }
  }
}

class WatchListenerService : WearableListenerService() {
  override fun onDataChanged(events: DataEventBuffer) {
    for (e in events) {
      if (e.type != DataEvent.TYPE_CHANGED) continue
      val uri = e.dataItem.uri
      if (uri.path?.startsWith("/journal/inbox/") != true) continue
      Watch.receive(this, uri, DataMapItem.fromDataItem(e.dataItem))
    }
  }
}
