# Safety reference

Use this reference whenever the task touches hidden tests, OAuth, API keys, protected paths, or PR candidate creation.

## Non-negotiable boundaries

- Do not expose hidden acceptance source paths or contents to the builder agent.
- Do not print or store OAuth token strings, API keys, refresh tokens, `auth.json`, `.env`, PEM/key files, or credential file contents.
- Record only boolean auth-header presence and aggregate usage stats.
- Treat `eval.yaml`, hidden tests, lockfiles, CI config, auth, billing, permissions, deployment, and schema files as high-sensitivity unless explicitly scoped.
- If a gate fails, do not call the result accepted even if an LLM reviewer says it looks good.
- If the report says `needs_human_review`, do not convert it to accept.

## PR candidate rules

Prepare a PR candidate only when VibeLoop produced `decision=accept` with `ALL_PASS`, or when a human explicitly approves a non-accept result. Include failed/advisory findings in the PR body if present.

## Redaction checklist

Before responding, search the output for:

- `Bearer `
- `access_token`
- `refresh_token`
- `api_key`
- `OPENAI_API_KEY`
- `SECRET_HIDDEN_EXPECTATION`
- `.env`
- `auth.json`

If any secret-like value appears, redact before showing the user.
