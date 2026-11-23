import { useState, useEffect, useRef, useCallback } from 'react';
import { synthesizeSpeechAudio } from '../services/api';

function base64ToUint8Array(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Dedicated Voice Audio Service supporting:
 * 1. High-fidelity Gemini 3.8 Neural TTS via Blob URL + unlocked Web Audio API fallback
 * 2. Browser SpeechSynthesis API fallback only when server TTS is unavailable
 * 3. Play, Pause, Resume, Stop controls and real speaking status
 */
export function useVoiceAudio() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [activeVoice, setActiveVoice] = useState(null);
  const [availableVoices, setAvailableVoices] = useState([]);

  const audioRef = useRef(null);
  const blobUrlRef = useRef(null);
  const audioCtxRef = useRef(null);
  const sourceNodeRef = useRef(null);
  const currentUtteranceRef = useRef(null);
  const wavCacheRef = useRef(new Map());
  const playTokenRef = useRef(0);

  useEffect(() => {
    if ('speechSynthesis' in window) {
      const loadVoices = () => {
        const v = window.speechSynthesis.getVoices();
        setAvailableVoices(v);
      };
      loadVoices();
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }

    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
      }
    };
  }, []);

  const ensureUnlockedAudioContext = useCallback(() => {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
        audioCtxRef.current = new AudioCtx();
      }
      if (audioCtxRef.current.state === 'suspended') {
        audioCtxRef.current.resume().catch(() => {});
      }
      return audioCtxRef.current;
    } catch {
      return null;
    }
  }, []);

  const stop = useCallback(() => {
    playTokenRef.current += 1;
    ensureUnlockedAudioContext();

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
    if (sourceNodeRef.current) {
      try {
        sourceNodeRef.current.stop();
      } catch {
        // ignore if already stopped
      }
      sourceNodeRef.current = null;
    }
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    setIsPlaying(false);
    setIsPaused(false);
  }, [ensureUnlockedAudioContext]);

  const pause = useCallback(() => {
    if (audioRef.current && !audioRef.current.paused) {
      audioRef.current.pause();
      setIsPaused(true);
    } else if ('speechSynthesis' in window && window.speechSynthesis.speaking) {
      window.speechSynthesis.pause();
      setIsPaused(true);
    }
  }, []);

  const resume = useCallback(() => {
    if (audioRef.current && audioRef.current.paused) {
      audioRef.current.play();
      setIsPaused(false);
    } else if ('speechSynthesis' in window && window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
      setIsPaused(false);
    }
  }, []);

  const playBrowserTTS = useCallback((text, langCode) => {
    if (!('speechSynthesis' in window) || !text) return;

    const cleanText = text
      .replace(/[*#_`~>]/g, '')
      .replace(/https?:\/\/\S+/g, 'official portal')
      .replace(/\[.*?\]/g, '')
      .trim();

    if (!cleanText) return;

    const utterance = new SpeechSynthesisUtterance(cleanText);
    currentUtteranceRef.current = utterance;

    const localeMap = {
      te: 'te-IN',
      hi: 'hi-IN',
      en: 'en-IN',
      ta: 'ta-IN',
      kn: 'kn-IN',
      ml: 'ml-IN',
      bn: 'bn-IN',
      gu: 'gu-IN',
      pa: 'pa-IN',
      mr: 'mr-IN',
      ur: 'ur-PK',
    };
    const short = String(langCode || 'en').split('-')[0];
    const bcpLang = String(langCode).includes('-') ? langCode : localeMap[short] || 'en-IN';
    utterance.lang = bcpLang;

    const voice = availableVoices.find(v => v.lang === bcpLang || v.lang.startsWith(short));
    if (voice) {
      utterance.voice = voice;
      setActiveVoice(voice.name);
    }

    utterance.rate = 0.95;
    utterance.pitch = 1.0;

    utterance.onstart = () => {
      setIsPlaying(true);
      setIsPaused(false);
    };

    utterance.onend = () => {
      setIsPlaying(false);
      setIsPaused(false);
    };

    utterance.onerror = () => {
      setIsPlaying(false);
      setIsPaused(false);
    };

    window.speechSynthesis.speak(utterance);
  }, [availableVoices]);

  const playViaWebAudio = useCallback(async (bytes, token) => {
    try {
      const ctx = ensureUnlockedAudioContext();
      if (!ctx) return false;
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }
      if (ctx.state !== 'running') return false;

      const bufferCopy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const audioBuffer = await ctx.decodeAudioData(bufferCopy);
      if (playTokenRef.current !== token) return true;

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      sourceNodeRef.current = source;
      source.onended = () => {
        if (sourceNodeRef.current === source) {
          sourceNodeRef.current = null;
          setIsPlaying(false);
          setIsPaused(false);
        }
      };
      setIsPlaying(true);
      setIsPaused(false);
      source.start(0);
      return true;
    } catch {
      return false;
    }
  }, [ensureUnlockedAudioContext]);

  const playAudio = useCallback(async (text, langCode = 'te', audioBase64 = null) => {
    if (!text) return;
    stop();
    const token = playTokenRef.current;
    const cacheKey = `${langCode}:${text}`;

    const playWavBase64 = (b64) => {
      if (playTokenRef.current !== token) return true;
      try {
        wavCacheRef.current.set(cacheKey, b64);
        const bytes = base64ToUint8Array(b64);
        const blob = new Blob([bytes], { type: 'audio/wav' });
        const blobUrl = URL.createObjectURL(blob);
        blobUrlRef.current = blobUrl;

        const audio = new Audio(blobUrl);
        audioRef.current = audio;

        const cleanupBlob = () => {
          if (blobUrlRef.current === blobUrl) {
            URL.revokeObjectURL(blobUrl);
            blobUrlRef.current = null;
          }
        };

        audio.onplay = () => {
          setIsPlaying(true);
          setIsPaused(false);
        };
        audio.onended = () => {
          setIsPlaying(false);
          setIsPaused(false);
          audioRef.current = null;
          cleanupBlob();
        };
        audio.onerror = async () => {
          audioRef.current = null;
          cleanupBlob();
          await playViaWebAudio(bytes, token);
        };

        audio.play().catch(async () => {
          audioRef.current = null;
          cleanupBlob();
          const played = await playViaWebAudio(bytes, token);
          if (!played) {
            setIsPlaying(false);
            setIsPaused(false);
          }
        });
        return true;
      } catch {
        return false;
      }
    };

    const cachedAudio = audioBase64 || wavCacheRef.current.get(cacheKey);
    if (cachedAudio && playWavBase64(cachedAudio)) {
      return;
    }

    const synth = await synthesizeSpeechAudio({ text, language: langCode });
    if (playTokenRef.current !== token) return;
    if (synth?.success && synth.audio_base64 && playWavBase64(synth.audio_base64)) {
      return;
    }

    playBrowserTTS(text, langCode);
  }, [playBrowserTTS, playViaWebAudio, stop]);

  return {
    playAudio,
    stop,
    pause,
    resume,
    isPlaying,
    isPaused,
    activeVoice,
    availableVoices
  };
}
