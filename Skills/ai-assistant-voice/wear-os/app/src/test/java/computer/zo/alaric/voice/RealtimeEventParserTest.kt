package computer.zo.alaric.voice

import computer.zo.alaric.voice.realtime.RealtimeEvent
import computer.zo.alaric.voice.realtime.parseRealtimeEvent
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RealtimeEventParserTest {

    private fun parse(json: String): RealtimeEvent = parseRealtimeEvent(JSONObject(json))

    @Test
    fun audioDeltaGaAndLegacy() {
        val ga = parse("""{"type":"response.output_audio.delta","delta":"QUJD"}""")
        assertEquals(RealtimeEvent.AudioDelta("QUJD"), ga)
        val legacy = parse("""{"type":"response.audio.delta","delta":"QUJD"}""")
        assertEquals(RealtimeEvent.AudioDelta("QUJD"), legacy)
    }

    @Test
    fun speechBoundaries() {
        assertEquals(RealtimeEvent.SpeechStarted, parse("""{"type":"input_audio_buffer.speech_started"}"""))
        assertEquals(RealtimeEvent.SpeechStopped, parse("""{"type":"input_audio_buffer.speech_stopped"}"""))
    }

    @Test
    fun responseLifecycle() {
        assertEquals(RealtimeEvent.ResponseStarted, parse("""{"type":"response.created"}"""))
        assertEquals(RealtimeEvent.ResponseDone, parse("""{"type":"response.done"}"""))
    }

    @Test
    fun transcripts() {
        assertEquals(
            RealtimeEvent.AssistantTranscript("hel", false),
            parse("""{"type":"response.output_audio_transcript.delta","delta":"hel"}"""),
        )
        assertEquals(
            RealtimeEvent.AssistantTranscript("hello", true),
            parse("""{"type":"response.output_audio_transcript.done","transcript":"hello"}"""),
        )
        assertEquals(
            RealtimeEvent.UserTranscript("hi", true),
            parse("""{"type":"conversation.item.input_audio_transcription.completed","transcript":"hi"}"""),
        )
    }

    @Test
    fun approvalRequestFromItemAdded() {
        val event = parse(
            """
            {"type":"conversation.item.added",
             "item":{"type":"mcp_approval_request","id":"mcpr_1","name":"send_email",
                     "arguments":"{\"to\":\"x\"}"}}
            """.trimIndent(),
        )
        assertTrue(event is RealtimeEvent.ApprovalRequest)
        event as RealtimeEvent.ApprovalRequest
        assertEquals("mcpr_1", event.approvalRequestId)
        assertEquals("send_email", event.toolName)
    }

    @Test
    fun approvalRequestNotDuplicatedFromOutputItemAdded() {
        val event = parse(
            """
            {"type":"response.output_item.added",
             "item":{"type":"mcp_approval_request","id":"mcpr_1","name":"send_email","arguments":"{}"}}
            """.trimIndent(),
        )
        assertEquals(RealtimeEvent.Ignored, event)
    }

    @Test
    fun toolActivityFromMcpCall() {
        val event = parse(
            """
            {"type":"response.output_item.added",
             "item":{"type":"mcp_call","id":"mc_1","name":"factory_status"}}
            """.trimIndent(),
        )
        assertEquals(RealtimeEvent.ToolActivity("factory_status"), event)
    }

    @Test
    fun errorAndUnknown() {
        val error = parse("""{"type":"error","error":{"message":"boom"}}""")
        assertEquals(RealtimeEvent.Error("boom"), error)
        assertEquals(RealtimeEvent.Ignored, parse("""{"type":"rate_limits.updated"}"""))
    }
}
