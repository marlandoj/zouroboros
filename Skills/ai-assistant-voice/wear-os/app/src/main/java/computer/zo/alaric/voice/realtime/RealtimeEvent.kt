package computer.zo.alaric.voice.realtime

import org.json.JSONObject

sealed interface RealtimeEvent {
    data class SessionCreated(val sessionId: String) : RealtimeEvent
    data class AudioDelta(val pcmBase64: String) : RealtimeEvent
    object SpeechStarted : RealtimeEvent
    object SpeechStopped : RealtimeEvent
    object ResponseStarted : RealtimeEvent
    object ResponseDone : RealtimeEvent
    data class AssistantTranscript(val text: String, val done: Boolean) : RealtimeEvent
    data class UserTranscript(val text: String, val done: Boolean) : RealtimeEvent
    data class ToolActivity(val label: String) : RealtimeEvent
    data class ApprovalRequest(
        val approvalRequestId: String,
        val toolName: String,
        val argumentsJson: String,
    ) : RealtimeEvent
    data class Error(val message: String) : RealtimeEvent
    object Ignored : RealtimeEvent
}

fun parseRealtimeEvent(event: JSONObject): RealtimeEvent {
    return when (val type = event.optString("type")) {
        "session.created" ->
            RealtimeEvent.SessionCreated(event.optJSONObject("session")?.optString("id") ?: "")
        "response.output_audio.delta", "response.audio.delta" ->
            RealtimeEvent.AudioDelta(event.optString("delta"))
        "input_audio_buffer.speech_started" -> RealtimeEvent.SpeechStarted
        "input_audio_buffer.speech_stopped" -> RealtimeEvent.SpeechStopped
        "response.created" -> RealtimeEvent.ResponseStarted
        "response.done" -> RealtimeEvent.ResponseDone
        "response.output_audio_transcript.delta", "response.audio_transcript.delta" ->
            RealtimeEvent.AssistantTranscript(event.optString("delta"), done = false)
        "response.output_audio_transcript.done", "response.audio_transcript.done" ->
            RealtimeEvent.AssistantTranscript(event.optString("transcript"), done = true)
        "conversation.item.input_audio_transcription.delta" ->
            RealtimeEvent.UserTranscript(event.optString("delta"), done = false)
        "conversation.item.input_audio_transcription.completed" ->
            RealtimeEvent.UserTranscript(event.optString("transcript"), done = true)
        "conversation.item.added", "conversation.item.created", "response.output_item.added",
        "response.output_item.done" -> parseItemEvent(event, type)
        "error" ->
            RealtimeEvent.Error(event.optJSONObject("error")?.optString("message") ?: "unknown error")
        else -> RealtimeEvent.Ignored
    }
}

private fun parseItemEvent(event: JSONObject, type: String): RealtimeEvent {
    val item = event.optJSONObject("item") ?: return RealtimeEvent.Ignored
    return when (item.optString("type")) {
        "mcp_approval_request" -> {
            if (type == "response.output_item.added") return RealtimeEvent.Ignored
            RealtimeEvent.ApprovalRequest(
                approvalRequestId = item.optString("id"),
                toolName = item.optString("name"),
                argumentsJson = item.optString("arguments"),
            )
        }
        "mcp_call" ->
            if (type == "response.output_item.added") {
                RealtimeEvent.ToolActivity(item.optString("name"))
            } else {
                RealtimeEvent.Ignored
            }
        else -> RealtimeEvent.Ignored
    }
}
