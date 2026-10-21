# Anthropic stream fixtures

Server-sent-event streams replayed through the SDK's `fetch` option in `anthropic.test.ts`, so the tests exercise the real SDK stream parser without network access.

These are **synthetic**: hand-built in the documented SSE format (`message_start` → content blocks → `message_delta` → `message_stop`) because no API key was available when they were written. Replace them with real recordings by running, with a key set:

```sh
ANTHROPIC_API_KEY=... node packages/providers/scripts/record-fixtures.mjs
```
