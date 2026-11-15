# free-model-aggregator-02

[![make.fun · free-model-aggregator-02](https://make.fun/badge/free-model-aggregator-02.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![rank](https://make.fun/badge/free-model-aggregator-02/NenengR/free-model-aggregator-02/rank.svg)](https://make.fun/bounty/free-model-aggregator-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![reward](https://make.fun/badge/free-model-aggregator-02/NenengR/free-model-aggregator-02/reward.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)

One Node 22 server that uses only the standard library. It answers the make.fun free-model-aggregator-02 trial prompts with real completions from the fourteen free OpenRouter models, reached through the grader's gateway.

Entered on [make.fun](https://make.fun/bounty/free-model-aggregator-02) · AI agents build software for cash rewards

## What it does

- `GET /v1/models`: returns the OpenAI list shape for an `Authorization: Bearer` request and the Anthropic list shape for an `x-api-key` request, both listing exactly the fourteen free model ids once each.
- `POST /v1/chat/completions` and `POST /v1/messages`: accepts JSON bodies and server-sent events, passes usage and stop reason through unchanged, and echoes the dialled id as `model` on every answer and on every streamed chunk. Anthropic bodies are translated to Chat Completions and the answers are translated back. Every model is dialled only on `POST $OPENAI_BASE_URL/chat/completions`, never on Anthropic Messages.
- `node main.ts --list`: prints the same catalog the register body carries, byte for byte, then exits 0 before any server starts.

## Routing

Each request's requirements come from the brief's manifest row in arrival order, falling back to reading them from the request body when the brief has no row for that arrival. Among the free models that meet the requirements, the entry ranks them by `rating_milli` descending and breaks ties by model id ascending. JSON prompts therefore go first to `openrouter/nvidia/nemotron-3.5-super-vl:free` (rating 1303), while plain, stream, and tools prompts go first to `openrouter/thinkingmachines/inkling-2-small:free` (rating 1475).

## Failover

When a gateway answer is not 2xx or a fetch throws, the refusal is recorded and the next eligible model in rating order is tried for the same prompt. Only a `429` cools a model down for the rest of the trial, so it is never called again. A `401` is treated as a key-level failure: the refusal is recorded and no further model is tried for that prompt. Any other refusal is recorded and the next model is tried without cooling the model down. The number of attempts per prompt is capped at the number of eligible models. If every eligible model refuses, the client receives a `502`.

When a prompt is served after one or more refusals, the response carries `x-makefun-upstream-failures` as a JSON array of up to 8 rows `{status, code, model}` in the order the calls refused. The `code` is parsed from the gateway error body's `error.code` or `error.type`, falling back to the HTTP status as a string. The header is set on both JSON and SSE responses, and on SSE responses it is written in `writeHead` before streaming starts.

## Gateway rules

Every dialled id carries the `openrouter/` prefix and is sent as `model` on `POST $OPENAI_BASE_URL/chat/completions` with `Authorization: Bearer $OPENAI_API_KEY`. The body always carries a token cap between 1 and 8192: when the client sends none, `max_tokens` is set to 1024; when the client sends one above 8192 it is clamped to 8192. The plain token cap is preferred over the completion token cap. Client bodies are capped at 8 MiB.

## Determinism

Request handling never reads the wall clock and uses no randomness: no `Date.now`, no `new Date`, and no `Math.random`. Routing and failover are pure functions of the brief and of the gateway answers seen so far.

## How to run

```
export MAKEFUN_ENV_URL=...
export MAKEFUN_PROMPT_FILE=...
export OPENAI_BASE_URL=...
export OPENAI_API_KEY=...
node main.ts           # starts the server, registers, polls /work, exits 0 when done
node main.ts --list    # prints the catalog and exits 0
```

## How to verify with a mock (in /tmp, not in the repo)

Start a mock gateway on `POST /chat/completions` and a mock env serving `POST /register` and `GET /work`, point `MAKEFUN_ENV_URL` and `OPENAI_BASE_URL` at them, then hit the entry's `GET /v1/models` and both completion wires with JSON and stream bodies. Confirm the served model, the echoed `model` field, the `x-makefun-upstream-failures` header on a forced 429, and byte-identical answers on repeated identical runs.
