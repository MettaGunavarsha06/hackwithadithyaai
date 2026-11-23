import { useState, useEffect, useCallback, useRef } from 'react';
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
 * Custom React Hook for Voice Output (TTS):
 * 1. Plays server-synthesized WAV audio (from free Gemini 3.8 Neural TTS) via Blob URL
 *    with unlocked Web Audio API fallback (bypassing data: URI / async autoplay limits).
 * 2. Falls back to browser native SpeechSynthesis only when server TTS is unavailable.
 */
export function useSpeechSynthesis() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isSupported, setIsSupported] = useState(false);
  const [voices, setVoices] = useState([]);
  const audioRef = useRef(null);
  const blobUrlRef = useRef(null);
  const audioCtxRef = useRef(null);
  const sourceNodeRef = useRef(null);
  const wavCacheRef = useRef(new Map());
  const playTokenRef = useRef(0);

  useEffect(() => {
    if ('speechSynthesis' in window) {
      setIsSupported(true);
      const updateVoices = () => {
        const available = window.speechSynthesis.getVoices();
        setVoices(available);
      };
      updateVoices();
      window.speechSynthesis.onvoiceschanged = updateVoices;
    } else {
      setIsSupported(true);
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
    // Unlock Web Audio context synchronously when invoked from a user click/send gesture
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
  }, [ensureUnlockedAudioContext]);

  const playBrowserSpeech = useCallback(
    (text, langCode = 'te-IN') => {
      if (!('speechSynthesis' in window) || !text) {
        setIsPlaying(false);
        return;
      }
      window.speechSynthesis.cancel();

      const cleanText = text
        .replace(/[*#_`~>\[\]\(\)]/g, '')
        .replace(/https?:\/\/\S+/g, 'link');

      const utterance = new SpeechSynthesisUtterance(cleanText);
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

      const voice = voices.find((v) => v.lang === bcpLang || v.lang.startsWith(short));
      if (voice) {
        utterance.voice = voice;
      }

      utterance.onstart = () => setIsPlaying(true);
      utterance.onend = () => setIsPlaying(false);
      utterance.onerror = () => setIsPlaying(false);

      window.speechSynthesis.speak(utterance);
    },
    [voices]
  );

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
        }
      };
      setIsPlaying(true);
      source.start(0);
      return true;
    } catch {
      return false;
    }
  }, [ensureUnlockedAudioContext]);

  const speak = useCallback(
    async (text, langCode = 'te-IN', audioBase64 = null) => {
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

          audio.onplay = () => setIsPlaying(true);
          audio.onended = () => {
            setIsPlaying(false);
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

      playBrowserSpeech(text, langCode);
    },
    [stop, playBrowserSpeech, playViaWebAudio]
  );

  return {
    speak,
    stop,
    isPlaying,
    isSupported,
    voices,
  };
}
