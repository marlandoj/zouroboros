package computer.zo.alaric.voice.audio

import android.annotation.SuppressLint
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.sqrt

object AudioLevels {
    fun rmsLevel(pcm: ByteArray, length: Int = pcm.size): Float {
        if (length < 2) return 0f
        var sum = 0.0
        var samples = 0
        var i = 0
        while (i + 1 < length) {
            val sample = ((pcm[i + 1].toInt() shl 8) or (pcm[i].toInt() and 0xFF)).toShort().toInt()
            sum += sample.toDouble() * sample.toDouble()
            samples += 1
            i += 2
        }
        if (samples == 0) return 0f
        return (sqrt(sum / samples) / 32768.0).toFloat().coerceIn(0f, 1f)
    }
}

class AudioEngine(
    private val onInputChunk: (ByteArray) -> Unit,
    private val onInputLevel: (Float) -> Unit,
    private val onOutputLevel: (Float) -> Unit,
    private val onPlaybackActiveChanged: (Boolean) -> Unit,
) {
    private val running = AtomicBoolean(false)
    private val muted = AtomicBoolean(false)
    private val playbackQueue = LinkedBlockingQueue<ByteArray>()
    private val duplexGate = DuplexGate()
    private var recordThread: Thread? = null
    private var playThread: Thread? = null
    private var echoCanceler: AcousticEchoCanceler? = null
    private var noiseSuppressor: NoiseSuppressor? = null

    fun setMuted(value: Boolean) {
        muted.set(value)
        if (value) onInputLevel(0f)
    }

    fun isMuted(): Boolean = muted.get()

    fun setResponseActive(value: Boolean) {
        duplexGate.setResponseActive(value)
        if (value) onInputLevel(0f)
    }

    fun isResponseActive(): Boolean = duplexGate.isResponseActive()

    fun isPlaybackActive(): Boolean = duplexGate.isPlaybackActive()

    fun playPcm(pcm: ByteArray) {
        if (duplexGate.markPlaybackQueued(pcm.size)) onPlaybackActiveChanged(true)
        playbackQueue.offer(pcm)
    }

    fun flushPlayback() {
        playbackQueue.clear()
        if (duplexGate.flushPlayback()) onPlaybackActiveChanged(false)
        onOutputLevel(0f)
    }

    @SuppressLint("MissingPermission")
    fun start() {
        if (!running.compareAndSet(false, true)) return

        recordThread = Thread {
            val minBuffer = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_IN, ENCODING)
            val record = AudioRecord(
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                SAMPLE_RATE,
                CHANNEL_IN,
                ENCODING,
                maxOf(minBuffer, CHUNK_BYTES * 4),
            )
            if (AcousticEchoCanceler.isAvailable()) {
                echoCanceler = AcousticEchoCanceler.create(record.audioSessionId)?.apply { enabled = true }
            }
            if (NoiseSuppressor.isAvailable()) {
                noiseSuppressor = NoiseSuppressor.create(record.audioSessionId)?.apply { enabled = true }
            }
            val chunk = ByteArray(CHUNK_BYTES)
            try {
                record.startRecording()
                while (running.get()) {
                    val read = record.read(chunk, 0, chunk.size)
                    if (read <= 0) continue
                    if (!duplexGate.shouldUploadInput(muted.get())) continue
                    onInputLevel(AudioLevels.rmsLevel(chunk, read))
                    onInputChunk(chunk.copyOf(read))
                }
            } finally {
                runCatching { record.stop() }
                record.release()
                echoCanceler?.release()
                noiseSuppressor?.release()
            }
        }.apply { name = "voice-record"; start() }

        playThread = Thread {
            val minBuffer = AudioTrack.getMinBufferSize(SAMPLE_RATE, CHANNEL_OUT, ENCODING)
            val track = AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build(),
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setSampleRate(SAMPLE_RATE)
                        .setEncoding(ENCODING)
                        .setChannelMask(CHANNEL_OUT)
                        .build(),
                )
                .setBufferSizeInBytes(maxOf(minBuffer, CHUNK_BYTES * 8))
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()
            try {
                track.play()
                while (running.get()) {
                    val pcm = playbackQueue.poll(100, TimeUnit.MILLISECONDS) ?: run {
                        if (duplexGate.completePlaybackIfIdle(playbackQueue.isEmpty())) {
                            onPlaybackActiveChanged(false)
                        }
                        onOutputLevel(0f)
                        null
                    } ?: continue
                    onOutputLevel(AudioLevels.rmsLevel(pcm))
                    var offset = 0
                    while (offset < pcm.size && running.get()) {
                        val written = track.write(pcm, offset, pcm.size - offset)
                        if (written <= 0) break
                        offset += written
                    }
                }
            } finally {
                runCatching { track.pause() }
                runCatching { track.flush() }
                track.release()
            }
        }.apply { name = "voice-play"; start() }
    }

    fun stop() {
        if (!running.compareAndSet(true, false)) return
        playbackQueue.clear()
        duplexGate.flushPlayback()
        recordThread?.join(1000)
        playThread?.join(1000)
        recordThread = null
        playThread = null
        onInputLevel(0f)
        onOutputLevel(0f)
    }

    companion object {
        const val SAMPLE_RATE = 24000
        const val CHUNK_BYTES = 3840
        private const val CHANNEL_IN = AudioFormat.CHANNEL_IN_MONO
        private const val CHANNEL_OUT = AudioFormat.CHANNEL_OUT_MONO
        private const val ENCODING = AudioFormat.ENCODING_PCM_16BIT
    }
}
