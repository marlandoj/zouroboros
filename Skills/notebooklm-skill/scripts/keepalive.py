#!/usr/bin/env python3.12
"""NotebookLM session keepalive (v2 — persistent profile + stealth).

Touches notebooklm.google.com using a *persistent* Chromium profile that stores
the full browser state (cookies, IndexedDB, service workers, canvas/webgl
fingerprint) to disk. This mimics a real user profile much more closely than
the previous stateless approach, which was tripping Google's bot-detection and
causing the session to be revoked server-side within hours of a "successful"
refresh.

On every run the latest cookies are also exported back to
~/.notebooklm/storage_state.json so the existing nlm.py / notebooklm-py client
keeps working unchanged.

Usage:
    python3.12 keepalive.py              # Refresh (silent on success)
    python3.12 keepalive.py --verbose    # Print details
    python3.12 keepalive.py --check-only # Validate without refresh

Exit codes:
    0 - Success
    1 - Hard failure (auth expired, manual re-export required)
    2 - Soft failure (network/transient, storage_state.json untouched)
"""
import argparse
import asyncio
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

HOME_DIR = Path.home() / ".notebooklm"
STORAGE = HOME_DIR / "storage_state.json"
BACKUP = STORAGE.with_suffix(".json.bak")
LOG = HOME_DIR / "keepalive.log"
PROFILE_DIR = HOME_DIR / "chrome-profile"
MIGRATION_SENTINEL = PROFILE_DIR / ".migrated"

CRITICAL_COOKIES = {
    "SID", "HSID", "SSID", "APISID", "SAPISID",
    "__Secure-1PSID", "__Secure-3PSID",
    "OSID", "__Secure-OSID",
}

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


def log(msg: str, verbose: bool = False):
    ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
    line = f"[{ts}] {msg}"
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a") as f:
        f.write(line + "\n")
    if verbose:
        print(line)


def check_critical_cookies(state: dict) -> tuple[bool, list[str]]:
    names = {c["name"] for c in state.get("cookies", [])}
    missing = [c for c in CRITICAL_COOKIES if c not in names]
    return (len(missing) == 0, missing)


async def _apply_stealth(context) -> None:
    """Minimal stealth script: hide the most obvious automation markers.

    We intentionally keep this lightweight. The bulk of the anti-detection win
    comes from using a persistent profile (launch_persistent_context), not from
    scripted fingerprint patches.
    """
    await context.add_init_script(
        """
        // webdriver flag
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

        // plugins / languages — headless Chromium reports empty lists
        Object.defineProperty(navigator, 'plugins', {
            get: () => [1, 2, 3, 4, 5]
        });
        Object.defineProperty(navigator, 'languages', {
            get: () => ['en-US', 'en']
        });

        // permissions.query mismatch (notifications reports 'default' in real browsers)
        const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
        if (originalQuery) {
            window.navigator.permissions.query = (parameters) =>
                parameters.name === 'notifications'
                    ? Promise.resolve({ state: Notification.permission })
                    : originalQuery(parameters);
        }
        """
    )


async def _migrate_storage_into_profile(context, verbose: bool) -> None:
    """First-run seed: push cookies from storage_state.json into the empty profile."""
    if not STORAGE.exists():
        return
    try:
        state = json.loads(STORAGE.read_text())
    except Exception as e:
        log(f"WARN: could not read storage_state for migration: {e}", verbose)
        return
    cookies = state.get("cookies", [])
    if not cookies:
        return
    # Playwright expects sameSite = 'Strict' | 'Lax' | 'None'
    fixed = []
    for c in cookies:
        cc = dict(c)
        ss = (cc.get("sameSite") or "").lower()
        if ss == "no_restriction":
            cc["sameSite"] = "None"
        elif ss == "lax":
            cc["sameSite"] = "Lax"
        elif ss == "strict":
            cc["sameSite"] = "Strict"
        else:
            cc.pop("sameSite", None)
        # 'unspecified' or missing — drop the key
        fixed.append(cc)
    try:
        await context.add_cookies(fixed)
        log(f"Migrated {len(fixed)} cookies from storage_state.json into persistent profile", verbose)
    except Exception as e:
        log(f"WARN: add_cookies during migration failed: {e}", verbose)


