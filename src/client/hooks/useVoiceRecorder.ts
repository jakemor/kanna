import { useCallback, useEffect, useRef, useState } from "react"
import { useVoiceDictationStore } from "../stores/voiceDictationStore"

export type VoiceRecorderStatus = "idle" | "recording" | "transcribing"

interface UseVoiceRecorderOptions {
  onTranscription: (text: string) => void
  onError: (message: string) => void
}

interface UseVoiceRecorderResult {
  status: VoiceRecorderStatus
  isAvailable: boolean
  startRecording: () => void
  stopRecording: () => void
}

function getSupportedMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ]
  for (const mime of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mime)) {
      return mime
    }
  }
  return ""
}

function getFileExtension(mimeType: string): string {
  if (mimeType.startsWith("audio/webm")) return ".webm"
  if (mimeType.startsWith("audio/mp4")) return ".mp4"
  if (mimeType.startsWith("audio/ogg")) return ".ogg"
  return ".webm"
}

export function useVoiceRecorder({
  onTranscription,
  onError,
}: UseVoiceRecorderOptions): UseVoiceRecorderResult {
  const [status, setStatus] = useState<VoiceRecorderStatus>("idle")

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const mimeTypeRef = useRef<string>("")

  // Stable refs for callbacks to avoid stale closures
  const onTranscriptionRef = useRef(onTranscription)
  const onErrorRef = useRef(onError)
  useEffect(() => {
    onTranscriptionRef.current = onTranscription
    onErrorRef.current = onError
  }, [onTranscription, onError])

  const voiceDictationEnabled = useVoiceDictationStore((s) => s.voiceDictationEnabled)
  const openaiApiKey = useVoiceDictationStore((s) => s.openaiApiKey)

  const isAvailable =
    voiceDictationEnabled &&
    openaiApiKey.length > 0 &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof MediaRecorder !== "undefined"

  const releaseStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
  }, [])

  const transcribe = useCallback(async (audioBlob: Blob) => {
    setStatus("transcribing")

    const { openaiApiKey: apiKey, voiceDictationLanguage: language } =
      useVoiceDictationStore.getState()

    const extension = getFileExtension(mimeTypeRef.current)
    const formData = new FormData()
    formData.append("audio", audioBlob, `recording${extension}`)
    if (language !== "auto") {
      formData.append("language", language)
    }

    try {
      const response = await fetch("/api/transcribe", {
        method: "POST",
        headers: {
          "X-OpenAI-Api-Key": apiKey,
        },
        body: formData,
      })

      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: "Transcription failed" }))
        const message =
          typeof body === "object" && body !== null && "error" in body
            ? String((body as { error: string }).error)
            : "Transcription failed"
        onErrorRef.current(message)
        return
      }

      const result = (await response.json()) as { text: string }
      if (result.text && result.text.trim().length > 0) {
        onTranscriptionRef.current(result.text.trim())
      }
    } catch {
      onErrorRef.current("Failed to reach transcription server")
    } finally {
      setStatus("idle")
    }
  }, [])

  const startRecording = useCallback(async () => {
    if (status !== "idle") return

    chunksRef.current = []
    setStatus("recording")

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      const mimeType = getSupportedMimeType()
      mimeTypeRef.current = mimeType

      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream)

      mediaRecorderRef.current = recorder

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data)
        }
      }

      recorder.onstop = () => {
        releaseStream()
        const chunks = chunksRef.current
        if (chunks.length === 0) {
          setStatus("idle")
          return
        }
        const audioBlob = new Blob(chunks, {
          type: mimeTypeRef.current || "audio/webm",
        })
        chunksRef.current = []
        void transcribe(audioBlob)
      }

      recorder.start()
    } catch (err) {
      releaseStream()
      setStatus("idle")

      if (err instanceof DOMException && err.name === "NotAllowedError") {
        onErrorRef.current("Microphone access denied. Check your browser permissions.")
      } else if (err instanceof DOMException && err.name === "NotFoundError") {
        onErrorRef.current("No microphone found. Please connect a microphone.")
      } else {
        onErrorRef.current("Failed to start recording.")
      }
    }
  }, [status, releaseStream, transcribe])

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop()
    } else {
      releaseStream()
      if (status === "recording") {
        setStatus("idle")
      }
    }
  }, [releaseStream, status])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current?.state === "recording") {
        mediaRecorderRef.current.stop()
      }
      releaseStream()
    }
  }, [releaseStream])

  return {
    status,
    isAvailable,
    startRecording: useCallback(() => void startRecording(), [startRecording]),
    stopRecording,
  }
}
