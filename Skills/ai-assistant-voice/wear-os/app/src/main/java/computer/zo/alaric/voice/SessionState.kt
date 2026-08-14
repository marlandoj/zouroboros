package computer.zo.alaric.voice

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

enum class Phase { Off, Connecting, Listening, Thinking, Speaking, Error }

data class PendingApproval(
    val approvalRequestId: String,
    val toolName: String,
    val argumentsJson: String,
)

data class VoiceUiState(
    val phase: Phase = Phase.Off,
    val muted: Boolean = false,
    val inputLevel: Float = 0f,
    val outputLevel: Float = 0f,
    val personaName: String = "Alaric",
    val toolsAvailable: Int = 0,
    val toolActivity: String = "",
    val caption: String = "",
    val approval: PendingApproval? = null,
    val errorMessage: String = "",
)

object SessionStateHolder {
    private val mutable = MutableStateFlow(VoiceUiState())
    val state: StateFlow<VoiceUiState> = mutable.asStateFlow()

    fun update(transform: (VoiceUiState) -> VoiceUiState) = mutable.update(transform)

    fun reset() = mutable.update { VoiceUiState() }
}
