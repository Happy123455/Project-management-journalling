package com.hapi.dynamicjournal.watch

import android.Manifest
import android.app.RemoteInput
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.rotary.onRotaryScrollEvent
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.foundation.lazy.itemsIndexed
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Button
import androidx.wear.compose.material.ButtonDefaults
import androidx.wear.compose.material.Checkbox
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.CompactChip
import androidx.wear.compose.material.ListHeader
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeText
import androidx.wear.compose.material.ToggleChip
import androidx.wear.compose.navigation.SwipeDismissableNavHost
import androidx.wear.compose.navigation.composable
import androidx.wear.compose.navigation.rememberSwipeDismissableNavController
import androidx.wear.input.RemoteInputIntentHelper
import com.google.android.gms.wearable.DataClient
import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.pow
import kotlin.math.roundToLong

private val Purple = Color(0xFFA78BFA)
private val time = SimpleDateFormat("HH:mm", Locale.getDefault())

/** What's waiting to go to the phone once a place for it is picked: a recording or typed words. */
private data class Pending(val audio: File? = null, val text: String? = null)

class MainActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContent { MaterialTheme { App() } }
  }
}

@Composable
private fun App() {
  val ctx = LocalContext.current
  val scope = rememberCoroutineScope()
  var state by remember { mutableStateOf(Link.saved(ctx)) }
  var pending by remember { mutableStateOf<Pending?>(null) }
  val nav = rememberSwipeDismissableNavController()
  LaunchedEffect(Unit) { Link.fetch(ctx)?.let { state = it } }
  DisposableEffect(Unit) {
    val listener = DataClient.OnDataChangedListener { events ->
      for (e in events) {
        if (e.type != DataEvent.TYPE_CHANGED || e.dataItem.uri.path != "/journal/state") continue
        val json = DataMapItem.fromDataItem(e.dataItem).dataMap.getString("json") ?: continue
        Link.save(ctx, json)
        Link.parse(json)?.let { state = it }
      }
    }
    Wearable.getDataClient(ctx).addListener(listener)
    onDispose { Wearable.getDataClient(ctx).removeListener(listener) }
  }
  val send: (JSONObject, File?, String) -> Unit = { json, audio, said ->
    Link.tick(ctx, strong = true)
    scope.launch {
      try {
        Link.send(ctx, json, audio)
        Toast.makeText(ctx, said, Toast.LENGTH_SHORT).show()
        audio?.delete()
      } catch (e: Exception) {
        Toast.makeText(ctx, "Couldn't send: ${e.message}", Toast.LENGTH_LONG).show()
      }
    }
  }
  val noteInput = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
    val text = r.data?.let { RemoteInput.getResultsFromIntent(it)?.getCharSequence("note")?.toString() }
    if (!text.isNullOrBlank()) {
      pending = Pending(text = text)
      nav.navigate("target")
    }
  }

  SwipeDismissableNavHost(navController = nav, startDestination = "home") {
    composable("home") {
      Home(
        state = state,
        onVoice = { nav.navigate("record") },
        onNote = {
          val intent = RemoteInputIntentHelper.createActionRemoteInputIntent()
          RemoteInputIntentHelper.putRemoteInputsExtra(intent, listOf(RemoteInput.Builder("note").setLabel("Note for the journal").build()))
          noteInput.launch(intent)
        },
        onFormula = { nav.navigate("formula/$it") },
        send = { json, said -> send(json, null, said) },
        update = { state = it },
      )
    }
    composable("record") {
      Recorder(onDone = { file ->
        pending = Pending(audio = file)
        nav.popBackStack()
        nav.navigate("target")
      })
    }
    composable("target") {
      Target(projects = state?.projects ?: emptyList()) { project ->
        val p = pending ?: return@Target
        val target = if (project == null) JSONObject().put("kind", "today") else JSONObject().put("kind", "project").put("title", project)
        val json = if (p.audio != null)
          JSONObject().put("t", "voice").put("name", p.audio.name).put("mime", "audio/aac").put("transcribe", true).put("target", target)
        else JSONObject().put("t", "note").put("text", p.text).put("target", target)
        send(json, p.audio, if (project == null) "Sent to today" else "Sent to $project")
        pending = null
        nav.popBackStack("home", inclusive = false)
      }
    }
    composable("formula/{i}") { entry ->
      val i = entry.arguments?.getString("i")?.toIntOrNull() ?: 0
      state?.formulas?.getOrNull(i)?.let { FormulaScreen(it) }
    }
  }
}

