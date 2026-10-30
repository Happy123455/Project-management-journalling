package com.hapi.dynamicjournal

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsKokoroModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import java.io.File
import java.io.FilterInputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.atomic.AtomicInteger
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.compressors.bzip2.BZip2CompressorInputStream
import org.json.JSONObject

/**
 * Kokoro-82M on the phone through sherpa-onnx. The model is downloaded once (never in the APK) into
 * noBackupFilesDir, which Android leaves out of backups and the journal never syncs.
 * Speech is made sentence by sentence: one thread generates, another plays, so it starts quickly.
 */
class KokoroSpeech(private val context: Context, private val emit: (String) -> Unit) {
  companion object {
    /** Model id → approximate download size in MB. */
    val MODELS = linkedMapOf("kokoro-int8-en-v0_19" to 98, "kokoro-int8-multi-lang-v1_1" to 140, "kokoro-en-v0_19" to 305)
    /** Half the phone's cores (4 on the S23): fast enough to keep ahead of the voice, leaves the rest for the app. */
    private val THREADS = (Runtime.getRuntime().availableProcessors() / 2).coerceIn(2, 4)
    private const val URL_BASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/"
  }

  // Lazy: nothing touches storage until read aloud or Settings first asks.
  private val root by lazy { File(context.noBackupFilesDir, "voices") }
  private val prefs by lazy { context.getSharedPreferences("speech", Context.MODE_PRIVATE) }
  @Volatile private var tts: OfflineTts? = null
  @Volatile private var loaded: String? = null
  @Volatile var downloading: String? = null
    private set
  private val run = AtomicInteger()
  @Volatile private var track: AudioTrack? = null

  var model: String
    get() = prefs.getString("model", MODELS.keys.first())!!
    set(value) = prefs.edit().putString("model", value).apply()
  var voice: Int
    get() = prefs.getInt("voice", 0)
    set(value) = prefs.edit().putInt("voice", value).apply()

  fun installed(id: String) = File(root, "$id/.done").exists()

  fun info(): String {
    val models = org.json.JSONArray()
    for ((id, mb) in MODELS) models.put(JSONObject().put("id", id).put("sizeMb", mb).put("installed", installed(id)))
    return JSONObject()
      .put("models", models)
      .put("model", model)
      .put("voice", voice)
      .put("downloading", downloading ?: JSONObject.NULL)
      .put("speakers", tts?.takeIf { loaded == model }?.numSpeakers() ?: 0)
      .toString()
  }

  private fun progress(id: String, state: String, received: Long = 0, total: Long = 0, message: String = "") =
    emit(JSONObject().put("model", id).put("state", state).put("received", received).put("total", total).put("message", message).toString())

  /** Downloads and unpacks a model in the background, reporting progress to the page. */
  fun download(id: String) {
    if (id !in MODELS || downloading != null) return
    downloading = id
    Thread {
      val part = File(root, ".part")
      try {
        part.deleteRecursively()
        part.mkdirs()
        var connection = URL("$URL_BASE$id.tar.bz2").openConnection() as HttpURLConnection
        connection.instanceFollowRedirects = true
        connection.connect()
        if (connection.responseCode !in 200..299) throw IllegalStateException("Download failed (${connection.responseCode})")
        val total = connection.contentLengthLong
        var received = 0L
        var lastSent = 0L
        val counting = object : FilterInputStream(connection.inputStream) {
          private fun count(n: Int): Int {
            if (n > 0) received += n
            if (received - lastSent > 1_000_000) {
              lastSent = received
              progress(id, "downloading", received, total)
            }
            return n
          }
          override fun read(): Int = super.read().also { if (it >= 0) count(1) }
          override fun read(b: ByteArray, off: Int, len: Int): Int = count(super.read(b, off, len))
        }
        TarArchiveInputStream(BZip2CompressorInputStream(counting.buffered(1 shl 16))).use { tar ->
          val base = part.canonicalPath + File.separator
          while (true) {
            val entry = tar.nextEntry ?: break
            val out = File(part, entry.name)
            if (!out.canonicalPath.startsWith(base)) continue
            if (entry.isDirectory) out.mkdirs() else {
              out.parentFile?.mkdirs()
              out.outputStream().use { tar.copyTo(it) }
            }
          }
        }
        connection.disconnect()
        val unpacked = File(part, id)
        if (!File(unpacked, "tokens.txt").exists()) throw IllegalStateException("The download didn't contain the voice files")
        File(unpacked, ".done").writeText("ok")
        val target = File(root, id)
        target.deleteRecursively()
        if (!unpacked.renameTo(target)) throw IllegalStateException("Couldn't save the voice")
        part.deleteRecursively()
        downloading = null
        progress(id, "done", received, total)
      } catch (e: Exception) {
        part.deleteRecursively()
        downloading = null
        progress(id, "error", message = e.message ?: e.toString())
      }
    }.start()
  }

  fun remove(id: String) {
    if (loaded == id) {
      tts?.release()
      tts = null
      loaded = null
    }
    File(root, id).deleteRecursively()
  }

