# executor-evals

TypeScript eval harnesses for testing an OpenCode session against the local `executor` MCP and validating specific tool-use workflows.

## What This Repo Does

- Starts a local HTTP ping server for the eval `test` tool.
- Preflights the local `executor` CLI to confirm the configured tools are visible.
- Launches OpenCode against `opencode/mimo-v2-pro-free`.
- Runs one or more scripted eval cases.
- Writes per-run artifacts including transcripts, tool calls, raw messages, events, and summaries.

## Requirements

- `pnpm`
- Node.js 22+
- An OpenCode Zen key in one of:
  - `OPENCODE_ZEN_API_KEY`
  - `OPENCODE_API_KEY`

## Install

```bash
pnpm install
```

Create a local `.env` file for secrets:

```bash
OPENCODE_ZEN_API_KEY=your-key-here
```

## Run

List available eval cases:

```bash
pnpm eval -- --list
```

Run the full suite:

```bash
pnpm eval
```

Run one case:

```bash
pnpm eval -- workflow-use-test-tool
```

## Output

Each run writes a timestamped directory under `eval-results/` with:

- `summary.json`
- `<case>/input.json`
- `<case>/preflight.json`
- `<case>/messages.json`
- `<case>/transcript.md`
- `<case>/tool-calls.json`
- `<case>/events.json`
- `<case>/result.json`

## Environment

Optional env vars:

- `OPENCODE_MODEL_ID`
- `EVAL_PORT`
- `EVAL_CASE_DELAY_MS`

## Publishing Safety

This repo does not commit API keys. Keys are read only from environment variables at runtime.

Keep these uncommitted:

- `.env`
- `.env.*`
- `.runtime/`
- `eval-results/`

Do not force-add generated artifact directories, because local OpenCode runtime data inside them can include auth state from your machine.
