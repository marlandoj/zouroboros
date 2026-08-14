package computer.zo.alaric.voice.auth

import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

object SessionAuth {
    const val DEFAULT_TTL_MS: Long = 5 * 60 * 1000

    fun mintToken(
        secret: String,
        nowMs: Long,
        ttlMs: Long = DEFAULT_TTL_MS,
        nonceHex: String = randomNonceHex(),
    ): String {
        val exp = nowMs + ttlMs
        val payload = "v1.$exp.$nonceHex"
        return "$payload.${hmacSha256Hex(secret, payload)}"
    }

    fun verify(token: String, secret: String, nowMs: Long): Boolean {
        val parts = token.split(".")
        if (parts.size != 4 || parts[0] != "v1") return false
        val exp = parts[1].toLongOrNull() ?: return false
        if (nowMs > exp) return false
        val expected = hmacSha256Hex(secret, "${parts[0]}.${parts[1]}.${parts[2]}")
        if (expected.length != parts[3].length) return false
        var diff = 0
        for (i in expected.indices) diff = diff or (expected[i].code xor parts[3][i].code)
        return diff == 0
    }

    fun hmacSha256Hex(secret: String, payload: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(secret.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        return mac.doFinal(payload.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
    }

    fun randomNonceHex(): String {
        val bytes = ByteArray(8)
        SecureRandom().nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }
}
