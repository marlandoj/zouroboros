package computer.zo.alaric.voice.audio

import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.max

internal class DuplexGate(
    private val nowNanos: () -> Long = System::nanoTime,
    private val playbackTailNanos: Long = DEFAULT_PLAYBACK_TAIL_NANOS,
) {
    private val responseActive = AtomicBoolean(false)
    private val playbackActive = AtomicBoolean(false)
    private val playbackDeadlineNanos = AtomicLong(0L)

    fun setResponseActive(active: Boolean) {
        responseActive.set(active)
    }

    fun markPlaybackQueued(byteCount: Int): Boolean {
        if (byteCount <= 0) return false
        val durationNanos = byteCount.toLong() * NANOS_PER_SECOND / PCM_BYTES_PER_SECOND
        val now = nowNanos()
        playbackDeadlineNanos.updateAndGet { current -> max(current, now) + durationNanos }
        return playbackActive.compareAndSet(false, true)
    }

    fun completePlaybackIfIdle(queueIsEmpty: Boolean): Boolean {
        if (!queueIsEmpty || !playbackActive.get()) return false
        val drained = nowNanos() >= playbackDeadlineNanos.get() + playbackTailNanos
        return drained && playbackActive.compareAndSet(true, false)
    }

    fun flushPlayback(): Boolean {
        playbackDeadlineNanos.set(nowNanos())
        return playbackActive.compareAndSet(true, false)
    }

    fun shouldUploadInput(manuallyMuted: Boolean): Boolean =
        !manuallyMuted && !responseActive.get() && !playbackActive.get()

    fun isResponseActive(): Boolean = responseActive.get()

    fun isPlaybackActive(): Boolean = playbackActive.get()

    companion object {
        private const val NANOS_PER_SECOND = 1_000_000_000L
        private const val PCM_BYTES_PER_SECOND = 24_000L * 2L
        private const val DEFAULT_PLAYBACK_TAIL_NANOS = 250_000_000L
    }
}
