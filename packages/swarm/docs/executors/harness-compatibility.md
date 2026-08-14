# Harness Compatibility Matrix

Generated from `executor-registry.json` and `harness-contract.json`. Do not edit manually.

| Harness | Transport | Instruction file | Read | Write | Shell | Web | MCP |
| --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code | acp | CLAUDE.md | Read | Edit | Bash | unsupported | MCP |
| codex | acp | AGENTS.md | exec_command | apply_patch | exec_command | unsupported | MCP |
| cursor | bridge | AGENTS.md | Read | Write | Shell | unsupported | MCP |
| gemini | acp | GEMINI.md | read_file | replace | run_shell_command | google_web_search | MCP |
| hermes | acp | AGENTS.md | read_file | write_file | terminal | web_search | MCP |
