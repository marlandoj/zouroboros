#!/usr/bin/env python3
import argparse
import importlib.util
import sys
from pathlib import Path


HERE = Path(__file__).resolve().parent


def _load_module():
    spec = importlib.util.spec_from_file_location("persona_audit", HERE / "persona_audit.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _registry(personas):
    return {"platform_personas": personas}


def _entry(persona_id="id-1", name="One", model="byok:model-1", scopes=None, slug="zo-one-id1", redacted=False):
    entry = {
        "slug": slug,
        "id": persona_id,
        "name": name,
        "model": model,
        "scopes": scopes or ["all"],
        "purpose": f"Platform persona for {name}",
        "provenance": {"source": "zo.list_personas", "observedAt": "2026-08-11T00:00:00Z"},
    }
    if redacted:
        entry["redacted"] = True
    return entry


def _snapshot(personas):
    return {"personas": personas}


def _live(persona_id="id-1", name="One", model="byok:model-1", scopes=None):
    return {"id": persona_id, "name": name, "model": model, "scopes": scopes or ["all"]}


def test_clean(audit):
    result = audit.audit(_registry([_entry()]), _snapshot([_live()]), {"models": [{"id": "byok:model-1"}]})
    assert result["status"] == "OK"
    assert result["findingCount"] == 0
    assert len(result["registryHash"]) == len(result["liveHash"]) == 64


def test_drift_classes(audit):
    registered = [_entry(), _entry("gone", "Gone", None, slug="zo-gone-gone")]
    live = [_live(name="Renamed"), _live("new", "New", "byok:missing")]
    result = audit.audit(_registry(registered), _snapshot(live), {"models": [{"id": "byok:model-1"}]})
    kinds = {finding["kind"] for finding in result["findings"]}
    assert {"field-mismatch", "live-unregistered", "registered-missing-live", "model-not-in-catalog"}.issubset(kinds)
    assert result["status"] == "DRIFT"


def test_duplicate_ids_and_slugs(audit):
    result = audit.audit(_registry([_entry(), _entry(slug="zo-one-id1")]), _snapshot([_live(), _live()]))
    kinds = {finding["kind"] for finding in result["findings"]}
    assert {"duplicate-registry-id", "duplicate-registry-slug", "duplicate-live-id"}.issubset(kinds)


def test_malformed_fails_closed(audit):
    try:
        audit.audit(_registry([_entry()]), {"personas": "not-a-list"})
        assert False, "expected malformed snapshot to fail"
    except audit.AuditInputError:
        pass


def test_redacted_registry_entry_suppresses_only_name_drift(audit):
    registered = [_entry(name="Restricted Persona", redacted=True)]
    result = audit.audit(_registry(registered), _snapshot([_live(name="Private Live Name")]))
    assert result["status"] == "OK"
    changed_model = audit.audit(
        _registry(registered),
        _snapshot([_live(name="Private Live Name", model="byok:model-2")]),
    )
    assert changed_model["status"] == "DRIFT"
    assert changed_model["findings"][0]["field"] == "model"


def main():
    argparse.ArgumentParser(description="Tests for the persona registry audit.").parse_args()
    audit = _load_module()
    tests = [
        test_clean,
        test_drift_classes,
        test_duplicate_ids_and_slugs,
        test_malformed_fails_closed,
        test_redacted_registry_entry_suppresses_only_name_drift,
    ]
    failed = 0
    for test in tests:
        try:
            test(audit)
            print(f"PASS {test.__name__}")
        except Exception as error:
            failed += 1
            print(f"FAIL {test.__name__}: {error}")
    print(f"{len(tests) - failed}/{len(tests)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
