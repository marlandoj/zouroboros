package computer.zo.alaric.voice

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Base64
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.wear.ongoing.OngoingActivity
import androidx.wear.ongoing.Status
import computer.zo.alaric.voice.audio.AudioEngine
import computer.zo.alaric.voice.auth.SessionAuth
import computer.zo.alaric.voice.realtime.RealtimeClient
import computer.zo.alaric.voice.realtime.RealtimeClientListener
import computer.zo.alaric.voice.realtime.RealtimeEvent
import computer.zo.alaric.voice.realtime.RealtimeSessionApi
import computer.zo.alaric.voice.security.CredentialStore
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import okhttp3.OkHttpClient

class VoiceSessionService : Service(), RealtimeClientListener {
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    private var realtime: RealtimeClient? = null
    private var audio: AudioEngine? = null
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> startSession()
            ACTION_STOP -> stopSession()
            ACTION_TOGGLE_MUTE -> toggleMute()
            ACTION_APPROVE -> resolveApproval(intent, approve = true)
            ACTION_DENY -> resolveApproval(intent, approve = false)
        }
        return START_NOT_STICKY
    }

    private fun startSession() {
        if (SessionStateHolder.state.value.phase != Phase.Off &&
            SessionStateHolder.state.value.phase != Phase.Error
        ) {
            return
        }
        val credential = CredentialStore(this).load()
        if (credential == null) {
            SessionStateHolder.update {
                it.copy(phase = Phase.Error, errorMessage = "Not provisioned")
            }
            stopSelf()
            return
        }
        startForegroundWithChip()
        acquireWakeLock()
        SessionStateHolder.update {
            VoiceUiState(phase = Phase.Connecting, muted = it.muted)
        }

        val engine = AudioEngine(
            onInputChunk = { chunk ->
                realtime?.sendAudio(Base64.encodeToString(chunk, Base64.NO_WRAP))
            },
            onInputLevel = { level ->
                SessionStateHolder.update { it.copy(inputLevel = level) }
            },
            onOutputLevel = { level ->
                SessionStateHolder.update { it.copy(outputLevel = level) }
            },
            onPlaybackActiveChanged = { active ->
                if (!active && audio?.isResponseActive() == false) {
                    SessionStateHolder.update {
                        it.copy(phase = Phase.Listening, toolActivity = "")
                    }
                    updateChip(if (audio?.isMuted() == true) "Muted" else "Listening")
                }
            },
        )
        audio = engine

        thread(name = "voice-session-start") {
            runCatching {
                val token = SessionAuth.mintToken(credential.signingSecret, System.currentTimeMillis())
                val minted = RealtimeSessionApi(http).mint(credential.baseUrl, token)
                SessionStateHolder.update {
                    it.copy(personaName = minted.personaName, toolsAvailable = minted.toolsAvailable)
                }
                val client = RealtimeClient(http, this)
                realtime = client
                client.connect(minted.clientSecret, minted.model)
            }.onFailure { failure ->
                SessionStateHolder.update {
                    it.copy(phase = Phase.Error, errorMessage = failure.message ?: "session failed")
                }
                stopSession()
            }
        }
    }

    private fun stopSession() {
        realtime?.close()
        realtime = null
        audio?.stop()
        audio = null
        releaseWakeLock()
        SessionStateHolder.update {
            if (it.phase == Phase.Error) it.copy(inputLevel = 0f, outputLevel = 0f)
            else VoiceUiState(muted = it.muted)
        }
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun toggleMute() {
        val engine = audio ?: return
        val next = !engine.isMuted()
        engine.setMuted(next)
        SessionStateHolder.update { it.copy(muted = next) }
        updateChip(if (next) "Muted" else "Listening")
    }

    private fun resolveApproval(intent: Intent, approve: Boolean) {
        val id = intent.getStringExtra(EXTRA_APPROVAL_ID) ?: return
        realtime?.sendApproval(id, approve)
        SessionStateHolder.update {
            if (it.approval?.approvalRequestId == id) it.copy(approval = null) else it
        }
    }

    override fun onEvent(event: RealtimeEvent) {
        when (event) {
            is RealtimeEvent.SessionCreated -> {
                audio?.start()
                SessionStateHolder.update { state ->
                    state.copy(phase = Phase.Listening).also { updateChip("Listening") }
                }
                audio?.setMuted(SessionStateHolder.state.value.muted)
            }
            is RealtimeEvent.AudioDelta -> {
                val pcm = runCatching { Base64.decode(event.pcmBase64, Base64.NO_WRAP) }.getOrNull()
                if (pcm != null) {
                    audio?.playPcm(pcm)
                    SessionStateHolder.update {
                        if (it.phase != Phase.Speaking) it.copy(phase = Phase.Speaking) else it
                    }
                }
            }
            RealtimeEvent.SpeechStarted -> {
                if (audio?.isResponseActive() == true || audio?.isPlaybackActive() == true) return
                audio?.flushPlayback()
                SessionStateHolder.update { it.copy(phase = Phase.Listening, caption = "") }
            }
            RealtimeEvent.SpeechStopped -> {
                if (audio?.isResponseActive() == true || audio?.isPlaybackActive() == true) return
                SessionStateHolder.update { it.copy(phase = Phase.Thinking) }
            }
            RealtimeEvent.ResponseStarted -> {
                audio?.setResponseActive(true)
                SessionStateHolder.update {
                    it.copy(phase = Phase.Thinking, toolActivity = "")
                }
            }
            RealtimeEvent.ResponseDone -> {
                audio?.setResponseActive(false)
                if (audio?.isPlaybackActive() != true) {
                    SessionStateHolder.update {
                        it.copy(phase = Phase.Listening, toolActivity = "")
                    }
                    updateChip(if (audio?.isMuted() == true) "Muted" else "Listening")
                }
            }
            is RealtimeEvent.AssistantTranscript -> {
                SessionStateHolder.update {
                    val text = if (event.done) event.text else it.caption + event.text
                    it.copy(caption = text.takeLast(160))
                }
            }
            is RealtimeEvent.UserTranscript -> Unit
            is RealtimeEvent.ToolActivity -> {
                SessionStateHolder.update { it.copy(toolActivity = event.label) }
                updateChip("Using ${event.label}")
            }
            is RealtimeEvent.ApprovalRequest -> {
                SessionStateHolder.update {
                    it.copy(
                        approval = PendingApproval(
                            approvalRequestId = event.approvalRequestId,
                            toolName = event.toolName,
                            argumentsJson = event.argumentsJson,
                        ),
                    )
                }
                updateChip("Approval needed")
            }
            is RealtimeEvent.Error -> {
                SessionStateHolder.update {
                    it.copy(phase = Phase.Error, errorMessage = event.message)
                }
            }
            RealtimeEvent.Ignored -> Unit
        }
    }

    override fun onClosed(reason: String) {
        SessionStateHolder.update {
            it.copy(phase = Phase.Off, errorMessage = "")
        }
        stopSession()
    }

    override fun onFailure(message: String) {
        SessionStateHolder.update {
            it.copy(phase = Phase.Error, errorMessage = message)
        }
        stopSession()
    }

    private fun startForegroundWithChip() {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Voice session", NotificationManager.IMPORTANCE_LOW)
                .apply { description = "Visible while Alaric Voice is connected" },
        )
        val contentIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_alaric)
            .setContentTitle("Alaric Voice")
            .setContentText("Connected")
            .setOngoing(true)
            .setContentIntent(contentIntent)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
        OngoingActivity.Builder(applicationContext, NOTIFICATION_ID, builder)
            .setStaticIcon(R.drawable.ic_alaric)
            .setTouchIntent(contentIntent)
            .setStatus(Status.Builder().addTemplate("Connected").build())
            .build()
            .apply(applicationContext)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                builder.build(),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
            )
        } else {
            startForeground(NOTIFICATION_ID, builder.build())
        }
    }

    private fun updateChip(text: String) {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        val ongoing = OngoingActivity.recoverOngoingActivity(applicationContext) ?: return
        ongoing.update(
            applicationContext,
            Status.Builder().addTemplate(text).build(),
        )
    }

    private fun acquireWakeLock() {
        val power = getSystemService(PowerManager::class.java)
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "alaric:voice-session")
            .apply { acquire(MAX_WAKE_MS) }
    }

    private fun releaseWakeLock() {
        wakeLock?.takeIf { it.isHeld }?.release()
        wakeLock = null
    }

    override fun onDestroy() {
        realtime?.close()
        audio?.stop()
        releaseWakeLock()
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL_ID = "voice-session"
        private const val NOTIFICATION_ID = 100
        private const val MAX_WAKE_MS = 60 * 60 * 1000L
        const val ACTION_START = "computer.zo.alaric.voice.START"
        const val ACTION_STOP = "computer.zo.alaric.voice.STOP"
        const val ACTION_TOGGLE_MUTE = "computer.zo.alaric.voice.TOGGLE_MUTE"
        const val ACTION_APPROVE = "computer.zo.alaric.voice.APPROVE"
        const val ACTION_DENY = "computer.zo.alaric.voice.DENY"
        const val EXTRA_APPROVAL_ID = "approval_id"

        fun start(context: Context) = send(context, ACTION_START)
        fun stop(context: Context) = send(context, ACTION_STOP)
        fun toggleMute(context: Context) = send(context, ACTION_TOGGLE_MUTE)

        fun approve(context: Context, approvalId: String, approve: Boolean) {
            val intent = Intent(context, VoiceSessionService::class.java)
                .setAction(if (approve) ACTION_APPROVE else ACTION_DENY)
                .putExtra(EXTRA_APPROVAL_ID, approvalId)
            context.startService(intent)
        }

        private fun send(context: Context, action: String) {
            val intent = Intent(context, VoiceSessionService::class.java).setAction(action)
            if (action == ACTION_START) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }
    }
}
