# Alaric Voice for Wear OS

Native watch client for the Alaric Voice assistant (Galaxy Watch 4+, tested target:
Galaxy Watch 8). Replaces the browser PWA on the watch, which Wear OS suspends on
screen-off and which cannot render always-on display content.

## What it does

- **Face-first UI** — the Alaric face fills the round screen. Tap anywhere to mute or
  unmute; long-press to end the session. Rotary bezel adjusts volume.
- **True AOD** — in ambient mode the face stays visible as a burn-in-safe grayscale
  outline with the current status, using the same `AmbientModeManager` pattern as the
  Zo Ambient Relay recorder.
- **Session survival** — a `microphone` foreground service with an `OngoingActivity`
  chip and a partial wake lock keeps the Realtime session alive wrist-down.
- **Echo-safe playback** — microphone upload pauses while Alaric is responding and
  resumes after the watch speaker queue drains, preventing speaker echo from being
  mistaken for a user interruption.
- **Full tool access** — sessions are minted by the existing `/api/realtime-session`
  route with the `essentials` pack (28 tools including `factory_status`, Gmail,
  Calendar, Linear). MCP tool calls run server-side; the watch only streams audio.
- **Approval gating preserved** — write tools (email/SMS sends) surface an on-watch
  Approve / Deny card before executing.

## Architecture

```
watch mic ── AudioEngine (24 kHz PCM16, AEC/NS) ──┐
                                                  ├─ RealtimeClient ── wss://api.openai.com/v1/realtime
watch speaker ◀─ AudioTrack ◀─ playback queue ────┘        ▲
                                                            │ ephemeral client secret
CredentialStore (Keystore AES-GCM: base URL + signing secret)
        └─ SessionAuth mints v1.<exp>.<nonce>.<hmac> ─▶ POST /api/realtime-session
```

The watch holds only the session-mint signing secret (Keystore-encrypted), never the
OpenAI key or the MCP token. Each session uses a fresh 5-minute HMAC token; the mint
route returns a short-lived ephemeral OpenAI secret.

## Build

```bash
export ANDROID_HOME=/root/Android/Sdk
./gradlew lintDebug testDebugUnitTest assembleDebug
```

The debug APK lands in `app/build/outputs/apk/debug/` and is copied to
`artifacts/alaric-voice-wear-debug.apk` by the release step.

## Install (from a machine on the same network as the watch)

Enable developer options + wireless debugging on the watch, then:

```bash
scripts/install-watch.sh WATCH_HOST:WATCH_PORT
scripts/provision-watch.sh WATCH_HOST:WATCH_PORT https://marlandoj.zo.space
```

`provision-watch.sh` reads the signing secret from `ALARIC_VOICE_SECRET` or stdin and
never passes it as a command-line argument. The provisioning receiver exists only in
debug builds and requires the ADB-only `DUMP` permission.

## Tests

JVM unit tests cover the token mint/verify roundtrip (mirroring the route's
`verifyToken`), the Realtime event parser (GA + legacy event names, approval
dedup), RMS level math, and the face presentation state machine.
