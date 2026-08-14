package computer.zo.alaric.voice

data class FacePresentation(
    val mouthOpen: Float,
    val eyeHeight: Float,
    val dimmed: Boolean,
    val animate: Boolean,
    val statusLabel: String,
)

object FacePresenter {
    fun from(state: VoiceUiState, ambient: Boolean): FacePresentation {
        val level = maxOf(state.outputLevel, if (state.phase == Phase.Listening) state.inputLevel * 0.6f else 0f)
        val mouthOpen = when {
            ambient -> 0f
            state.phase == Phase.Speaking -> (0.15f + level * 2.2f).coerceIn(0.15f, 1f)
            else -> (level * 1.2f).coerceIn(0f, 0.5f)
        }
        val eyeHeight = when {
            state.phase == Phase.Off -> 0.12f
            state.muted -> 0.35f
            else -> 1f
        }
        val statusLabel = when {
            state.approval != null -> "Approval needed"
            state.phase == Phase.Error -> state.errorMessage.ifBlank { "Error" }
            state.phase == Phase.Off -> "Tap to wake"
            state.phase == Phase.Connecting -> "Connecting"
            state.muted -> "Muted"
            state.toolActivity.isNotBlank() -> "Using ${state.toolActivity}"
            state.phase == Phase.Thinking -> "Thinking"
            state.phase == Phase.Speaking -> "Speaking"
            else -> "Listening"
        }
        return FacePresentation(
            mouthOpen = mouthOpen,
            eyeHeight = eyeHeight,
            dimmed = ambient || state.muted || state.phase == Phase.Off,
            animate = !ambient,
            statusLabel = statusLabel,
        )
    }
}
