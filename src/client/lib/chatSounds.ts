import type { ChatSoundId, ChatSoundPreference } from "../stores/chatSoundPreferencesStore"

const CHAT_SOUND_SRC: Record<ChatSoundId, string> = {
  blow: "/chat-sounds/Blow.mp3",
  bottle: "/chat-sounds/Bottle.mp3",
  frog: "/chat-sounds/Frog.mp3",
  funk: "/chat-sounds/Funk.mp3",
  glass: "/chat-sounds/Glass.mp3",
  ping: "/chat-sounds/Ping.mp3",
  pop: "/chat-sounds/Pop.mp3",
  purr: "/chat-sounds/Purr.mp3",
  tink: "/chat-sounds/Tink.mp3",
}

export function isBrowserUnfocused(doc: Pick<Document, "visibilityState" | "hasFocus"> = document) {
  return doc.visibilityState !== "visible" || !doc.hasFocus()
}

// Sounds go through the Web Audio API rather than an <audio> element. A playing
// HTMLMediaElement registers the tab as the system's "Now Playing" source, which
// steals the media keys from whatever was playing (Spotify, Music, …) and makes
// play/pause re-trigger the notification instead of resuming the user's audio.
// AudioBufferSourceNode playback is not reported to the OS media session.
let audioContext: AudioContext | null = null
const bufferCache = new Map<ChatSoundId, Promise<AudioBuffer>>()

function getAudioContext() {
  if (!audioContext) {
    audioContext = new AudioContext()
  }
  return audioContext
}

function loadChatSoundBuffer(soundId: ChatSoundId) {
  let pending = bufferCache.get(soundId)
  if (!pending) {
    pending = fetch(CHAT_SOUND_SRC[soundId])
      .then((response) => {
        if (!response.ok) throw new Error(`Failed to load chat sound: ${response.status}`)
        return response.arrayBuffer()
      })
      .then((bytes) => getAudioContext().decodeAudioData(bytes))
    pending.catch(() => bufferCache.delete(soundId))
    bufferCache.set(soundId, pending)
  }
  return pending
}

async function playSingleChatSound(soundId: ChatSoundId) {
  const context = getAudioContext()
  const buffer = await loadChatSoundBuffer(soundId)
  if (context.state === "suspended") {
    await context.resume()
  }
  await new Promise<void>((resolve) => {
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    source.onended = () => {
      source.disconnect()
      resolve()
    }
    source.start()
  })
}

export async function playChatNotificationSound(soundId: ChatSoundId, count: number) {
  if (count <= 0) {
    return
  }

  const tasks = Array.from({ length: count }, (_, index) => new Promise<void>((resolve) => {
    window.setTimeout(() => {
      void playSingleChatSound(soundId).catch(() => undefined).finally(() => resolve())
    }, index * 90)
  }))

  await Promise.all(tasks)
}

export function shouldPlayChatSound(
  preference: ChatSoundPreference,
  doc: Pick<Document, "visibilityState" | "hasFocus"> = document
) {
  if (preference === "never") return false
  if (preference === "always") return true
  return isBrowserUnfocused(doc)
}
