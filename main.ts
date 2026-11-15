// free-model-aggregator-02: aggregate the best free models behind one server.
//
// This entry builds on the starter baseline and improves it:
//   - quality: routes each prompt to the free model that meets its requirements with the
//     highest rating_milli (tie-break by model id ascending, for determinism);
//   - failover: on any refused gateway call, tries the next eligible model in rating order.
//     Only a 429 cools a model down for the rest of the trial. A 401 is a key-level failure:
//     the refusal is recorded and no further model is tried for that prompt. Any other
//     non-2xx or fetch throw is recorded and the next model is tried, without cooling down;
//   - catalog: keeps the fourteen free ids exactly as the starter lists them, once each.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  buildCatalog,
  capabilitiesOf,
  freeModels,
  isRecord,
  meetsRequirements,
  readBrief,
  type CatalogReport,
  type Json,
  type ModelRow,
  type Requirement,
} from './lib/providers.ts';
import {
  anthropicError,
  anthropicEventsFromOpenAI,
  anthropicModelList,
  anthropicToOpenAI,
  openAIError,
  openAIJsonWithModel,
  openAIModelList,
  openAIStreamWithModel,
  openAIToAnthropic,
  type ServedModel,
} from './lib/wire.ts';

/** The wire protocol's version, in the register body. */
const PROTOCOL_VERSION = 1;
/** How often GET /work is polled, in milliseconds. */
const POLL_INTERVAL_MS = 100;
/** The most bytes of one client request body this entry reads. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** The most refusal rows reported on one response header. */
const MAX_FAILURE_ROWS = 8;

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';
const GATEWAY_URL = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
/** The trial's dummy key for the entry's gateway lane; the gateway swaps it for the entrant's own key. */
const GATEWAY_KEY = process.env.OPENAI_API_KEY ?? '';

const brief = readBrief(PROMPT_FILE);
const catalog: CatalogReport = buildCatalog(brief);
/** Which prompt row the request now arriving is: the brief's prompts are in the client's arrival order. */
let manifestIndex = 0;
/** Free models that refused with 429 during this trial: never dialled again for the rest of it. */
const cooledDown = new Set<string>();

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

/** One refusal row reported on x-makefun-upstream-failures. */
interface RefusalRow {
  status: number;
  code: string;
  model: string | null;
}

/**
 * The gateway's Chat Completions route. OPENAI_BASE_URL is the OpenAI-compatible root (`…/v1` on the
 * trial network); a base that does not already end in `/v1` gets one, so both spellings reach the route.
 */
function chatCompletionsUrl(): string {
  if (GATEWAY_URL === '') return '';
  return GATEWAY_URL.endsWith('/v1') ? `${GATEWAY_URL}/chat/completions` : `${GATEWAY_URL}/v1/chat/completions`;
}

/** The free models the brief lists, as GET /v1/models names them. */
function servedModels(): ServedModel[] {
  return freeModels(brief).map((model) => ({ id: model.id, provider: model.provider, display_name: model.display_name }));
}

/** Clamp a whole token cap into the gateway's allowed range [1, 8192]. */
function clampTokens(value: number): number {
  if (value < 1) return 1;
  if (value > 8192) return 8192;
  return value;
}

/**
 * The gateway-shaped body for one dialled model. Always carries max_tokens (or
 * max_completion_tokens) between 1 and 8192: none from the client means 1024, an oversized cap is
 * clamped down. The body is never larger than what the client sent (bounded at 8 MiB by readJson).
 */
function gatewayBody(body: Json, model: string): Json {
  const out: Json = { ...body, model };
  const maxTokens = typeof body.max_tokens === 'number' ? body.max_tokens : undefined;
  const maxCompletion =
    typeof body.max_completion_tokens === 'number' ? body.max_completion_tokens : undefined;
  if (maxTokens === undefined && maxCompletion === undefined) {
    out.max_tokens = 1024;
  } else if (maxTokens !== undefined) {
    out.max_tokens = clampTokens(maxTokens);
  } else {
    out.max_completion_tokens = clampTokens(maxCompletion);
  }
  return out;
}

