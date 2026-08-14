package computer.zo.alaric.voice.realtime

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

interface RealtimeClientListener {
    fun onEvent(event: RealtimeEvent)
    fun onClosed(reason: String)
    fun onFailure(message: String)
}

class RealtimeClient(
    private val client: OkHttpClient,
    private val listener: RealtimeClientListener,
) {
    @Volatile private var socket: WebSocket? = null
    @Volatile private var closedByUs = false

    fun connect(clientSecret: String, model: String) {
        closedByUs = false
        val request = Request.Builder()
            .url("wss://api.openai.com/v1/realtime?model=$model")
            .header("Authorization", "Bearer $clientSecret")
            .build()
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                val event = runCatching { parseRealtimeEvent(JSONObject(text)) }
                    .getOrElse { RealtimeEvent.Ignored }
                if (event != RealtimeEvent.Ignored) listener.onEvent(event)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (!closedByUs) listener.onClosed(reason.ifBlank { "code $code" })
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (!closedByUs) {
                    listener.onFailure(t.message ?: response?.message ?: "connection failed")
                }
            }
        })
    }

    fun sendAudio(pcmBase64: String) {
        val event = JSONObject()
            .put("type", "input_audio_buffer.append")
            .put("audio", pcmBase64)
        socket?.send(event.toString())
    }

    fun sendApproval(approvalRequestId: String, approve: Boolean) {
        val event = JSONObject()
            .put("type", "conversation.item.create")
            .put(
                "item",
                JSONObject()
                    .put("type", "mcp_approval_response")
                    .put("approval_request_id", approvalRequestId)
                    .put("approve", approve),
            )
        socket?.send(event.toString())
    }

    fun close() {
        closedByUs = true
        socket?.close(1000, "client closed")
        socket = null
    }
}
