package com.hapi.dynamicjournal.watch

import androidx.wear.protolayout.ActionBuilders
import androidx.wear.protolayout.ColorBuilders.argb
import androidx.wear.protolayout.DimensionBuilders.dp
import androidx.wear.protolayout.DimensionBuilders.expand
import androidx.wear.protolayout.DimensionBuilders.sp
import androidx.wear.protolayout.LayoutElementBuilders
import androidx.wear.protolayout.ModifiersBuilders
import androidx.wear.protolayout.ResourceBuilders
import androidx.wear.protolayout.TimelineBuilders
import androidx.wear.tiles.RequestBuilders
import androidx.wear.tiles.TileBuilders
import androidx.wear.tiles.TileService
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** The watch's widget: what's running, the next reminder, routine and task counts. Tap: the app. */
class JournalTile : TileService() {
  override fun onTileRequest(requestParams: RequestBuilders.TileRequest): ListenableFuture<TileBuilders.Tile> {
    val s = Link.saved(this)
    val lines = mutableListOf<Pair<String, Int>>()
    if (s == null) lines += "Open Journal on the phone" to 0xFFB0B0C0.toInt()
    else {
      val now = System.currentTimeMillis()
      s.steps.firstOrNull { it.running }?.let { lines += "${it.icon} ${it.label} now" to 0xFFFFD166.toInt() }
      val time = SimpleDateFormat("HH:mm", Locale.getDefault())
      s.agenda.firstOrNull { !it.done && it.at >= now - 15 * 60_000 }?.let { lines += "⏰ ${time.format(Date(it.at))} ${it.text}".take(28) to 0xFFFFFFFF.toInt() }
      val stepsDone = s.steps.count { it.done }
      lines += "Routine $stepsDone/${s.steps.size}" to 0xFFA78BFA.toInt()
      val tasks = s.tasks
      lines += "Tasks ${tasks.count { it.done }}/${tasks.size}" to 0xFF7DD3FC.toInt()
      s.steps.firstOrNull { !it.done && !it.running && it.next != null }?.let { lines += "Next ${it.icon} ${it.label} ${time.format(Date(it.next!!))}".take(28) to 0xFFB0B0C0.toInt() }
    }
    val col = LayoutElementBuilders.Column.Builder()
    col.addContent(text("📓 Journal", 0xFFA78BFA.toInt(), 13f))
    for ((t, c) in lines) col.addContent(text(t, c, 15f))
    val root = LayoutElementBuilders.Box.Builder()
      .setWidth(expand()).setHeight(expand())
      .setModifiers(
        ModifiersBuilders.Modifiers.Builder().setClickable(
          ModifiersBuilders.Clickable.Builder().setId("open").setOnClick(
            ActionBuilders.LaunchAction.Builder().setAndroidActivity(
              ActionBuilders.AndroidActivity.Builder().setPackageName(packageName).setClassName(MainActivity::class.java.name).build(),
            ).build(),
          ).build(),
        ).build(),
      )
      .addContent(col.build())
      .build()
    return Futures.immediateFuture(
      TileBuilders.Tile.Builder()
        .setResourcesVersion("1")
        .setFreshnessIntervalMillis(15 * 60_000)
        .setTileTimeline(TimelineBuilders.Timeline.fromLayoutElement(root))
        .build(),
    )
  }

  private fun text(t: String, color: Int, size: Float) = LayoutElementBuilders.Text.Builder()
    .setText(t)
    .setMaxLines(1)
    .setFontStyle(LayoutElementBuilders.FontStyle.Builder().setSize(sp(size)).setColor(argb(color)).build())
    .setModifiers(ModifiersBuilders.Modifiers.Builder().setPadding(ModifiersBuilders.Padding.Builder().setTop(dp(2f)).build()).build())
    .build()

  override fun onTileResourcesRequest(requestParams: RequestBuilders.ResourcesRequest): ListenableFuture<ResourceBuilders.Resources> =
    Futures.immediateFuture(ResourceBuilders.Resources.Builder().setVersion("1").build())
}