async def refresh(verbose: bool = False, check_only: bool = False) -> int:
    # Pre-flight: we still need storage_state.json to exist on first run so we
    # can migrate cookies into the fresh profile. Subsequent runs can rely on
    # the profile alone, but we keep storage_state.json in sync anyway for
    # nlm.py compatibility.
    if not STORAGE.exists() and not MIGRATION_SENTINEL.exists():
        log("ERROR: storage_state.json missing — manual re-export required", verbose)
        return 1

    if STORAGE.exists():
        try:
            state = json.loads(STORAGE.read_text())
        except Exception as e:
            log(f"ERROR: storage_state.json unreadable: {e}", verbose)
            return 1
        ok, missing = check_critical_cookies(state)
        if not ok and not MIGRATION_SENTINEL.exists():
            log(f"ERROR: missing critical cookies: {missing}", verbose)
            return 1

    try:
        from playwright.async_api import async_playwright
    except ImportError:
        log("ERROR: playwright not installed", verbose)
        return 2

    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    first_run = not MIGRATION_SENTINEL.exists()

    try:
        async with async_playwright() as p:
            # Persistent context — the key anti-detection change. Chromium
            # writes the full profile (cookies, localStorage, IndexedDB,
            # service workers, canvas/WebGL fingerprint cache) to disk and
            # reuses it across runs, so Google's backend sees a consistent
            # "returning user" signal instead of a fresh headless session.
            context = await p.chromium.launch_persistent_context(
                user_data_dir=str(PROFILE_DIR),
                headless=True,
                user_agent=USER_AGENT,
                viewport={"width": 1280, "height": 800},
                locale="en-US",
                timezone_id="America/Phoenix",
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-features=IsolateOrigins,site-per-process",
                ],
                ignore_default_args=["--enable-automation"],
            )

            await _apply_stealth(context)

            if first_run:
                await _migrate_storage_into_profile(context, verbose)

            page = await context.new_page()

            log("Opening notebooklm.google.com...", verbose)
            try:
                await page.goto(
                    "https://notebooklm.google.com/",
                    wait_until="domcontentloaded",
                    timeout=30000,
                )
            except Exception as e:
                log(f"Navigation warning (non-fatal): {e}", verbose)

            # Let post-load XHRs rotate the short-lived tokens.
            try:
                await page.wait_for_timeout(7000)
            except Exception:
                pass

            final_url = page.url
            log(f"Final URL: {final_url}", verbose)

            if "accounts.google.com" in final_url or "/signin" in final_url.lower():
                log("ERROR: redirected to sign-in — session expired", verbose)
                await context.close()
                return 1

            if check_only:
                log("Check-only: session appears valid", verbose)
                await context.close()
                return 0

            # Back up the current storage_state.json before we overwrite it.
            if STORAGE.exists():
                shutil.copy2(STORAGE, BACKUP)

            # Export cookies (+ origins) from the live profile for nlm.py.
            new_state = await context.storage_state()
            ok, missing = check_critical_cookies(new_state)
            if not ok:
                log(f"ERROR: refreshed state missing: {missing} — keeping backup", verbose)
                if BACKUP.exists():
                    shutil.copy2(BACKUP, STORAGE)
                await context.close()
                return 1

            with STORAGE.open("w") as f:
                json.dump(new_state, f, indent=2)

            MIGRATION_SENTINEL.touch()

            cookie_count = len(new_state.get("cookies", []))
            tag = "(persistent profile seeded)" if first_run else "(persistent profile reused)"
            log(f"SUCCESS: refreshed {cookie_count} cookies {tag}", verbose)
            await context.close()
            return 0

    except Exception as e:
        log(f"ERROR: unexpected failure: {e}", verbose)
        return 2


def main():
    parser = argparse.ArgumentParser(description="NotebookLM session keepalive (persistent profile)")
    parser.add_argument("--verbose", "-v", action="store_true", help="Print log lines to stdout")
    parser.add_argument("--check-only", action="store_true", help="Validate session without refreshing")
    args = parser.parse_args()

    code = asyncio.run(refresh(verbose=args.verbose, check_only=args.check_only))
    sys.exit(code)


if __name__ == "__main__":
    main()
