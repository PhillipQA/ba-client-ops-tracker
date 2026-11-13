/**
 * Drives the browser's speech features for the BA Assistant (see voice.ts): the microphone button's dictation, and
 * reading answers aloud. Where a browser has neither, the buttons are simply not shown.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { cleanVoiceLang, dictationProblem, pickVoice, speakable, type VoiceLang } from './voice'

const LANG_KEY = 'ba-assistant-voice-lang'
const ALOUD_KEY = 'ba-assistant-read-aloud'
const saved = (key: string) => {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}
const save = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* The choice then lasts for this visit. */
  }
}
// Not in TypeScript's DOM types: Chrome, Edge and Safari have it, some only under the webkit name.
const recognitionOf = (): any =>
  typeof window === 'undefined'
    ? undefined
    : (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition

export function useVoice() {
  const canListen = Boolean(recognitionOf())
  const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window
  const [lang, setLangState] = useState<VoiceLang>(() => cleanVoiceLang(saved(LANG_KEY)))
  const [readAloud, setReadAloudState] = useState(() => saved(ALOUD_KEY) === '1')
  const [listening, setListening] = useState(false)
  const [speakingId, setSpeakingId] = useState('')
  const [problem, setProblem] = useState('')
  const recognition = useRef<any>(null)

  const stopListening = useCallback(() => {
    recognition.current?.stop()
  }, [])

  /** Starts dictation; `onText` gets everything said so far, each time more is heard. */
  const listen = useCallback(
    (onText: (spoken: string) => void) => {
      const Recognition = recognitionOf()
      if (!Recognition) return
      recognition.current?.abort()
      const session = new Recognition()
      session.lang = lang
      session.continuous = true
      session.interimResults = true
      session.onresult = (event: any) => {
        let spoken = ''
        for (let index = 0; index < event.results.length; index += 1) spoken += event.results[index][0].transcript
        onText(spoken)
      }
      session.onerror = (event: any) => setProblem(dictationProblem(event?.error))
      session.onend = () => {
        if (recognition.current === session) recognition.current = null
        setListening(false)
      }
      recognition.current = session
      setProblem('')
      try {
        session.start()
        setListening(true)
      } catch {
        setListening(false)
      }
    },
    [lang],
  )

  const stopSpeaking = useCallback(() => {
    if (canSpeak) window.speechSynthesis.cancel()
    setSpeakingId('')
  }, [canSpeak])

  /** Reads a text aloud, replacing whatever is being read. `id` says which message it is, for its Stop button. */
  const speak = useCallback(
    (text: string, id: string) => {
      const words = speakable(text)
      if (!canSpeak || !words) return
      window.speechSynthesis.cancel()
      const utterance = new SpeechSynthesisUtterance(words)
      utterance.lang = lang
      const voice = pickVoice(window.speechSynthesis.getVoices(), lang)
      if (voice) utterance.voice = voice
      const done = () => setSpeakingId(current => (current === id ? '' : current))
      utterance.onend = done
      utterance.onerror = done
      setSpeakingId(id)
      window.speechSynthesis.speak(utterance)
    },
    [canSpeak, lang],
  )

  // Leaving the assistant stops the microphone and the reading.
  useEffect(
    () => () => {
      recognition.current?.abort()
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel()
    },
    [],
  )

  return {
    canListen,
    canSpeak,
    lang,
    setLang: (next: string) => {
      const clean = cleanVoiceLang(next)
      setLangState(clean)
      save(LANG_KEY, clean)
    },
    readAloud,
    setReadAloud: (on: boolean) => {
      setReadAloudState(on)
      save(ALOUD_KEY, on ? '1' : '0')
      if (!on) stopSpeaking()
    },
    listening,
    listen,
    stopListening,
    speakingId,
    speak,
    stopSpeaking,
    problem,
  }
}
