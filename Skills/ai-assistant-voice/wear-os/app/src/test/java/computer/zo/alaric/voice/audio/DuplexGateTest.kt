package computer.zo.alaric.voice.audio

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DuplexGateTest {
    @Test
    fun responseSuppressesMicrophoneBeforeAudioArrives() {
        val gate = DuplexGate()

        gate.setResponseActive(true)
        assertFalse(gate.shouldUploadInput(manuallyMuted = false))

        gate.setResponseActive(false)
        assertTrue(gate.shouldUploadInput(manuallyMuted = false))
    }

    @Test
    fun playbackSuppressesMicrophoneUntilAudioAndTailDrain() {
        var now = 1_000_000_000L
        val gate = DuplexGate(nowNanos = { now }, playbackTailNanos = 250_000_000L)

        assertTrue(gate.markPlaybackQueued(byteCount = 48_000))
        assertFalse(gate.shouldUploadInput(manuallyMuted = false))
        assertFalse(gate.completePlaybackIfIdle(queueIsEmpty = true))

        now += 1_249_000_000L
        assertFalse(gate.completePlaybackIfIdle(queueIsEmpty = true))

        now += 1_000_000L
        assertTrue(gate.completePlaybackIfIdle(queueIsEmpty = true))
        assertTrue(gate.shouldUploadInput(manuallyMuted = false))
    }

    @Test
    fun queuedChunksExtendPlaybackDeadline() {
        var now = 2_000_000_000L
        val gate = DuplexGate(nowNanos = { now }, playbackTailNanos = 0L)

        assertTrue(gate.markPlaybackQueued(byteCount = 24_000))
        assertFalse(gate.markPlaybackQueued(byteCount = 24_000))
        now += 999_000_000L
        assertFalse(gate.completePlaybackIfIdle(queueIsEmpty = true))
        now += 1_000_000L
        assertTrue(gate.completePlaybackIfIdle(queueIsEmpty = true))
    }

    @Test
    fun flushReleasesPlaybackGateImmediately() {
        val gate = DuplexGate()

        gate.markPlaybackQueued(byteCount = 48_000)
        assertTrue(gate.flushPlayback())
        assertTrue(gate.shouldUploadInput(manuallyMuted = false))
    }
}
