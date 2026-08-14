#!/usr/bin/env python3
import argparse
import hashlib
import json
import sys
from pathlib import Path


class AuditInputError(Exception):
    pass


def _read_json(path: Path):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError as error:
        raise AuditInputError(f"input not found: {path}") from error
    except json.JSONDecodeError as error:
        raise AuditInputError(f"invalid JSON in {path}: {error}") from error


def _records(payload, key: str, label: str):
    if not isinstance(payload, dict) or not isinstance(payload.get(key), list):
        raise AuditInputError(f"{label} must be an object with a {key} array")
    return payload[key]


def _canonical_hash(records: list[dict]) -> str:
    ordered = sorted(records, key=lambda item: (item.get("id", ""), item.get("slug", "")))
    encoded = json.dumps(ordered, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def _validate_live(records: list) -> list[dict]:
    normalized = []
    for index, record in enumerate(records):
        if not isinstance(record, dict):
            raise AuditInputError(f"live persona {index} must be an object")
        for field in ("id", "name", "scopes"):
            if field not in record:
                raise AuditInputError(f"live persona {index} missing {field}")
        if not isinstance(record["id"], str) or not record["id"]:
            raise AuditInputError(f"live persona {index} has invalid id")
        if not isinstance(record["name"], str) or not record["name"]:
            raise AuditInputError(f"live persona {record['id']} has invalid name")
        if record.get("model") is not None and not isinstance(record.get("model"), str):
            raise AuditInputError(f"live persona {record['id']} has invalid model")
        if not isinstance(record["scopes"], list) or not all(isinstance(x, str) for x in record["scopes"]):
            raise AuditInputError(f"live persona {record['id']} has invalid scopes")
        normalized.append({
            "id": record["id"],
            "name": record["name"],
            "model": record.get("model"),
            "scopes": sorted(record["scopes"]),
        })
    return normalized


def _validate_registry(records: list) -> list[dict]:
    normalized = []
    for index, record in enumerate(records):
        if not isinstance(record, dict):
            raise AuditInputError(f"registry persona {index} must be an object")
        required = ("slug", "id", "name", "model", "scopes", "purpose", "provenance")
        missing = [field for field in required if field not in record]
        if missing:
            raise AuditInputError(f"registry persona {index} missing {', '.join(missing)}")
        if not isinstance(record["slug"], str) or not record["slug"]:
            raise AuditInputError(f"registry persona {index} has invalid slug")
        if not isinstance(record["id"], str) or not record["id"]:
            raise AuditInputError(f"registry persona {record['slug']} has invalid id")
        if not isinstance(record["name"], str) or not record["name"]:
            raise AuditInputError(f"registry persona {record['slug']} has invalid name")
        if record["model"] is not None and not isinstance(record["model"], str):
            raise AuditInputError(f"registry persona {record['slug']} has invalid model")
        if not isinstance(record["scopes"], list) or not all(isinstance(x, str) for x in record["scopes"]):
            raise AuditInputError(f"registry persona {record['slug']} has invalid scopes")
        if not isinstance(record["purpose"], str) or not record["purpose"]:
            raise AuditInputError(f"registry persona {record['slug']} has invalid purpose")
        if "redacted" in record and not isinstance(record["redacted"], bool):
            raise AuditInputError(f"registry persona {record['slug']} has invalid redacted flag")
        provenance = record["provenance"]
        if not isinstance(provenance, dict) or provenance.get("source") != "zo.list_personas":
            raise AuditInputError(f"registry persona {record['slug']} has invalid provenance")
        normalized.append({
            "slug": record["slug"],
            "id": record["id"],
            "name": record["name"],
            "model": record["model"],
            "scopes": sorted(record["scopes"]),
            "redacted": record.get("redacted", False),
        })
    return normalized


def _duplicates(values: list[str]) -> list[str]:
    seen, duplicates = set(), set()
    for value in values:
        if value in seen:
            duplicates.add(value)
        seen.add(value)
    return sorted(duplicates)


def _model_ids(payload) -> set[str]:
    records = _records(payload, "models", "model catalog")
    return {
        record["id"] for record in records
        if isinstance(record, dict) and isinstance(record.get("id"), str)
    }


def audit(registry_payload, snapshot_payload, model_catalog_payload=None):
    registry = _validate_registry(_records(registry_payload, "platform_personas", "registry"))
    live = _validate_live(_records(snapshot_payload, "personas", "live snapshot"))
    findings = []

    for value in _duplicates([entry["id"] for entry in registry]):
        findings.append({"kind": "duplicate-registry-id", "id": value})
    for value in _duplicates([entry["slug"] for entry in registry]):
        findings.append({"kind": "duplicate-registry-slug", "slug": value})
    for value in _duplicates([entry["id"] for entry in live]):
        findings.append({"kind": "duplicate-live-id", "id": value})

    registry_by_id = {entry["id"]: entry for entry in registry}
    live_by_id = {entry["id"]: entry for entry in live}
    for persona_id in sorted(live_by_id.keys() - registry_by_id.keys()):
        findings.append({"kind": "live-unregistered", "id": persona_id, "name": live_by_id[persona_id]["name"]})
    for persona_id in sorted(registry_by_id.keys() - live_by_id.keys()):
        findings.append({"kind": "registered-missing-live", "id": persona_id, "name": registry_by_id[persona_id]["name"]})
    for persona_id in sorted(registry_by_id.keys() & live_by_id.keys()):
        registered = registry_by_id[persona_id]
        observed = live_by_id[persona_id]
        fields = ("model", "scopes") if registered["redacted"] else ("name", "model", "scopes")
        for field in fields:
            if registered[field] != observed[field]:
                findings.append({
                    "kind": "field-mismatch",
                    "id": persona_id,
                    "field": field,
                    "registered": registered[field],
                    "live": observed[field],
                })

    if model_catalog_payload is not None:
        catalog_ids = _model_ids(model_catalog_payload)
        for model in sorted({entry["model"] for entry in live if entry["model"]} - catalog_ids):
            findings.append({"kind": "model-not-in-catalog", "model": model})

    return {
        "status": "OK" if not findings else "DRIFT",
        "registeredCount": len(registry),
        "liveCount": len(live),
        "findingCount": len(findings),
        "registryHash": _canonical_hash(registry),
        "liveHash": _canonical_hash(live),
        "findings": findings,
    }


def run(registry: Path, snapshot: Path, model_catalog: Path | None):
    try:
        result = audit(
            _read_json(registry),
            _read_json(snapshot),
            _read_json(model_catalog) if model_catalog else None,
        )
    except AuditInputError as error:
        return {"status": "ERROR", "findingCount": 1, "error": str(error)}, 1
    return result, 0 if result["status"] == "OK" else 2


def main():
    parser = argparse.ArgumentParser(description="Compare a caller-supplied Zo persona snapshot with the canonical registry.")
    parser.add_argument("--registry", required=True)
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--model-catalog")
    args = parser.parse_args()
    result, exit_code = run(
        Path(args.registry),
        Path(args.snapshot),
        Path(args.model_catalog) if args.model_catalog else None,
    )
    print(json.dumps(result, sort_keys=True))
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
