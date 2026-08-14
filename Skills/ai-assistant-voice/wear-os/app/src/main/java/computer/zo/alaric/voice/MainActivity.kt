package computer.zo.alaric.voice

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.rotary.onRotaryScrollEvent
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.Canvas
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.wear.compose.foundation.AmbientMode
import androidx.wear.compose.foundation.AmbientTickEffect
import androidx.wear.compose.foundation.LocalAmbientModeManager
import androidx.wear.compose.foundation.rememberAmbientModeManager
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.ButtonDefaults
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.Text
import computer.zo.alaric.voice.security.CredentialStore

class MainActivity : ComponentActivity() {

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
            if (grants[Manifest.permission.RECORD_AUDIO] == true) {
                VoiceSessionService.start(this)
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                val ambientModeManager = rememberAmbientModeManager()
                CompositionLocalProvider(LocalAmbientModeManager provides ambientModeManager) {
                    val manager = LocalAmbientModeManager.current
                    val ambientMode = manager?.currentAmbientMode
                    var ambientTick by remember { mutableIntStateOf(0) }
                    manager?.AmbientTickEffect { ambientTick += 1 }
                    val ambient = ambientMode as? AmbientMode.Ambient

                    val state by SessionStateHolder.state.collectAsStateWithLifecycle()
                    VoiceScreen(
                        state = state,
                        ambient = ambient != null,
                        burnInProtection = ambient?.isBurnInProtectionRequired == true,
                        ambientTick = ambientTick,
                        provisioned = remember { CredentialStore(this@MainActivity).isProvisioned() },
                        onTapFace = ::onTapFace,
                        onEndSession = { VoiceSessionService.stop(this) },
                        onApprove = { id -> VoiceSessionService.approve(this, id, true) },
                        onDeny = { id -> VoiceSessionService.approve(this, id, false) },
                        onRotaryDelta = ::adjustVolume,
                    )
                }
            }
        }
    }

    private fun onTapFace() {
        val phase = SessionStateHolder.state.value.phase
        if (phase == Phase.Off || phase == Phase.Error) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED
            ) {
                VoiceSessionService.start(this)
            } else {
                permissionLauncher.launch(
                    arrayOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS),
                )
            }
        } else {
            VoiceSessionService.toggleMute(this)
        }
    }

    private fun adjustVolume(delta: Float) {
        val audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        audioManager.adjustStreamVolume(
            AudioManager.STREAM_MUSIC,
            if (delta > 0) AudioManager.ADJUST_RAISE else AudioManager.ADJUST_LOWER,
            0,
        )
    }
}

private val Gold = Color(0xFFE8B44A)
private val GoldDim = Color(0xFF6E5626)
private val AmbientGray = Color(0xFF8A8A8A)

@Composable
private fun VoiceScreen(
    state: VoiceUiState,
    ambient: Boolean,
    burnInProtection: Boolean,
    ambientTick: Int,
    provisioned: Boolean,
    onTapFace: () -> Unit,
    onEndSession: () -> Unit,
    onApprove: (String) -> Unit,
    onDeny: (String) -> Unit,
    onRotaryDelta: (Float) -> Unit,
) {
    val presentation = FacePresenter.from(state, ambient)
    val shift = if (ambient && burnInProtection) {
        when (ambientTick % 3) {
            0 -> (-2).dp
            1 -> 0.dp
            else -> 2.dp
        }
    } else {
        0.dp
    }
    val focusRequester = remember { FocusRequester() }
    LaunchedEffect(Unit) { focusRequester.requestFocus() }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black)
            .offset(x = shift, y = shift)
            .onRotaryScrollEvent { event ->
                onRotaryDelta(event.verticalScrollPixels)
                true
            }
            .focusRequester(focusRequester)
            .focusable(),
        contentAlignment = Alignment.Center,
    ) {
        if (!provisioned && state.phase == Phase.Off) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier.padding(24.dp),
            ) {
                Text("Not provisioned", color = Color(0xFFFFC66D), textAlign = TextAlign.Center)
                Spacer(Modifier.height(8.dp))
                Text(
                    "Run provision-watch.sh from the workspace",
                    color = AmbientGray,
                    style = MaterialTheme.typography.bodySmall,
                    textAlign = TextAlign.Center,
                )
            }
            return@Box
        }

        val approval = state.approval
        if (approval != null && !ambient) {
            ApprovalScreen(approval, onApprove, onDeny)
            return@Box
        }

        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
            modifier = Modifier
                .fillMaxSize()
                .combinedClickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                    enabled = !ambient,
                    onClick = onTapFace,
                    onLongClick = onEndSession,
                ),
        ) {
            Face(presentation, ambient)
            Spacer(Modifier.height(10.dp))
            Text(
                text = presentation.statusLabel,
                color = when {
                    ambient -> AmbientGray
                    state.phase == Phase.Error -> Color(0xFFFF737A)
                    state.muted -> Color(0xFFFFC66D)
                    else -> Gold
                },
                style = MaterialTheme.typography.bodyMedium,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(horizontal = 20.dp),
            )
            if (!ambient && state.caption.isNotBlank() && state.phase == Phase.Speaking) {
                Spacer(Modifier.height(4.dp))
                Text(
                    text = state.caption,
                    color = Color(0xFFADB7C2),
                    style = MaterialTheme.typography.bodySmall,
                    textAlign = TextAlign.Center,
                    maxLines = 2,
                    modifier = Modifier.padding(horizontal = 26.dp),
                )
            }
        }
    }
}

