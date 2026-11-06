package com.hapi.dynamicjournal

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import java.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject

/**
 * Exercise and sleep sessions from Health Connect (Samsung Health shares into it). Read only.
 * Page side: src/routine/health.ts.
 */
object Health {
  val PERMISSIONS = setOf(
    HealthPermission.getReadPermission(ExerciseSessionRecord::class),
    HealthPermission.getReadPermission(SleepSessionRecord::class),
  )
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

  private fun client(context: Context): HealthConnectClient? =
    if (HealthConnectClient.getSdkStatus(context) == HealthConnectClient.SDK_AVAILABLE) HealthConnectClient.getOrCreate(context) else null

  /** "ready", "ask", "update" or "unavailable". */
  fun status(context: Context): String {
    return when (HealthConnectClient.getSdkStatus(context)) {
      HealthConnectClient.SDK_AVAILABLE -> {
        val granted = try {
          runBlocking { HealthConnectClient.getOrCreate(context).permissionController.getGrantedPermissions() }
        } catch (e: Exception) {
          emptySet()
        }
        if (granted.containsAll(PERMISSIONS)) "ready" else "ask"
      }
      HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> "update"
      else -> "unavailable"
    }
  }

  /** Sessions overlapping from..to (ms), as JSON: [{kind, start, end, title}]; "null" when they can't be read. */
  fun read(context: Context, from: Long, to: Long, answer: (String) -> Unit) {
    val hc = client(context) ?: return answer("null")
    scope.launch {
      val json = try {
        val range = TimeRangeFilter.between(Instant.ofEpochMilli(from), Instant.ofEpochMilli(to))
        val out = JSONArray()
        for (r in hc.readRecords(ReadRecordsRequest(ExerciseSessionRecord::class, timeRangeFilter = range)).records) {
          out.put(JSONObject().put("kind", "exercise").put("start", r.startTime.toEpochMilli()).put("end", r.endTime.toEpochMilli()).put("title", r.title ?: ""))
        }
        for (r in hc.readRecords(ReadRecordsRequest(SleepSessionRecord::class, timeRangeFilter = range)).records) {
          out.put(JSONObject().put("kind", "sleep").put("start", r.startTime.toEpochMilli()).put("end", r.endTime.toEpochMilli()))
        }
        out.toString()
      } catch (e: Exception) {
        "null"
      }
      answer(json)
    }
  }
}
