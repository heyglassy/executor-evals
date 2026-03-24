# Latest Results

## Latest Full Suite Run

- Run: [`eval-results/2026-03-24T03-16-36-349Z/summary.json`](./eval-results/2026-03-24T03-16-36-349Z/summary.json)
- Outcome: `0 passed`, `4 failed`

| Script | Status | Brief Summary | Artifacts |
| --- | --- | --- | --- |
| [`evals/cases/conversation-tools-overview.ts`](./evals/cases/conversation-tools-overview.ts) | Fail | Timed out after about 117s. The model used `executor_execute`, but it never completed the case inside the eval budget. | [`result.json`](./eval-results/2026-03-24T03-16-36-349Z/conversation-tools-overview/result.json) · [`transcript.md`](./eval-results/2026-03-24T03-16-36-349Z/conversation-tools-overview/transcript.md) |
| [`evals/cases/conversation-just-look-at-mcp-tools.ts`](./evals/cases/conversation-just-look-at-mcp-tools.ts) | Fail | Upstream provider failure from OpenCode Zen. The response body reported `429` and `Cluster input token rate limit exceeded`. | [`result.json`](./eval-results/2026-03-24T03-16-36-349Z/conversation-just-look-at-mcp-tools/result.json) · [`transcript.md`](./eval-results/2026-03-24T03-16-36-349Z/conversation-just-look-at-mcp-tools/transcript.md) |
| [`evals/cases/conversation-describe-tools-tool.ts`](./evals/cases/conversation-describe-tools-tool.ts) | Fail | Upstream provider failure from OpenCode Zen. The response body reported `429` and `Cluster input token rate limit exceeded`. | [`result.json`](./eval-results/2026-03-24T03-16-36-349Z/conversation-describe-tools-tool/result.json) · [`transcript.md`](./eval-results/2026-03-24T03-16-36-349Z/conversation-describe-tools-tool/transcript.md) |
| [`evals/cases/workflow-use-test-tool.ts`](./evals/cases/workflow-use-test-tool.ts) | Fail | Upstream provider failure from OpenCode Zen during the full-suite run. The response body reported `429` and `Cluster input token rate limit exceeded`. | [`result.json`](./eval-results/2026-03-24T03-16-36-349Z/workflow-use-test-tool/result.json) · [`transcript.md`](./eval-results/2026-03-24T03-16-36-349Z/workflow-use-test-tool/transcript.md) |

## Latest Focused Rerun

- Run: [`eval-results/2026-03-24T03-19-26-172Z/summary.json`](./eval-results/2026-03-24T03-19-26-172Z/summary.json)
- Scope: [`evals/cases/workflow-use-test-tool.ts`](./evals/cases/workflow-use-test-tool.ts)
- Outcome: Pass
- Notes: The rerun completed in about 35s, used `executor_execute` and `executor_resume`, matched `eval.test`, and pinged the local HTTP server once.
- Artifacts: [`result.json`](./eval-results/2026-03-24T03-19-26-172Z/workflow-use-test-tool/result.json) · [`transcript.md`](./eval-results/2026-03-24T03-19-26-172Z/workflow-use-test-tool/transcript.md)
