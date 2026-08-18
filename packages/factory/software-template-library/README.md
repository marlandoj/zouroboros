# Software Template Library

This is the portable runtime distribution of the published Zouroboros Software
Template Library bundled with `zouroboros-factory`.

It contains the versioned catalog, discovery and persona-association indexes,
JSON schemas, deterministic compiler and resolver, and all generated template
prompts and manifests. The factory installer materializes it at
`Projects/software-template-library` in the target checkout.

## Verify

```bash
bun Projects/software-template-library/scripts/template-library.ts validate
bun Projects/software-template-library/scripts/template-library.ts list
```

Exact template resolution remains mandatory. `latest` is rejected, selection
does not authorize execution, and candidate export cannot dispatch, merge,
deploy, publish, or mutate Linear.

The distribution deliberately excludes retained evaluations, planning state,
model-review code, Linear mutation code, and live runtime state. Published
versions and hashes are recorded in `distribution.json` and verified by the
factory package, installer doctor, and archive tests.
