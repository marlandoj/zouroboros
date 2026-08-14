package computer.zo.alaric.voice

import computer.zo.alaric.voice.audio.AudioLevels
import kotlin.math.abs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioLevelsTest {

    @Test
    fun silenceIsZero() {
        assertEquals(0f, AudioLevels.rmsLevel(ByteArray(1920)), 0.0001f)
    }

    @Test
    fun fullScaleNearOne() {
        val pcm = ByteArray(1920)
        var i = 0
        while (i + 1 < pcm.size) {
            pcm[i] = 0xFF.toByte()
            pcm[i + 1] = 0x7F.toByte()
            i += 2
        }
        assertTrue(abs(AudioLevels.rmsLevel(pcm) - 1f) < 0.01f)
    }

    @Test
    fun emptyAndOddInputsSafe() {
        assertEquals(0f, AudioLevels.rmsLevel(ByteArray(0)), 0.0f)
        assertEquals(0f, AudioLevels.rmsLevel(ByteArray(1)), 0.0f)
    }

    @Test
    fun halfScaleIsRoughlyHalf() {
        val pcm = ByteArray(1920)
        var i = 0
        while (i + 1 < pcm.size) {
            pcm[i] = 0x00
            pcm[i + 1] = 0x40
            i += 2
        }
        val level = AudioLevels.rmsLevel(pcm)
        assertTrue(level in 0.45f..0.55f)
    }
}
