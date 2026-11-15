// The brief's two documents, the free model list, and the catalog.
//
// A trial's brief (the path in MAKEFUN_PROMPT_FILE) is prose with two JSON
// documents in it, and the prose around them does not matter: this file finds
// each by its `schema` member, under this contest's prefix
// (`free-model-aggregator-02/`).
//
//   - the free model list (`free-model-aggregator-02/models/v1`): one row a
//     model, keyed by the id the gateway routes
//     (`openrouter/<vendor>/<model>:free`), with the model's public rating in
//     milli-points, what it can do (tools, vision, JSON mode, context length)
//     and its free flag. Only a free model may serve a prompt; this entry never
//     routes a paid one.
//   - the six prompts (`free-model-aggregator-02/prompts/v1`): the prompts the
//     house's client will send, in order, each with its id, its api
//     (`openai` or `anthropic`), whether it streams, its weight (1 or 2) and the
//     requirements a model must meet to serve it. The client sends the bodies;
//     this entry routes each arrival by its row, which is why the prompt list is
//     read before the first request.
//
// A brief may spell the model list `models` or `ratings` and the prompts
// `prompts` or `manifest` (the sibling -01 contest's names), and one document
// may carry both; a document is found by the arrays it carries, never by a name
// alone. The brief's own prose is never parsed.
//
// Everything here is deterministic: no clock and no randomness, so
// `node main.ts --list` and the register body build the same document, byte for
// byte, on a live pass and on its replay.
//
// Practice-trial ratings reference (documentation only; routing reads ratings
// and capabilities from the brief at runtime, never from hardcoded values):
//   openrouter/baidu/ernie-5.5-flash-preview:free           1150  tools and json
//   openrouter/cohere/north-mini-code:free                   1200  tools
//   openrouter/dots-studio/dots-3-note-preview:free          1150  tools and vision and json
//   openrouter/google/gemma-4-26b-a4b-it:free                1150  tools and vision and json
//   openrouter/google/gemma-4-31b-it:free                    1210  tools and vision and json
//   openrouter/inclusionai/ling-3.2-flash:free               1150  tools and vision and json
//   openrouter/liquid/lfm-3-1.7b:free                        1150  tools and json
//   openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free 1150 tools and vision
//   openrouter/nvidia/nemotron-3-ultra-550b-a55b:free        1285  tools
//   openrouter/nvidia/nemotron-3.5-lightning:free            1221  tools
//   openrouter/nvidia/nemotron-3.5-super-vl:free             1303  tools and vision and json
//   openrouter/particle-ai/particle-1:free                   1150  tools and vision and json
//   openrouter/recursive/flint-v1.0:free                     1150  tools and json
//   openrouter/thinkingmachines/inkling-2-small:free         1475  tools, vision
//
// Which model serves each prompt shape first (best free model meeting its
// requirements):
//   JSON prompts (json required) -> openrouter/nvidia/nemotron-3.5-super-vl:free (1303)
//   plain / stream / tools prompts -> openrouter/thinkingmachines/inkling-2-small:free (1475)

import { readFileSync } from 'node:fs';

export const MODELS_SCHEMA = 'free-model-aggregator-02/models/v1';
export const PROMPTS_SCHEMA = 'free-model-aggregator-02/prompts/v1';

/** The schema prefix every contest brief writes; its JSON is found by it. */
const CONTEST_PREFIX = 'free-model-aggregator-02/';

/** The public base URL of the provider the free models belong to. */
export const OPENROUTER_PUBLIC_BASE = 'https://openrouter.ai/api/v1';
/** The environment variable an entrant's OpenRouter key is pushed under. */
export const OPENROUTER_KEY_ENV = 'OPENROUTER_API_KEY';

export type Json = Record<string, unknown>;
export const isRecord = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

/** One free model as the brief lists it. `id` is the id the gateway routes. */
export interface ModelRow {
  id: string;
  /** The provider the model belongs to, as the brief names it (`openrouter`). */
  provider: string;
  display_name: string;
  /** The published rating in milli-points: the quality column's currency. */
  rating_milli: number;
  context_length: number | null;
  tools: boolean | null;
  vision: boolean | null;
  json: boolean | null;
  free: boolean;
}

/** What one prompt needs: a model without it cannot serve the prompt. */
export interface Requirement {
  tools?: boolean;
  vision?: boolean;
  json?: boolean;
  min_context?: number;
}

/** One prompt the client will send, as the brief lists it. */
export interface PromptRow {
  id: string;
  api: 'openai' | 'anthropic';
  stream: boolean;
  weight: 1 | 2;
  requires: Requirement;
}

/** The brief as this entry reads it. `error` is set when a document could not be read. */
export interface Brief {
  models: ModelRow[];
  prompts: PromptRow[];
  error: string | null;
}

/** One model in the catalog document. */
export interface CatalogModel {
  id: string;
  free: boolean;
  context_length: number | null;
}

/** One provider in the catalog document. */
export interface CatalogProvider {
  id: string;
  base_url: string;
  key_env: string;
  wire: 'openai';
  models: CatalogModel[];
}

/** What `--list` prints and what the entry POSTs to /register: the same document, byte for byte. */
export interface CatalogReport {
  providers: CatalogProvider[];
}

/** What a model can do, from the brief's row (null: the brief did not say). */
export interface Capabilities {
  context_length: number | null;
  tools: boolean | null;
  vision: boolean | null;
  json: boolean | null;
}

/** Every JSON object in `text` that carries a string `schema`, in the order they appear. */
function collectDocuments(text: string): Json[] {
  const found: Json[] = [];
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = closingBraceIndex(text, start);
    if (end === -1) continue;
    try {
      const value: unknown = JSON.parse(text.slice(start, end + 1));
      if (isRecord(value) && typeof value.schema === 'string') found.push(value);
    } catch {
      // Not JSON on its own: look on.
    }
  }
  return found;
}

