'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { listenProblem, pickVoice, speakable, takeSentences } from '@/lib/speech';

/**
 * Voice for the chat, with the browser's own speech (the Web Speech API):
 * no key, nothing installed, and nothing sent anywhere by the app. Three uses.
 *
 * Dictation: the microphone fills the question box as the reader speaks.
 *
 * Read aloud: an answer is said, a sentence at a time.
 *
 * Conversation: hands free. The reader speaks; a pause sends it; the answer
 * is said while it is still arriving; then the microphone opens again. The
 * microphone is closed while the app speaks, so it does not hear itself, and
 * the reader can interrupt with a button.
 *
 * What is said and where it is cut is lib/speech.ts, which is checked without
 * a browser. This file is the part that needs one.
 */

// The parts of the Web Speech API this uses. TypeScript's DOM library has the
// speaking half; the listening half is still prefixed in Chrome and Safari.
interface RecognitionAlternative {
  transcript: string;
}
interface RecognitionResult {
  isFinal: boolean;
  0: RecognitionAlternative;
}
interface RecognitionEvent {
  results: ArrayLike<RecognitionResult>;
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** How long a pause ends what the reader was saying, in a conversation. */
const PAUSE_MS = 1600;

export type VoicePhase = 'off' | 'listening' | 'thinking' | 'speaking';

export interface Voice {
  /** What this browser can do. Both false until the page has mounted. */
  canListen: boolean;
  canSpeak: boolean;
  dictating: boolean;
  startDictation: () => void;
  stopDictation: () => void;
  /** Which answer is being read aloud, by the key it was given. */
  reading: string | null;
  read: (key: string, text: string) => void;
  stopReading: () => void;
  /** The conversation: off, or where in its round it is. */
  phase: VoicePhase;
  /** What has been heard of the reader's turn so far. */
  heard: string;
  startConversation: () => void;
  stopConversation: () => void;
  /** Stop speaking and listen again. */
  interrupt: () => void;
  /** A question is going up: the microphone closes until the answer is said. */
  beginAnswer: () => void;
  /** A piece of the answer, as it arrives. Said when a sentence is whole. */
  feed: (chunk: string) => void;
  /** The answer is complete: say what is left, then listen again. */
  finishAnswer: () => void;
  error: string | null;
  clearError: () => void;
}

export function useVoice(handlers: {
  /** Dictation: everything said since the microphone opened, settled and still unsettled. */
  onDictation: (settled: string, unsettled: string) => void;
  /** Conversation: the reader stopped speaking; this is what they said. */
  onUtterance: (text: string) => void;
}): Voice {
  const [canListen, setCanListen] = useState(false);
  const [canSpeak, setCanSpeak] = useState(false);
  const [dictating, setDictating] = useState(false);
  const [reading, setReading] = useState<string | null>(null);
  const [phase, setPhaseState] = useState<VoicePhase>('off');
  const [heard, setHeard] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const phaseRef = useRef<VoicePhase>('off');
  const setPhase = useCallback((next: VoicePhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);
  const recRef = useRef<Recognition | null>(null);
  /** What the open microphone is for. */
  const purposeRef = useRef<'dictate' | 'converse' | null>(null);
  const pauseRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  /** Utterances from before a cancel report their end late; a new generation ignores them. */
  const generationRef = useRef(0);
  const pendingRef = useRef(0);
  const finishedRef = useRef(true);
  const bufferRef = useRef({ text: '', offset: 0 });
  const listenRef = useRef<(purpose: 'dictate' | 'converse') => void>(() => {});

  useEffect(() => {
    setCanListen(recognitionCtor() !== null);
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
    setCanSpeak(Boolean(synth) && typeof SpeechSynthesisUtterance !== 'undefined');
    if (!synth) return;
    const load = (): void => {
      voicesRef.current = synth.getVoices();
    };
    load();
    synth.addEventListener?.('voiceschanged', load);
    return () => synth.removeEventListener?.('voiceschanged', load);
  }, []);

  // ------------------------------------------------------------- listening

  const closeMicrophone = useCallback(() => {
    if (pauseRef.current) clearTimeout(pauseRef.current);
    pauseRef.current = null;
    const rec = recRef.current;
    recRef.current = null;
    purposeRef.current = null;
    if (rec) {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try {
        rec.abort();
      } catch {
        /* it had stopped already */
      }
    }
  }, []);

  const listen = useCallback(
    (purpose: 'dictate' | 'converse') => {
      const Ctor = recognitionCtor();
      if (!Ctor) return;
      closeMicrophone();
      const rec = new Ctor();
      rec.lang = navigator.language || 'en-US';
      rec.continuous = true;
      rec.interimResults = true;
      recRef.current = rec;
      purposeRef.current = purpose;

      rec.onresult = (event) => {
        let settled = '';
        let unsettled = '';
        for (let i = 0; i < event.results.length; i++) {
          const result = event.results[i];
          if (result.isFinal) settled += `${result[0].transcript} `;
          else unsettled += result[0].transcript;
        }
        if (purpose === 'dictate') {
          handlersRef.current.onDictation(settled.trim(), unsettled.trim());
          return;
        }
        const said = `${settled}${unsettled}`.replace(/\s+/g, ' ').trim();
        setHeard(said);
        if (pauseRef.current) clearTimeout(pauseRef.current);
        if (!said) return;
        // A pause after speech is the end of the reader's turn.
        pauseRef.current = setTimeout(() => {
          if (recRef.current !== rec || phaseRef.current !== 'listening') return;
          closeMicrophone();
          setHeard('');
          handlersRef.current.onUtterance(said);
        }, PAUSE_MS);
      };
      rec.onerror = (event) => {
        // Silence and our own closing are not errors.
        if (event.error === 'no-speech' || event.error === 'aborted') return;
        setError(listenProblem(event.error));
        closeMicrophone();
        setDictating(false);
        if (phaseRef.current !== 'off') {
          generationRef.current++;
          window.speechSynthesis?.cancel();
          setPhase('off');
        }
      };
      rec.onend = () => {
        if (recRef.current !== rec) return;
        recRef.current = null;
        if (purpose === 'dictate') {
          purposeRef.current = null;
          setDictating(false);
          return;
        }
        // The browser closes the microphone after a silence. In a conversation it is opened again.
        if (phaseRef.current === 'listening') listenRef.current('converse');
      };
      try {
        rec.start();
      } catch {
        recRef.current = null;
        setError(listenProblem('start'));
        setDictating(false);
      }
    },
    [closeMicrophone, setPhase],
  );
  listenRef.current = listen;

  const startDictation = useCallback(() => {
    if (phaseRef.current !== 'off') return;
    setError(null);
    setDictating(true);
    listen('dictate');
  }, [listen]);

  const stopDictation = useCallback(() => {
    if (purposeRef.current !== 'dictate') return;
    const rec = recRef.current;
    // Stopped, not aborted: what was being said is still settled and delivered.
    try {
      rec?.stop();
    } catch {
      closeMicrophone();
    }
    setDictating(false);
  }, [closeMicrophone]);

  // -------------------------------------------------------------- speaking

  const drained = useCallback(() => {
    setReading(null);
    if (phaseRef.current === 'thinking' || phaseRef.current === 'speaking') {
      bufferRef.current = { text: '', offset: 0 };
      setPhase('listening');
      listenRef.current('converse');
    }
  }, [setPhase]);

  const say = useCallback(
    (text: string) => {
      const synth = window.speechSynthesis;
      if (!synth || !text) return;
      const generation = generationRef.current;
      const utterance = new SpeechSynthesisUtterance(text);
      const chosen = pickVoice(voicesRef.current, navigator.language || 'en-US');
      if (chosen >= 0) {
        utterance.voice = voicesRef.current[chosen];
        utterance.lang = voicesRef.current[chosen].lang;
      }
      utterance.rate = 1.03;
      const over = (): void => {
        if (generation !== generationRef.current) return;
        pendingRef.current = Math.max(0, pendingRef.current - 1);
        if (pendingRef.current === 0 && finishedRef.current) drained();
      };
      utterance.onstart = () => {
        if (generation === generationRef.current && phaseRef.current === 'thinking') setPhase('speaking');
      };
      utterance.onend = over;
      utterance.onerror = over;
      pendingRef.current++;
      synth.speak(utterance);
    },
    [drained, setPhase],
  );

  const silence = useCallback(() => {
    generationRef.current++;
    pendingRef.current = 0;
    finishedRef.current = true;
    bufferRef.current = { text: '', offset: 0 };
    window.speechSynthesis?.cancel();
  }, []);

  const read = useCallback(
    (key: string, text: string) => {
      if (phaseRef.current !== 'off') return;
      silence();
      const pieces = takeSentences(text, 0, true).sentences.map(speakable).filter(Boolean);
      if (pieces.length === 0) return;
      finishedRef.current = false;
      setReading(key);
      for (const piece of pieces) say(piece);
      finishedRef.current = true;
    },
    [say, silence],
  );

  const stopReading = useCallback(() => {
    silence();
    setReading(null);
  }, [silence]);

  // ---------------------------------------------------------- conversation

  const startConversation = useCallback(() => {
    setError(null);
    closeMicrophone();
    setDictating(false);
    silence();
    setReading(null);
    // Said from the click, so that browsers which only let a page speak after
    // one let this page speak later, when the answer comes.
    try {
      window.speechSynthesis?.speak(new SpeechSynthesisUtterance(''));
    } catch {
      /* it will say so when it cannot speak */
    }
    setHeard('');
    setPhase('listening');
    listen('converse');
  }, [closeMicrophone, listen, setPhase, silence]);

  const stopConversation = useCallback(() => {
    setPhase('off');
    closeMicrophone();
    silence();
    setHeard('');
  }, [closeMicrophone, setPhase, silence]);

  const interrupt = useCallback(() => {
    if (phaseRef.current === 'off') return;
    silence();
    setHeard('');
    setPhase('listening');
    listen('converse');
  }, [listen, setPhase, silence]);

  const beginAnswer = useCallback(() => {
    if (purposeRef.current === 'dictate') {
      closeMicrophone();
      setDictating(false);
    }
    if (phaseRef.current === 'off') return;
    closeMicrophone();
    silence();
    finishedRef.current = false;
    setHeard('');
    setPhase('thinking');
  }, [closeMicrophone, setPhase, silence]);

  const feed = useCallback(
    (chunk: string) => {
      if (phaseRef.current !== 'thinking' && phaseRef.current !== 'speaking') return;
      const buffer = bufferRef.current;
      buffer.text += chunk;
      const { sentences, next } = takeSentences(buffer.text, buffer.offset, false);
      buffer.offset = next;
      for (const sentence of sentences) say(speakable(sentence));
    },
    [say],
  );

  const finishAnswer = useCallback(() => {
    if (phaseRef.current !== 'thinking' && phaseRef.current !== 'speaking') return;
    const buffer = bufferRef.current;
    const { sentences, next } = takeSentences(buffer.text, buffer.offset, true);
    buffer.offset = next;
    for (const sentence of sentences) say(speakable(sentence));
    finishedRef.current = true;
    if (pendingRef.current === 0) drained();
  }, [drained, say]);

  // Leaving the page closes the microphone and stops the voice.
  useEffect(
    () => () => {
      closeMicrophone();
      generationRef.current++;
      if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
    },
    [closeMicrophone],
  );

  return {
    canListen,
    canSpeak,
    dictating,
    startDictation,
    stopDictation,
    reading,
    read,
    stopReading,
    phase,
    heard,
    startConversation,
    stopConversation,
    interrupt,
    beginAnswer,
    feed,
    finishAnswer,
    error,
    clearError: () => setError(null),
  };
}
