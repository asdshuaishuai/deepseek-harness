/** Default StepFun model catalogs; deployments may replace them through configuration. */
import type { StepFunCatalogModel } from './types.ts'

/**
 * Advisory StepFun entries, flagship first: `step-5-preview` is this harness's
 * main model (agentic work with a 1M-token window, native image input, and
 * selectable reasoning efforts), `step-3` the text-only fallback. Modalities
 * name what this adapter ships: the platform additionally accepts video
 * input, which the harness's attachment pipeline does not carry yet.
 */
export const DEFAULT_MODELS: StepFunCatalogModel[] = [
  {
    id: 'step-5-preview',
    name: 'Step 5 Preview',
    description: 'Flagship agentic model: text and image input, 1M-token context, selectable reasoning efforts, strong tool use.',
    contextWindow: 1_000_000,
    inputModalities: ['text', 'image'],
    reasoningEfforts: ['low', 'medium', 'high'],
  },
  {
    id: 'step-3',
    name: 'Step 3',
    description: 'Text-only general model for lighter or cost-sensitive turns.',
  },
]

/**
 * Advisory entries for the Step Plan subscription channel: the same flagship
 * plus the flash family and the complexity router that channel exposes.
 */
export const STEP_PLAN_MODELS: StepFunCatalogModel[] = [
  {
    id: 'step-5-preview',
    name: 'Step 5 Preview',
    description: 'Flagship agentic model: text and image input, 1M-token context, selectable reasoning efforts, strong tool use.',
    contextWindow: 1_000_000,
    inputModalities: ['text', 'image'],
    reasoningEfforts: ['low', 'medium', 'high'],
  },
  {
    id: 'step-3.7-flash',
    name: 'Step 3.7 Flash',
    description: 'Plan-channel multimodal reasoning model: image input, 256K context, selectable reasoning efforts.',
    contextWindow: 262_144,
    inputModalities: ['text', 'image'],
    reasoningEfforts: ['low', 'medium', 'high'],
  },
  {
    id: 'step-3.5-flash',
    name: 'Step 3.5 Flash',
    description: 'Plan-channel language model: 256K context, tool calling, 11B active parameters per turn.',
    contextWindow: 262_144,
  },
  {
    id: 'step-3.5-flash-2603',
    name: 'Step 3.5 Flash (Agent)',
    description: 'Plan-channel agent-optimized Step 3.5 Flash: 256K context, low/high reasoning efforts.',
    contextWindow: 262_144,
    reasoningEfforts: ['low', 'high'],
  },
  {
    id: 'step-router-v1',
    name: 'Step Router',
    description: 'Plan-channel routing model: sends each turn to step-5-preview or step-3.5-flash by task complexity.',
  },
]
