/** `voice` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'dock.mic.label': '开始语音对话',
  'dock.mic.active': '语音进行中——点击停止',
  'dock.stop.label': '停止语音',
  'state.listening': '正在听',
  'state.thinking': '思考中',
  'state.speaking': '回答中',
  'state.idle': '语音已关闭',
  'captions.empty': '说点什么即可开始…',
  'model.pinned': '实时模型',
  'error.prefix': '语音错误',
} satisfies Record<string, string>

/** The voice namespace key union. */
export type VoiceKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'dock.mic.label': 'Start voice conversation',
  'dock.mic.active': 'Voice active — click to stop',
  'dock.stop.label': 'Stop voice',
  'state.listening': 'Listening',
  'state.thinking': 'Thinking',
  'state.speaking': 'Speaking',
  'state.idle': 'Voice off',
  'captions.empty': 'Say something to begin…',
  'model.pinned': 'Realtime model',
  'error.prefix': 'Voice error',
} satisfies Record<VoiceKey, string>
