package computer.zo.alaric.voice

import computer.zo.alaric.voice.auth.SessionAuth
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionAuthTest {
    private val secret = "0123456789abcdef0123456789abcdef"

    @Test
    fun mintedTokenVerifies() {
        val token = SessionAuth.mintToken(secret, nowMs = 1_000_000L, ttlMs = 60_000L, nonceHex = "aabbccdd00112233")
        assertTrue(SessionAuth.verify(token, secret, nowMs = 1_030_000L))
    }

    @Test
    fun tokenHasExpectedShape() {
        val token = SessionAuth.mintToken(secret, nowMs = 1_000_000L, ttlMs = 60_000L, nonceHex = "aabbccdd00112233")
        val parts = token.split(".")
        assertEquals(4, parts.size)
        assertEquals("v1", parts[0])
        assertEquals("1060000", parts[1])
        assertEquals("aabbccdd00112233", parts[2])
        assertEquals(64, parts[3].length)
    }

    @Test
    fun expiredTokenRejected() {
        val token = SessionAuth.mintToken(secret, nowMs = 1_000_000L, ttlMs = 60_000L)
        assertFalse(SessionAuth.verify(token, secret, nowMs = 1_060_001L))
    }

    @Test
    fun tamperedSignatureRejected() {
        val token = SessionAuth.mintToken(secret, nowMs = 1_000_000L, ttlMs = 60_000L)
        val tampered = token.dropLast(1) + if (token.last() == '0') "1" else "0"
        assertFalse(SessionAuth.verify(tampered, secret, nowMs = 1_030_000L))
    }

    @Test
    fun wrongSecretRejected() {
        val token = SessionAuth.mintToken(secret, nowMs = 1_000_000L, ttlMs = 60_000L)
        assertFalse(SessionAuth.verify(token, "another-secret-that-is-32-chars!", nowMs = 1_030_000L))
    }

    @Test
    fun malformedTokensRejected() {
        assertFalse(SessionAuth.verify("", secret, nowMs = 0L))
        assertFalse(SessionAuth.verify("v2.100.aa.bb", secret, nowMs = 0L))
        assertFalse(SessionAuth.verify("v1.notanumber.aa.bb", secret, nowMs = 0L))
        assertFalse(SessionAuth.verify("v1.100.aa", secret, nowMs = 0L))
    }
}