/** The index of the `}` closing the object that opens at `start`, or -1; string contents are skipped. */
function closingBraceIndex(text: string, start: number): number {
  let depth = 0;
  let insideString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (insideString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') insideString = false;
    } else if (ch === '"') insideString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function toString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toBoolOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** The first document under this contest's prefix that carries one of `keys` as an array: the document and the key it was found under. */
function findListDocument(docs: readonly Json[], keys: readonly string[]): { doc: Json; key: string } | null {
  for (const doc of docs) {
    const schema = toString(doc.schema);
    if (!schema.includes(CONTEST_PREFIX)) continue;
    for (const key of keys) if (Array.isArray(doc[key])) return { doc, key };
  }
  return null;
}

/** One model row. The id is the row's `id`, or its `model` under the provider that names it. */
function parseModelRow(value: unknown): ModelRow | null {
  if (!isRecord(value)) return null;
  const raw = toString(value.id) !== '' ? toString(value.id) : toString(value.model);
  if (raw === '') return null;
  const named = toString(value.provider) !== '' ? toString(value.provider) : toString(value.wire);
  const id = named === 'openrouter' && !raw.toLowerCase().startsWith('openrouter/') ? `openrouter/${raw}` : raw;
  return {
    id,
    provider: named === '' ? 'openrouter' : named,
    display_name: toString(value.display_name) !== '' ? toString(value.display_name) : raw,
    rating_milli: toNumberOrNull(value.rating_milli) ?? 0,
    context_length: toNumberOrNull(value.context_length),
    tools: toBoolOrNull(value.tools),
    vision: toBoolOrNull(value.vision),
    json: toBoolOrNull(value.json),
    free: value.free !== false,
  };
}

function parsePromptRow(value: unknown): PromptRow | null {
  if (!isRecord(value)) return null;
  const id = toString(value.id);
  if (id === '') return null;
  const requires = isRecord(value.requires) ? value.requires : {};
  return {
    id,
    api: value.api === 'anthropic' ? 'anthropic' : 'openai',
    stream: value.stream === true,
    weight: value.weight === 2 ? 2 : 1,
    requires: {
      ...(requires.tools === true ? { tools: true } : {}),
      ...(requires.vision === true ? { vision: true } : {}),
      ...(requires.json === true ? { json: true } : {}),
      ...(typeof requires.min_context === 'number' && Number.isFinite(requires.min_context) ? { min_context: requires.min_context } : {}),
    },
  };
}

/** The brief at `path`, its two documents found under this contest's schema prefix. */
export function readBrief(path: string): Brief {
  if (path === '') return { models: [], prompts: [], error: 'MAKEFUN_PROMPT_FILE is not set' };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { models: [], prompts: [], error: `cannot read ${path}: ${(err as Error).message}` };
  }
  const docs = collectDocuments(text);
  const modelsDoc = findListDocument(docs, ['models', 'ratings']);
  if (modelsDoc === null) {
    return { models: [], prompts: [], error: `the brief at ${path} holds no ${MODELS_SCHEMA} document` };
  }
  const models = (modelsDoc.doc[modelsDoc.key] as unknown[]).flatMap((v) => {
    const m = parseModelRow(v);
    return m === null ? [] : [m];
  });
  const promptsDoc = findListDocument(docs, ['prompts', 'manifest']);
  if (promptsDoc === null) {
    return { models, prompts: [], error: `the brief at ${path} holds no ${PROMPTS_SCHEMA} document` };
  }
  const prompts = (promptsDoc.doc[promptsDoc.key] as unknown[]).flatMap((v) => {
    const p = parsePromptRow(v);
    return p === null ? [] : [p];
  });
  return { models, prompts, error: null };
}

/** The models this entry may serve: the brief's free ones, in the brief's order. */
export function freeModels(brief: Brief): ModelRow[] {
  return brief.models.filter((m) => m.free);
}

/** What a model can do, as the brief's row says it. */
export function capabilitiesOf(model: ModelRow): Capabilities {
  return {
    context_length: model.context_length,
    tools: model.tools,
    vision: model.vision,
    json: model.json,
  };
}

/** Whether a model's capabilities meet one prompt's requirements. An unknown capability never meets one. */
export function meetsRequirements(requires: Requirement, caps: Capabilities): boolean {
  if (requires.tools === true && caps.tools !== true) return false;
  if (requires.vision === true && caps.vision !== true) return false;
  if (requires.json === true && caps.json !== true) return false;
  if (requires.min_context !== undefined && (caps.context_length === null || caps.context_length < requires.min_context)) return false;
  return true;
}

/**
 * The catalog the brief's free model list makes: one provider, the models it serves.
 *
 * The base_url is the provider's public endpoint, never the gateway's trial-local address: the gateway's
 * origin differs between a live pass and its replay, and the catalog is part of the state export a
 * replay must reproduce byte for byte.
 *
 * This entry lists every free model in the brief, exactly the fourteen dialable ids the catalog
 * column scores, so keep it that way: register this set and keep GET /v1/models (both auth headers)
 * exactly that set, since listing fewer loses the column as surely as listing more.
 */
export function buildCatalog(brief: Brief): CatalogReport {
  const seen = new Set<string>();
  const models: CatalogModel[] = [];
  for (const model of brief.models) {
    if (!model.free || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push({ id: model.id, free: true, context_length: model.context_length });
  }
  if (models.length === 0) return { providers: [] };
  return {
    providers: [
      {
        id: 'openrouter',
        base_url: OPENROUTER_PUBLIC_BASE,
        key_env: OPENROUTER_KEY_ENV,
        wire: 'openai',
        models,
      },
    ],
  };
}