  /** The engine for the chosen model, loading it the first time (null if it isn't downloaded or won't load). */
  private fun engine(): OfflineTts? {
    val id = model
    if (loaded == id) return tts
    if (!installed(id)) return null
    return try {
      tts?.release()
      val dir = File(root, id)
      val lexicons = listOf("lexicon-us-en.txt", "lexicon-zh.txt").map { File(dir, it) }.filter { it.exists() }
      val kokoro = OfflineTtsKokoroModelConfig(
        model = File(dir, "model.int8.onnx").takeIf { it.exists() }?.path ?: File(dir, "model.onnx").path,
        voices = File(dir, "voices.bin").path,
        tokens = File(dir, "tokens.txt").path,
        dataDir = File(dir, "espeak-ng-data").path,
        lexicon = lexicons.joinToString(",") { it.path },
      )
      val config = OfflineTtsConfig(model = OfflineTtsModelConfig(kokoro = kokoro, numThreads = THREADS, provider = "cpu"))
      OfflineTts(config = config).also {
        tts = it
        loaded = id
      }
    } catch (e: Throwable) {
      tts = null
      loaded = null
      null
    }
  }

  /** True when Kokoro is ready for the chosen model; false means use the system voice instead. */
  fun available() = installed(model) && downloading != model

  /**
   * Speaks `text` (the page's run `id`), reporting "range" at each sentence and "done" at the end
   * through `event`. Returns false if Kokoro couldn't start, so the caller can fall back.
   */
  fun speak(text: String, rate: Float, id: String, event: (String, String, Int) -> Unit): Boolean {
    stop()
    val mine = run.incrementAndGet()
    val sentences = pieces(text)
    // Room for several sentences, so the voice can run ahead of the speaker and never stall mid-text.
    val queue = LinkedBlockingQueue<Pair<Int, FloatArray>>(8)
    val end = Pair(-1, FloatArray(0))
    // Neither thread may wait forever once this run is stopped.
    fun put(item: Pair<Int, FloatArray>) {
      while (!queue.offer(item, 200, java.util.concurrent.TimeUnit.MILLISECONDS)) if (run.get() != mine) return
    }
    fun next(): Pair<Int, FloatArray> {
      while (true) {
        queue.poll(200, java.util.concurrent.TimeUnit.MILLISECONDS)?.let { return it }
        if (run.get() != mine) return end
      }
    }
    Thread {
      val engine = engine()
      if (engine == null) {
        put(Pair(-2, FloatArray(0)))
        return@Thread
      }
      for (s in sentences) {
        if (run.get() != mine) break
        val audio = engine.generate(s.second.trim(), voice.coerceIn(0, engine.numSpeakers() - 1), rate)
        if (run.get() != mine) break
        put(Pair(s.first, smooth(audio.samples, audio.sampleRate)))
      }
      put(end)
    }.start()
    Thread {
      val first = next()
      if (first.first == -2) {
        // Model missing or failed to load: say so, the page falls back to the system voice.
        if (run.get() == mine) event("error", id, 0)
        return@Thread
      }
      val rateHz = tts?.sampleRate() ?: 24000
      val out = AudioTrack.Builder()
        .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
        .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_FLOAT).setSampleRate(rateHz).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
        .setTransferMode(AudioTrack.MODE_STREAM)
        .setBufferSizeInBytes(AudioTrack.getMinBufferSize(rateHz, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_FLOAT) * 4)
        .build()
      track = out
      out.play()
      var item = first
      while (item !== end && run.get() == mine) {
        event("range", id, item.first)
        out.write(item.second, 0, item.second.size, AudioTrack.WRITE_BLOCKING)
        item = next()
      }
      if (run.get() == mine) {
        // Let the last of the buffer play out.
        out.stop()
        event("done", id, 0)
      }
      out.release()
      if (track === out) track = null
    }.start()
    return true
  }

  /**
   * Sentences, with long ones cut at commas and semicolons: the first sound comes sooner, and no
   * piece is so long that the next one isn't ready when it ends (that gap was the choppiness).
   */
  private fun pieces(text: String): List<Pair<Int, String>> {
    val out = mutableListOf<Pair<Int, String>>()
    for (s in Regex("[^.!?\\n]+[.!?]*[\"')\\]]*\\s*|\\n+").findAll(text)) {
      if (s.value.isBlank()) continue
      if (s.value.length <= 160) out.add(Pair(s.range.first, s.value))
      else Regex("[^,;:]+[,;:]?\\s*").findAll(s.value).forEach { part ->
        if (part.value.isNotBlank()) out.add(Pair(s.range.first + part.range.first, part.value))
      }
    }
    return out
  }

  /** A few milliseconds' fade at both ends of each piece: no click where two pieces meet. */
  private fun smooth(samples: FloatArray, rate: Int): FloatArray {
    val n = minOf(samples.size / 2, rate / 200)
    for (i in 0 until n) {
      val g = i.toFloat() / n
      samples[i] *= g
      samples[samples.size - 1 - i] *= g
    }
    return samples
  }

  fun stop() {
    run.incrementAndGet()
    track?.let {
      try {
        it.pause()
        it.flush()
      } catch (_: IllegalStateException) {
      }
    }
  }

  fun shutdown() {
    stop()
    tts?.release()
    tts = null
    loaded = null
  }
}
