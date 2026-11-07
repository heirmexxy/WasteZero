# Architecture

```text
Customer application
        |
        | OpenAI-compatible request + WasteZero key
        v
WasteZero proxy (localhost:8787)
        |
        +--> request validation / authentication
        |
        +--> configured upstream provider
        |
        +--> response usage metadata
                    |
                    v
             JSONL event store
                    |
                    v
        cost estimates + observe-only policy
                    |
                    v
             admin summary API
```

## Trust boundaries
- The customer application supplies request content to WasteZero.
- WasteZero forwards content to the configured provider.
- By default, only metadata is persisted locally.
- Admin and proxy endpoints share one bearer key in this MVP; use separate identities and roles before production.
- Agent skills are operating guidance, not an authorization system.

## Design principles
- Observe before optimizing.
- Missing prices are unknown, not zero.
- Preserve original provider response shape.
- Never silently change model, prompt or parameters.
- Verify savings independently and protect quality.
