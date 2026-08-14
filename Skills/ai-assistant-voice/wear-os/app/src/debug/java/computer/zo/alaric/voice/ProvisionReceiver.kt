package computer.zo.alaric.voice

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import computer.zo.alaric.voice.security.CredentialStore

class ProvisionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return
        val baseUrl = intent.getStringExtra(EXTRA_URL)
        val secret = intent.getStringExtra(EXTRA_SECRET)
        if (baseUrl.isNullOrBlank() || secret.isNullOrBlank()) {
            resultCode = RESULT_INVALID
            return
        }
        resultCode = runCatching {
            CredentialStore(context.applicationContext).provision(baseUrl, secret)
        }.fold(onSuccess = { RESULT_OK }, onFailure = { RESULT_INVALID })
    }

    private companion object {
        const val ACTION = "computer.zo.alaric.voice.PROVISION"
        const val EXTRA_URL = "base_url"
        const val EXTRA_SECRET = "signing_secret"
        const val RESULT_OK = 1
        const val RESULT_INVALID = 2
    }
}
