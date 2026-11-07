# Skill: AI Cost Audit

## Objective
Identify and explain material AI inference spend using observed usage metadata.

## Procedure
1. Confirm the measurement window and the applications/models included.
2. Segment calls by model, endpoint, workload and customer where permitted.
3. Identify missing price mappings and label their spend as unknown, never zero.
4. Look for high-cost models used on simple tasks, repeated calls, unusually large token counts, retries and long-running loops.
5. Rank findings by estimated cost and confidence.
6. Present evidence, uncertainty and a proposed test; do not change production settings.

## Required output
- Measurement window and data coverage
- Spend by model and workload
- Unpriced usage
- Top cost drivers with evidence
- Candidate experiments and risks
- Data limitations

## Guardrails
Do not store prompts or completions in audit reports. Do not claim savings from model-rate estimates alone. Never change model routing without approval.
