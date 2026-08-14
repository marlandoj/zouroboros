package computer.zo.alaric.voice.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.edit
import java.net.URI
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class VoiceCredential(val baseUrl: String, val signingSecret: String)

class CredentialStore(private val context: Context) {
    private val preferences = context.getSharedPreferences("voice-credential", Context.MODE_PRIVATE)

    fun provision(baseUrl: String, signingSecret: String) {
        require(validBaseUrl(baseUrl)) { "base URL must be an HTTPS origin" }
        require(signingSecret.length >= 32) { "signing secret must contain at least 32 characters" }
        preferences.edit(commit = true) {
            putString(KEY_URL, baseUrl.removeSuffix("/"))
            putString(KEY_SECRET, encrypt(signingSecret))
        }
    }

    fun load(): VoiceCredential? {
        val url = preferences.getString(KEY_URL, null) ?: return null
        val encrypted = preferences.getString(KEY_SECRET, null) ?: return null
        return runCatching { VoiceCredential(url, decrypt(encrypted)) }.getOrNull()
    }

    fun isProvisioned(): Boolean = load() != null

    private fun secretKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private fun encrypt(value: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        cipher.updateAAD(context.packageName.toByteArray(Charsets.UTF_8))
        val encrypted = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(cipher.iv + encrypted, Base64.NO_WRAP)
    }

    private fun decrypt(encoded: String): String {
        val bytes = Base64.decode(encoded, Base64.NO_WRAP)
        require(bytes.size > IV_BYTES)
        val iv = bytes.copyOfRange(0, IV_BYTES)
        val encrypted = bytes.copyOfRange(IV_BYTES, bytes.size)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, iv))
        cipher.updateAAD(context.packageName.toByteArray(Charsets.UTF_8))
        return String(cipher.doFinal(encrypted), Charsets.UTF_8)
    }

    companion object {
        private const val KEY_ALIAS = "alaric-voice-credential"
        private const val KEY_URL = "base-url"
        private const val KEY_SECRET = "signing-secret"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val IV_BYTES = 12

        fun validBaseUrl(value: String): Boolean = runCatching {
            val uri = URI(value)
            uri.scheme == "https"
                && !uri.host.isNullOrBlank()
                && uri.userInfo == null
                && (uri.path.isNullOrBlank() || uri.path == "/")
                && uri.query == null
                && uri.fragment == null
        }.getOrDefault(false)
    }
}
