---
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent, Skill, AskUserQuestion
description: Run the public deep-review route with the same arguments on Claude Code and Codex.
argument-hint: "[init] [--contract [SLICE-NNN]] [--entropy] [--ultracode] [--codex|--no-codex] [--no-opus] [--agy|--no-agy] [--grok|--no-grok] [--codex-only] [--reviewer-strategy adaptive|static] [--readiness-receipt PATH] [--routing auto|fast|balanced|quality] [--model PROVIDER=MODEL] [--effort PROVIDER=EFFORT] [--reviewer-model REVIEWER=MODEL] [--reviewer-effort REVIEWER=EFFORT] [--allow-fallback|--no-fallback] [--allow-classifier] [--respond (REPORT_PATH | --source=pr [--pr=NNN])]"
---

# /deep-review — Claude Code adapter

This command is a thin Claude Code adapter to the public skill.

1. Resolve the absolute plugin root with the runtime-root contract: generic
   `PLUGIN_ROOT`, then the Claude compatibility alias, then the installed
   command location supplied by the host.
2. Read `{plugin_root}/skills/deep-review/SKILL.md` in full.
3. Execute that public skill with the original `$ARGUMENTS` byte-for-byte and
   return its terminal result. Do not re-parse, add, remove, or reorder flags
   in this adapter.
