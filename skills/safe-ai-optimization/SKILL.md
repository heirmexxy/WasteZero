# Skill: Safe AI Optimization

## Objective
Test lower-cost inference configurations while preserving task quality and reliability.

## Required workflow
1. Establish a representative baseline dataset and quality rubric.
2. Select one narrow optimization hypothesis.
3. Run baseline and candidate configurations on the same cases.
4. Compare task quality, factuality, safety, latency, failure rate and total cost.
5. Define minimum acceptable quality and maximum acceptable regression before evaluating.
6. Report results with sample size, confidence limitations and rollback plan.
7. Obtain explicit human approval before deployment.
8. Monitor after deployment and revert if guardrails fail.

## Prohibited
- No silent production model switching.
- No deletion or weakening of safety instructions to save tokens.
- No savings claims without a comparable baseline and post-change window.
- No access to customer data beyond the minimum approved scope.
