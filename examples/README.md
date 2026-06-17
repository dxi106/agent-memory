# examples/

Synthetic samples of what agentmem produces, so you can see the data shapes
without running it. **Nothing here is loaded by the tool** — your live store
lives in the gitignored top-level `signals/`, `lessons/`, `candidates/`,
`recommendations/`, and `reflections/` dirs (created by `agentmem init`).

| File | Mirrors | What it is |
|---|---|---|
| `signals/2026-01-01.jsonl` | `signals/YYYY-MM-DD.jsonl` | Raw captured events (one JSON object per line) |
| `candidates/2026-01-01-verify-before-done.md` | `candidates/<id>.md` | A lesson awaiting promote/reject |
| `lessons/**` | `lessons/{behavioral,code,workflow}/<id>.md` | Promoted, active lessons (rules for the agent) |
| `recommendations/2026-01-01-use-plan-mode.md` | `recommendations/<id>.md` | A coaching tip for you (a feature you're not using) |
| `AGENTS.sample.md` | generated `AGENTS.md` | The rules block agentmem regenerates from active lessons |

All content uses a fictional `example-app` and `example` user.
