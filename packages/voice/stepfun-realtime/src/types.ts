/**
 * StepAudio 3 Realtime wire vocabulary (WebSocket events, both directions).
 * Types only; the session maps these onto typed callbacks.
 *
 * Source of truth: the StepFun open-platform realtime guide and API reference
 * (`platform.stepfun.com/docs/zh/guides/models/stepaudio-3-realtime`, 2026-09).
 *
 * @module dsh-stepfun-realtime/types
 */

/** Client → server: replace the session configuration. */
export interface SessionUpdateEvent {
  event_id?: string
  type: 'session.update'
  session: SessionConfig
}

/** The `session` object carried by {@link SessionUpdateEvent}. */
export interface SessionConfig {
  /** System instructions for the voice model's own turns. */
  instructions?: string
  /** Voice name the model speaks with. */
  voice?: string
  /** Output modalities requested for model turns. */
  modalities?: readonly ('text' | 'audio')[]
  /** Input audio container; this client speaks `pcm16`. */
  input_audio_format?: 'pcm16'
  /** Output audio container; this client consumes `pcm16`. */
  output_audio_format?: 'pcm16'
  /** Server-side voice-activity detection over the appended input buffer. */
  turn_detection?: { type: 'server_vad' } | null
  /** Sampling rate of input audio in Hz. */
  input_audio_transcription?: { model?: string } | null
}

/** Client → server: append base64 PCM16 frames to the input buffer. */
export interface InputAudioBufferAppendEvent {
  event_id?: string
  type: 'input_audio_buffer.append'
  audio: string
}

/** Client → server: close the input buffer early (manual turn commit). */
export interface InputAudioBufferCommitEvent {
  event_id?: string
  type: 'input_audio_buffer.commit'
}

/** Client → server: clear the un-committed input buffer. */
export interface InputAudioBufferClearEvent {
  event_id?: string
  type: 'input_audio_buffer.clear'
}

/** Client → server: ask for one model response over the current conversation. */
export interface ResponseCreateEvent {
  event_id?: string
  type: 'response.create'
  response: {
    modalities?: readonly ('text' | 'audio')[]
    /** Spoken input injected as a conversation item instead of a free prompt patch. */
    input?: readonly { type: 'text'; text: string }[]
    /** One-shot instructions for this response only. */
    instructions?: string
  }
}

/** Client → server: cancel the response currently streaming. */
export interface ResponseCancelEvent {
  event_id?: string
  type: 'response.cancel'
}

/** Every event this client sends. */
export type ClientEvent =
  | SessionUpdateEvent
  | InputAudioBufferAppendEvent
  | InputAudioBufferCommitEvent
  | InputAudioBufferClearEvent
  | ResponseCreateEvent
  | ResponseCancelEvent

/** Server → client: the session configuration was applied. */
export interface SessionCreatedEvent {
  type: 'session.created'
  session: unknown
}

/** Server → client: speech started in the input buffer (barge-in anchor). */
export interface SpeechStartedEvent {
  type: 'input_audio_buffer.speech_started'
  audio_start_ms: number
}

/** Server → client: speech stopped; the utterance is complete. */
export interface SpeechStoppedEvent {
  type: 'input_audio_buffer.speech_stopped'
  audio_end_ms: number
}

/** Server → client: finalized transcript of one user utterance. */
export interface InputTranscriptCompletedEvent {
  type: 'conversation.item.input_audio_transcript.completed'
  transcript: string
}

/** Server → client: the user utterance could not be transcribed. */
export interface InputTranscriptFailedEvent {
  type: 'conversation.item.input_audio_transcript.failed'
  error: RealtimeErrorPayload
}

/** Server → client: incremental text of the model's spoken turn. */
export interface AudioTranscriptDeltaEvent {
  type: 'response.audio_transcript.delta'
  delta: string
}

/** Server → client: incremental base64 PCM16 audio of the model's turn. */
export interface AudioDeltaEvent {
  type: 'response.audio.delta'
  delta: string
}

/** Server → client: the model's response finished. */
export interface ResponseDoneEvent {
  type: 'response.done'
}

/** Server → client: the model's response was cancelled before finishing. */
export interface ResponseCancelledEvent {
  type: 'response.cancelled'
}

/** Server → client error payload shape. */
export interface RealtimeErrorPayload {
  type?: string
  code?: string
  message?: string
}

/** Server → client: protocol or transport error. */
export interface RealtimeErrorEvent {
  type: 'error'
  error: RealtimeErrorPayload
}

/** Every event this client consumes. */
export type ServerEvent =
  | SessionCreatedEvent
  | SpeechStartedEvent
  | SpeechStoppedEvent
  | InputTranscriptCompletedEvent
  | InputTranscriptFailedEvent
  | AudioTranscriptDeltaEvent
  | AudioDeltaEvent
  | ResponseDoneEvent
  | ResponseCancelledEvent
  | RealtimeErrorEvent
