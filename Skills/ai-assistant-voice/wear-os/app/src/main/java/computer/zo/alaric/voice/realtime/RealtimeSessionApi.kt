package computer.zo.alaric.voice.realtime

import java.io.IOException
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

data class MintedSession(
    val clientSecret: String,
    val model: String,
    val personaName: String,
    val toolsAvailable: Int,
)

class RealtimeSessionApi(private val client: OkHttpClient) {
    fun mint(baseUrl: String, authToken: String, pack: String = "essentials"): MintedSession {
        val body = JSONObject().put("pack", pack).toString()
            .toRequestBody("application/json".toMediaType())
        val request = Request.Builder()
            .url("${baseUrl.removeSuffix("/")}/api/realtime-session")
            .header("x-alaric-auth", authToken)
            .header("accept", "application/json")
            .post(body)
            .build()
        client.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                throw IOException("session mint failed: HTTP ${response.code} ${text.take(200)}")
            }
            val json = JSONObject(text)
            val secret = json.optString("value")
            if (secret.isBlank()) throw IOException("session mint returned no client secret")
            return MintedSession(
                clientSecret = secret,
                model = json.optJSONObject("session")?.optString("model")
                    ?.takeIf { it.isNotBlank() } ?: DEFAULT_MODEL,
                personaName = json.optJSONObject("persona")?.optString("name") ?: "Alaric",
                toolsAvailable = json.optInt("tools_available", 0),
            )
        }
    }

    companion object {
        const val DEFAULT_MODEL = "gpt-realtime-2.1"
    }
}
