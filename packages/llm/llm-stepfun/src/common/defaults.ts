/** Shared StepFun provider limits. */

/** Default combined request/response context capacity (step-5-preview window). */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000
/** Default per-request output-token cap. */
export const DEFAULT_MAX_TOKENS = 65_536
/** Default maximum idle interval while an adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
/** Default bound on accumulated base64 image payload per request. */
export const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024
/** Deterministic base64-byte removal step after the bound is exceeded. */
export const DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM = 5 * 1024 * 1024
/** Deterministic image-count removal step. */
export const DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM = 10
/** Default per-image encoded-byte cap for image-capable catalog models. */
export const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 10 * 1024 * 1024
/** Step Plan subscription channel root for OpenAI-compatible chat requests. */
export const STEP_PLAN_BASE_URL = 'https://api.stepfun.com/step_plan/v1'