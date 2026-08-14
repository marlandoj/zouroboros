#!/usr/bin/env python3
"""Run this on your LOCAL machine (not Zo) to export NotebookLM auth cookies.

Usage:
    python local-login.py

After login, it saves storage_state.json — upload that file to your Zo workspace.
"""
import json
import sys

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("Install playwright first: pip install playwright && python -m playwright install chromium")
    sys.exit(1)


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        context = browser.new_context()
        page = context.new_page()

        print("Opening NotebookLM...")
        print("1. Sign in with your Google account")
        print("2. Wait until you see the NotebookLM homepage")
        print("3. Come back here and press ENTER\n")

        try:
            page.goto("https://notebooklm.google.com/", wait_until="commit", timeout=30000)
        except Exception:
            pass  # Ignore navigation errors — redirects are expected

        input("[Press ENTER when you are logged in and see NotebookLM] ")

        # Save storage state regardless of page state
        state = context.storage_state()
        output = "storage_state.json"
        with open(output, "w") as f:
            json.dump(state, f, indent=2)

        cookie_count = len(state.get("cookies", []))
        print(f"\nSaved {cookie_count} cookies to {output}")
        print(f"Upload this file to your Zo workspace.")

        browser.close()


if __name__ == "__main__":
    main()