@Composable
private fun Face(presentation: FacePresentation, ambient: Boolean) {
    val color = if (ambient) AmbientGray else if (presentation.dimmed) GoldDim else Gold
    Canvas(modifier = Modifier.size(120.dp).alpha(if (presentation.dimmed && !ambient) 0.75f else 1f)) {
        val w = size.width
        val h = size.height
        val eyeWidth = w * 0.11f
        val maxEyeHeight = h * 0.24f
        val eyeHeight = (maxEyeHeight * presentation.eyeHeight).coerceAtLeast(h * 0.03f)
        val eyeY = h * 0.30f + (maxEyeHeight - eyeHeight) / 2f
        val eyeRadius = CornerRadius(eyeWidth / 2f, eyeWidth / 2f)

        if (ambient) {
            drawRoundRect(
                color = color,
                topLeft = Offset(w * 0.22f, eyeY),
                size = Size(eyeWidth, eyeHeight),
                cornerRadius = eyeRadius,
                style = Stroke(width = 2.dp.toPx()),
            )
            drawRoundRect(
                color = color,
                topLeft = Offset(w - w * 0.22f - eyeWidth, eyeY),
                size = Size(eyeWidth, eyeHeight),
                cornerRadius = eyeRadius,
                style = Stroke(width = 2.dp.toPx()),
            )
        } else {
            drawRoundRect(
                color = color,
                topLeft = Offset(w * 0.22f, eyeY),
                size = Size(eyeWidth, eyeHeight),
                cornerRadius = eyeRadius,
            )
            drawRoundRect(
                color = color,
                topLeft = Offset(w - w * 0.22f - eyeWidth, eyeY),
                size = Size(eyeWidth, eyeHeight),
                cornerRadius = eyeRadius,
            )
        }

        val mouthMaxHeight = h * 0.20f
        val mouthHeight = (h * 0.035f + mouthMaxHeight * presentation.mouthOpen)
        val mouthWidth = w * (0.42f + 0.14f * presentation.mouthOpen)
        val mouthRadius = CornerRadius(mouthHeight / 2f, mouthHeight / 2f)
        val mouthTop = h * 0.68f - mouthHeight / 2f
        if (ambient) {
            drawRoundRect(
                color = color,
                topLeft = Offset((w - mouthWidth) / 2f, mouthTop),
                size = Size(mouthWidth, mouthHeight),
                cornerRadius = mouthRadius,
                style = Stroke(width = 2.dp.toPx()),
            )
        } else {
            drawRoundRect(
                color = color,
                topLeft = Offset((w - mouthWidth) / 2f, mouthTop),
                size = Size(mouthWidth, mouthHeight),
                cornerRadius = mouthRadius,
            )
        }
    }
}

@Composable
private fun ApprovalScreen(
    approval: PendingApproval,
    onApprove: (String) -> Unit,
    onDeny: (String) -> Unit,
) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 18.dp),
    ) {
        Text("Approve tool?", color = Gold, style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(4.dp))
        Text(
            text = approval.toolName,
            color = Color.White,
            style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(14.dp))
        Row(horizontalArrangement = Arrangement.Center, modifier = Modifier.fillMaxWidth()) {
            Button(
                onClick = { onDeny(approval.approvalRequestId) },
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFB32636)),
                shape = RoundedCornerShape(24.dp),
            ) { Text("Deny") }
            Spacer(Modifier.width(12.dp))
            Button(
                onClick = { onApprove(approval.approvalRequestId) },
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF1F7A4D)),
                shape = RoundedCornerShape(24.dp),
            ) { Text("Approve") }
        }
    }
}