@Composable
private fun Home(state: State?, onVoice: () -> Unit, onNote: () -> Unit, onFormula: (Int) -> Unit, send: (JSONObject, String) -> Unit, update: (State) -> Unit) {
  val list = rememberScalingLazyListState()
  Scaffold(timeText = { TimeText() }) {
    ScalingLazyColumn(state = list, modifier = Modifier.fillMaxSize()) {
      item { ListHeader { Text("📓 Journal", color = Purple) } }
      item {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          Button(onClick = onVoice, colors = ButtonDefaults.buttonColors(backgroundColor = Color(0xFFE5484D))) { Text("🎙", fontSize = 22.sp) }
          Button(onClick = onNote, colors = ButtonDefaults.secondaryButtonColors()) { Text("✎", fontSize = 22.sp) }
        }
      }
      if (state == null) {
        item { Text("Open Journal on your phone once to link it.", textAlign = TextAlign.Center, modifier = Modifier.padding(12.dp)) }
        return@ScalingLazyColumn
      }
      if (state.steps.isNotEmpty()) {
        item { ListHeader { Text("Routine") } }
        items(state.steps) { s ->
          Chip(
            modifier = Modifier.fillMaxWidth(),
            onClick = {
              send(JSONObject().put("t", "step").put("id", s.id), when { !s.span -> "${s.icon} ${s.label} ✓"; s.running -> "${s.icon} ${s.label} done"; else -> "${s.icon} ${s.label} started" })
              update(state.copy(steps = state.steps.map { if (it.id != s.id) it else if (s.span && !s.running) it.copy(running = true) else it.copy(running = false, done = true) }))
            },
            label = { Text("${s.icon} ${s.label}", maxLines = 1, overflow = TextOverflow.Ellipsis) },
            secondaryLabel = { Text(if (s.running) "Now · tap when done" else if (s.done) "Done ✓" else s.next?.let { "Usually ${time.format(Date(it))}" } ?: "Tap to log") },
            colors = if (s.running) ChipDefaults.primaryChipColors(backgroundColor = Color(0xFF5B3FD0)) else ChipDefaults.secondaryChipColors(),
          )
        }
      }
      if (state.habits.isNotEmpty()) {
        item { ListHeader { Text("Habits") } }
        items(state.habits) { h ->
          Chip(
            modifier = Modifier.fillMaxWidth(),
            onClick = {
              send(JSONObject().put("t", "habit").put("id", h.id), "${h.icon} ${h.label} +1")
              update(state.copy(habits = state.habits.map { if (it.id == h.id) it.copy(today = it.today + 1) else it }))
            },
            label = { Text("${h.icon} ${h.label}", maxLines = 1) },
            secondaryLabel = { Text("Today ×${h.today}") },
            colors = ChipDefaults.secondaryChipColors(),
          )
        }
      }
      if (state.agenda.isNotEmpty()) {
        item { ListHeader { Text("Today") } }
        items(state.agenda) { a ->
          ToggleChip(
            modifier = Modifier.fillMaxWidth(),
            checked = a.done,
            onCheckedChange = { on ->
              send(JSONObject().put("t", "agenda").put("id", a.id).put("done", on), if (on) "✓ ${a.text}" else "Not done")
              update(state.copy(agenda = state.agenda.map { if (it.id == a.id) it.copy(done = on) else it }))
            },
            label = { Text(a.text, maxLines = 2, overflow = TextOverflow.Ellipsis) },
            secondaryLabel = { Text("⏰ ${time.format(Date(a.at))}") },
            toggleControl = { Checkbox(checked = a.done) },
          )
        }
      }
      if (state.tasks.isNotEmpty()) {
        item { ListHeader { Text("Tasks ${state.tasks.count { it.done }}/${state.tasks.size}") } }
        items(state.tasks) { t ->
          ToggleChip(
            modifier = Modifier.fillMaxWidth(),
            checked = t.done,
            onCheckedChange = { on ->
              send(JSONObject().put("t", "task").put("day", t.day).put("path", t.path).put("text", t.text).put("done", on), if (on) "☑ ${t.text}" else "☐ ${t.text}")
              update(state.copy(tasks = state.tasks.map { if (it === t) it.copy(done = on) else it }))
            },
            label = { Text(t.text, maxLines = 2, overflow = TextOverflow.Ellipsis) },
            toggleControl = { Checkbox(checked = t.done) },
          )
        }
      }
      if (state.formulas.isNotEmpty()) {
        item { ListHeader { Text("⭐ Formulas") } }
        itemsIndexed(state.formulas) { i, f ->
          Chip(
            modifier = Modifier.fillMaxWidth(),
            onClick = { onFormula(i) },
            label = { Text(f.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            secondaryLabel = { Text(f.vars.joinToString("  ") { it.name }) },
            colors = ChipDefaults.secondaryChipColors(),
          )
        }
      } else item { Text("⭐ a math block on the phone to turn its values here with the bezel.", fontSize = 11.sp, textAlign = TextAlign.Center, color = Color.Gray, modifier = Modifier.padding(8.dp)) }
    }
  }
}

/** Tap to start, tap to stop: AAC, mono, small enough to send in a moment. */
@Composable
private fun Recorder(onDone: (File) -> Unit) {
  val ctx = LocalContext.current
  var rec by remember { mutableStateOf<MediaRecorder?>(null) }
  var file by remember { mutableStateOf<File?>(null) }
  var seconds by remember { mutableIntStateOf(0) }
  val start = {
    val f = File(ctx.cacheDir, "watch-${System.currentTimeMillis()}.aac")
    val r = (if (Build.VERSION.SDK_INT >= 31) MediaRecorder(ctx) else MediaRecorder()).apply {
      setAudioSource(MediaRecorder.AudioSource.MIC)
      setOutputFormat(MediaRecorder.OutputFormat.AAC_ADTS)
      setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
      setAudioChannels(1)
      setAudioSamplingRate(16000)
      setAudioEncodingBitRate(32000)
      setOutputFile(f.absolutePath)
      prepare()
      start()
    }
    Link.tick(ctx, strong = true)
    file = f
    seconds = 0
    rec = r
  }
  val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok -> if (ok) start() }
  LaunchedEffect(rec) { while (rec != null) { delay(1000); seconds++ } }
  DisposableEffect(Unit) { onDispose { try { rec?.stop() } catch (e: Exception) { }; rec?.release() } }
  Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
      Text(if (rec != null) "%d:%02d".format(seconds / 60, seconds % 60) else "Voice note", fontSize = 18.sp)
      Spacer(Modifier.height(10.dp))
      Button(
        modifier = Modifier.size(76.dp),
        colors = ButtonDefaults.buttonColors(backgroundColor = if (rec != null) Color(0xFF7F1D1D) else Color(0xFFE5484D)),
        onClick = {
          val r = rec
          if (r == null) {
            if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) start() else ask.launch(Manifest.permission.RECORD_AUDIO)
          } else {
            try { r.stop() } catch (e: Exception) { }
            r.release()
            rec = null
            Link.tick(ctx, strong = true)
            file?.let(onDone)
          }
        },
      ) { Text(if (rec != null) "■" else "●", fontSize = 30.sp) }
      Spacer(Modifier.height(8.dp))
      Text(if (rec != null) "Tap to stop" else "Tap to record", fontSize = 12.sp, color = Color.Gray)
    }
  }
}

