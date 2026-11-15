# free-model-aggregator-02

One Node 22 server (stdlib only) that answers the make.fun `free-model-aggregator-02` trial prompts with real completions from the fourteen free OpenRouter models, dialled through the grader's gateway.

## What it does

- `GET /v1/models`: OpenAI list shape for `Authorization: Bearer`, Anthropic list shape for `x-api-key`, both listing exactly the 14 free model ids, once each.
- `POST /v1/chat/completions` and `POST /v1/messages`: JSON and server-sent events, usage and stop reason passed through whole, the dialled id echoed back as `model` on every answer and streamed chunk. Anthropic bodies are translated to Chat Completions and back; every model is dialled only on `POST $OPENAI_BASE_URL/chat/completions` (never Anthropic Messages).
- `node main.ts --list`: prints the same catalog the register body carries, byte for byte, then exits 0.

## Routing

Each request's requirements come from the brief's manifest row in arrival order (falling back to the request body). Among the free models meeting them, the entry ranks by `rating_milli` descending, tie-breaking by model id ascending. So JSON prompts go first to `openrouter/nvidia/nemotron-3.5-super-vl:free` (1303) and plain/stream/tools prompts go first to `openrouter/thinkingmachines/inkling-2-small:free` (1475).

## Failover

On any non-2xx gateway answer or a fetch throw, the refusal is recorded and the next eligible model in rating order is tried for the same prompt. Only a `429` cools a model down for the rest of the trial (never called again). A `401` is treated as key-level: the refusal is recorded and no further model is tried for that prompt. Other refusals do not cool the model down. Total attempts per prompt are capped at the number of eligible models. If every eligible model refuses, the client gets a `502`.

When a prompt is served after one or more refusals, the response carries `x-makefun-upstream-failures` as a JSON array of up to 8 rows `{status, code, model}` in refusal order. `code` is parsed from the gateway error body's `error.code` or `error.type`, else the HTTP status as a string. The header is set on both JSON and SSE responses (SSE: in `writeHead` before streaming).

## Gateway rules

Every dialled id carries the `openrouter/` prefix and is sent as `model` on `POST $OPENAI_BASE_URL/chat/completions` with `Authorization: Bearer $OPENAI_API_KEY`. The body always carries `max_tokens` (or `max_completion_tokens`) between 1 and 8192: none from the client means 1024, above 8192 is clamped to 8192. Client bodies are capped at 8 MiB.

## Determinism

No `Date.now`, `new Date`, `Math.random`, or wall clock in request handling. Routing and failover are pure functions of the brief and the gateway answers seen so far.

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

Start a mock gateway on `POST /chat/completions` and a mock env serving `POST /register` and `GET /work`, point `MAKEFUN_ENV_URL`, `OPENAI_BASE_URL` at them, then hit the entry's `GET /v1/models` and both completion wires with JSON and stream bodies. Confirm the served model, the echoed `model` field, the `x-makefun-upstream-failures` header on a forced 429, and byte-identical answers on repeated identical runs.
