package computer.zo.alaric.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FacePresenterTest {

    @Test
    fun offStateShowsSleepingFace() {
        val face = FacePresenter.from(VoiceUiState(phase = Phase.Off), ambient = false)
        assertEquals("Tap to wake", face.statusLabel)
        assertTrue(face.dimmed)
        assertTrue(face.eyeHeight < 0.2f)
    }

    @Test
    fun speakingOpensMouthWithLevel() {
        val quiet = FacePresenter.from(VoiceUiState(phase = Phase.Speaking, outputLevel = 0f), ambient = false)
        val loud = FacePresenter.from(VoiceUiState(phase = Phase.Speaking, outputLevel = 0.5f), ambient = false)
        assertTrue(loud.mouthOpen > quiet.mouthOpen)
        assertEquals("Speaking", loud.statusLabel)
    }

    @Test
    fun ambientIsStaticAndDimmed() {
        val face = FacePresenter.from(
            VoiceUiState(phase = Phase.Speaking, outputLevel = 0.9f),
            ambient = true,
        )
        assertEquals(0f, face.mouthOpen)
        assertTrue(face.dimmed)
        assertFalse(face.animate)
    }

    @Test
    fun mutedTakesPriorityOverListening() {
        val face = FacePresenter.from(VoiceUiState(phase = Phase.Listening, muted = true), ambient = false)
        assertEquals("Muted", face.statusLabel)
        assertTrue(face.dimmed)
    }

    @Test
    fun approvalOverridesEverything() {
        val face = FacePresenter.from(
            VoiceUiState(
                phase = Phase.Speaking,
                muted = true,
                approval = PendingApproval("id", "send_email", "{}"),
            ),
            ambient = false,
        )
        assertEquals("Approval needed", face.statusLabel)
    }

    @Test
    fun errorShowsMessage() {
        val face = FacePresenter.from(
            VoiceUiState(phase = Phase.Error, errorMessage = "Not provisioned"),
            ambient = false,
        )
        assertEquals("Not provisioned", face.statusLabel)
    }
}