/** Where it goes: today's note, or a project's box. The bezel scrolls the list. */
@Composable
private fun Target(projects: List<String>, onPick: (String?) -> Unit) {
  val list = rememberScalingLazyListState()
  Scaffold(timeText = { TimeText() }) {
    ScalingLazyColumn(state = list, modifier = Modifier.fillMaxSize()) {
      item { ListHeader { Text("Add to…") } }
      item { Chip(modifier = Modifier.fillMaxWidth(), onClick = { onPick(null) }, label = { Text("📅 Today") }, colors = ChipDefaults.primaryChipColors(backgroundColor = Color(0xFF5B3FD0))) }
      items(projects) { p -> Chip(modifier = Modifier.fillMaxWidth(), onClick = { onPick(p) }, label = { Text("📌 $p", maxLines = 1, overflow = TextOverflow.Ellipsis) }, colors = ChipDefaults.secondaryChipColors()) }
    }
  }
}

private fun decimals(step: Double): Int = if (step >= 1) 0 else max(0, -floor(log10(step)).toInt())
private fun fmt(v: Double, step: Double = 0.0001): String {
  val d = decimals(step).coerceAtMost(6)
  val r = (v * 10.0.pow(d)).roundToLong() / 10.0.pow(d)
  return if (r == floor(r) && abs(r) < 1e15) r.toLong().toString() else "%.${d.coerceAtLeast(1)}f".format(r).trimEnd('0').trimEnd('.')
}