/**
 * The free models eligible to serve one request: those meeting the requirements, not cooled down
 * during this trial, ranked by rating_milli descending and then by model id ascending for determinism.
 */
function eligibleModels(requires: Requirement): ModelRow[] {
  return freeModels(brief)
    .filter((model) => !cooledDown.has(model.id))
    .filter((model) => meetsRequirements(requires, capabilitiesOf(model)))
    .sort((a, b) => {
      if (b.rating_milli !== a.rating_milli) return b.rating_milli - a.rating_milli;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

/** Dial the gateway's Chat Completions route for one model, returning the response. */
async function dial(model: string, body: Json): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${GATEWAY_KEY}`,
  };
  if (body.stream === true) headers.accept = 'text/event-stream';
  return fetch(chatCompletionsUrl(), { method: 'POST', headers, body: JSON.stringify(body) });
}

/**
 * Read one refusal's `code` from the gateway error body: error.code or error.type when present,
 * else the HTTP status as a string.
 */
function refusalCode(status: number, text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) {
      const error = parsed.error;
      if (isRecord(error)) {
        if (typeof error.code === 'string') return error.code;
        if (typeof error.type === 'string') return error.type;
      }
    }
  } catch {
    // Not JSON: fall through to the status.
  }
  return String(status);
}

/**
 * Try every eligible model in rating order until one answers 2xx. Records each refusal (status, code,
 * model). Only a 429 cools a model down for the rest of this trial. A 401 is a key-level failure:
 * the refusal is recorded and no further model is tried for this prompt. Any other non-2xx or fetch
 * throw is recorded and the next model is tried, without cooling that model down.
 */
async function dialWithFailover(
  buildBody: (model: string) => Json,
  eligible: ModelRow[],
): Promise<{ model: string; response: Response; refusals: RefusalRow[] } | null> {
  const refusals: RefusalRow[] = [];
  for (const model of eligible) {
    let response: Response;
    try {
      response = await dial(model.id, buildBody(model.id));
    } catch {
      refusals.push({ status: 0, code: 'fetch_error', model: model.id });
      continue;
    }
    if (!response.ok || response.body === null) {
      let text = '';
      try {
        text = await response.text();
      } catch {
        // Body unreadable: report with the status only.
      }
      refusals.push({ status: response.status, code: refusalCode(response.status, text), model: model.id });
      if (response.status === 429) {
        cooledDown.add(model.id);
        continue;
      }
      if (response.status === 401) {
        return null;
      }
      continue;
    }
    return { model: model.id, response, refusals };
  }
  return null;
}

/** The requirements of the prompt now arriving: the brief's row by arrival order, else the body's own. */
function requirementsFor(body: Json): Requirement {
  const entry = brief.prompts[manifestIndex];
  manifestIndex += 1;
  if (entry !== undefined) return entry.requires;
  return requirementsFromBody(body);
}

/** Requirements read off a request body, when the brief has no row for it. */
function requirementsFromBody(body: Json): Requirement {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let vision = false;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && (block.type === 'image' || block.type === 'image_url')) vision = true;
    }
  }
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  return { tools: Array.isArray(body.tools) && body.tools.length > 0, vision, json: format === 'json_object' || format === 'json_schema' };
}

/** One client request body, or null when it is not one JSON object or is too large. */
async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...extraHeaders });
  res.end(text);
}

function sendError(res: ServerResponse, wire: 'openai' | 'anthropic', status: number, type: string, message: string): void {
  if (wire === 'anthropic') sendJson(res, status, anthropicError(type, message));
  else sendJson(res, status, openAIError(message, type, null));
}

/** GET /v1/models, in the shape of the auth header the client sent. */
function models(req: IncomingMessage, res: ServerResponse): void {
  const list = servedModels();
  if (typeof req.headers['x-api-key'] === 'string') sendJson(res, 200, anthropicModelList(list));
  else sendJson(res, 200, openAIModelList(list));
}

function failureHeader(refusals: RefusalRow[]): Record<string, string> | {} {
  if (refusals.length === 0) return {};
  return { 'x-makefun-upstream-failures': JSON.stringify(refusals.slice(0, MAX_FAILURE_ROWS)) };
}

/** POST /v1/chat/completions: answered by the best eligible free model, failing over on refusal. */
async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'openai', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const requires = requirementsFor(body);
  const eligible = eligibleModels(requires);
  if (eligible.length === 0) return sendError(res, 'openai', 503, 'no_free_model', 'no free model in the brief meets this request');
  const outcome = await dialWithFailover((model) => gatewayBody({ ...body, model }, model), eligible);
  if (outcome === null) {
    return sendError(res, 'openai', 502, 'upstream_error', 'every eligible model refused this request');
  }
  const { model, response, refusals } = outcome;
  const headers = failureHeader(refusals);
  if (body.stream === true) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...headers });
    try {
      for await (const frame of openAIStreamWithModel(response.body, model)) res.write(frame);
    } finally {
      res.end();
    }
    return;
  }
  const answer: unknown = await response.json();
  sendJson(res, 200, openAIJsonWithModel(isRecord(answer) ? answer : {}, model), headers);
}

/** POST /v1/messages: an Anthropic-shaped client, rewritten to Chat Completions and answered back. */
async function messages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'anthropic', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const requires = requirementsFor(body);
  const eligible = eligibleModels(requires);
  if (eligible.length === 0) return sendError(res, 'anthropic', 503, 'overloaded_error', 'no free model in the brief meets this request');
  const outcome = await dialWithFailover((model) => gatewayBody(anthropicToOpenAI(body, model), model), eligible);
  if (outcome === null) {
    return sendError(res, 'anthropic', 502, 'api_error', 'every eligible model refused this request');
  }
  const { model, response, refusals } = outcome;
  const headers = failureHeader(refusals);
  if (body.stream === true) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...headers });
    try {
      for await (const event of anthropicEventsFromOpenAI(response.body, model)) res.write(event);
    } finally {
      res.end();
    }
    return;
  }
  const answer: unknown = await response.json();
  sendJson(res, 200, openAIToAnthropic(isRecord(answer) ? answer : {}, model), headers);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    models(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    await chat(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    await messages(req, res);
    return;
  }
  sendError(res, url.pathname === '/v1/messages' ? 'anthropic' : 'openai', 404, 'not_found', `no route ${req.method ?? ''} ${url.pathname}`);
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
}

/** POST /register with the port and the one catalog; the env answers with the trial's prompt count. */
async function register(port: number, report: CatalogReport): Promise<void> {
  const res = await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog: report }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`POST ${ENV_URL}/register answered HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const reply: unknown = await res.json();
  if (isRecord(reply) && typeof reply.requests === 'number') log(`registered: the trial holds ${reply.requests} prompts`);
}

/** Poll GET /work every 100 ms; exit 0 the moment it says done. */
function poll(server: Server): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status !== 200) return;
        const work: unknown = await res.json();
        if (isRecord(work) && work.done === true) {
          clearInterval(timer);
          server.close();
          process.exit(0);
        }
      } catch {
        // The env is not reachable yet: try again on the next tick.
      } finally {
        inFlight = false;
      }
    })();
  }, POLL_INTERVAL_MS);
}

async function start(): Promise<void> {
  if (brief.error !== null) log(brief.error);
  if (process.argv.includes('--list')) {
    // The same document the register body carries, byte for byte: print the one built object and stop
    // before any server starts. A process whose stdout is not flushed loses the tail, so wait for it.
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  if (chatCompletionsUrl() === '') throw new Error('OPENAI_BASE_URL is not set');
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) sendError(res, req.url?.startsWith('/v1/messages') === true ? 'anthropic' : 'openai', 500, 'internal_error', 'the server failed to answer');
    });
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  const port = address.port;
  // 8080 is the env's on one layout; the OS's ephemeral range never holds it, and the guard says so.
  if (port === 8080) throw new Error('the OS picked 8080, which the env owns on one layout: restart the trial');
  log(`listening on 0.0.0.0:${port} with ${servedModels().length} free models`);
  await register(port, catalog);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  poll(server);
}

try {
  await start();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}
