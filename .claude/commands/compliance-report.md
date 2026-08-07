# /compliance-report — Unified Compliance Report

Generate the unified Tier 1 (summary) / Tier 2 (evidence) report for this agent's
eight-point posture. Read-only aggregation shown in chat; no file is written.

## Sources
The control set is `system/compliance-controls.yaml` (n, name, evidence). Each
control's evidence is `state/compliance/<evidence>.json`, a JSON object with
`ok` (boolean), `output` (the deterministic writer's evidence lines), and `ranAt`.
Evidence is refreshed server-side immediately before this report runs (every
`record:` entry in `system/skills.yaml` is re-executed deterministically).

## Status rules — derive status ONLY from these
- Evidence file missing or unreadable -> **ATTENTION** ("no evidence file").
- `ok: true` and `output` contains "N/A by design" -> **N/A — GREEN**.
- `ok: true` otherwise -> **GREEN**.
- `ok: false` -> **ATTENTION**.
Never infer status from code presence, config contents, capability descriptions,
or any file outside `state/compliance/` and `system/compliance-controls.yaml`.

## Output format
1. `## Unified Compliance Report — <today's date>`
2. `### Tier 1 — Summary`: a table `| # | Control | Status |` in control order,
   then a bold one-line verdict with the GREEN / N/A / ATTENTION counts.
3. `### Tier 2 — Evidence`: for each control, `**<n>. <name>** — <STATUS>`, then
   the evidence `ranAt` and the `output` lines quoted verbatim (trim to the first
   6 lines if longer). For missing evidence, say which file was expected.
Keep it factual and terse; no recommendations unless a control is ATTENTION, in
which case add one line naming the remediation surface (not a plan).