/** A favourite formula: tap a variable, turn the bezel to change it (a tick per step), the answer follows. */
@Composable
private fun FormulaScreen(f: Formula) {
  val ctx = LocalContext.current
  val values = remember(f) { mutableStateListOf(*f.vars.map { it.value }.toTypedArray()) }
  var sel by remember(f) { mutableIntStateOf(0) }
  var lastAt by remember { mutableStateOf(0L) }
  val focus = remember { FocusRequester() }
  LaunchedEffect(Unit) { focus.requestFocus() }
  val vars = f.vars.mapIndexed { i, v -> v.name to values[i] }.toMap()
  val answer = Calc.eval(f.expr, vars)
  Box(
    Modifier
      .fillMaxSize()
      .background(Color.Black)
      .onRotaryScrollEvent { e ->
        val v = f.vars.getOrNull(sel) ?: return@onRotaryScrollEvent false
        if (e.verticalScrollPixels == 0f) return@onRotaryScrollEvent true
        // Each bezel click is one step; spinning it fast moves ten at a time.
        val now = e.uptimeMillis
        val fast = now - lastAt < 45
        lastAt = now
        val dir = if (e.verticalScrollPixels > 0) 1 else -1
        val step = v.step * (if (fast) 10 else 1)
        val next = ((values[sel] + dir * step) / v.step).roundToLong() * v.step
        values[sel] = next
        val strong = ((next / v.step).roundToLong() % 10L) == 0L
        Link.tick(ctx, strong)
        true
      }
      .focusRequester(focus)
      .focusable(),
    contentAlignment = Alignment.Center,
  ) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(horizontal = 18.dp)) {
      Text(f.name, fontSize = 11.sp, color = Color.Gray, maxLines = 1, overflow = TextOverflow.Ellipsis)
      Text(
        (if (f.lhs.isNotEmpty()) "${f.lhs} = " else "= ") + (answer?.let { fmt(it) } ?: "?"),
        fontSize = 24.sp, fontWeight = FontWeight.Bold, color = Purple, maxLines = 1, overflow = TextOverflow.Ellipsis,
      )
      Spacer(Modifier.height(6.dp))
      f.vars.getOrNull(sel)?.let { v ->
        Text("${v.name} = ${fmt(values[sel], v.step)}", fontSize = 20.sp)
        Text(v.label ?: "turn the bezel · step ${fmt(v.step)}", fontSize = 10.sp, color = Color.Gray, maxLines = 1)
      }
      Spacer(Modifier.height(6.dp))
      Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        f.vars.forEachIndexed { i, v ->
          CompactChip(
            onClick = { sel = i; Link.tick(ctx, true); focus.requestFocus() },
            label = { Text(v.name, fontSize = 12.sp) },
            colors = if (i == sel) ChipDefaults.primaryChipColors(backgroundColor = Color(0xFF5B3FD0)) else ChipDefaults.secondaryChipColors(),
          )
        }
      }
      if (f.vars.isEmpty()) Text("No variables to turn", fontSize = 11.sp, color = Color.Gray)
    }
  }
}
