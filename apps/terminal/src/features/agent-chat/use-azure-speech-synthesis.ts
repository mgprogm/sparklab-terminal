"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const MAX_SPEECH_TEXT_LENGTH = 12_000;
const DEFAULT_SPEECH_VOICE = "th-TH-PremwadeeNeural";

type SpeechStatus = "idle" | "loading" | "speaking" | "error";

interface SpeechState {
  status: SpeechStatus;
  messageId: string | null;
  error: string | null;
}

interface SpeechToken {
  token: string;
  region: string;
  voice?: string;
}

interface Synthesizer {
  close: () => void;
  speakTextAsync: (
    text: string,
    onComplete: (result: { reason: unknown }) => void,
    onError: (error: string) => void,
  ) => void;
}

interface AudioDestination {
  close: () => void;
}

/** Convert rendered Markdown into the prose Azure should read aloud. */
export function toSpeakableText(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^[ \t]*(?:[-*+] |\d+\. )/gm, "")
    .replace(/(?:\*{1,3}|_{1,3}|~~)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_SPEECH_TEXT_LENGTH);
}

function isSpeechToken(value: unknown): value is SpeechToken {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as SpeechToken).token === "string" &&
    typeof (value as SpeechToken).region === "string"
  );
}

/** One synthesizer for the whole transcript: starting another message stops it. */
export function useAzureSpeechSynthesis() {
  const synthesizerRef = useRef<Synthesizer | null>(null);
  const audioDestinationRef = useRef<AudioDestination | null>(null);
  const requestIdRef = useRef(0);
  const [state, setState] = useState<SpeechState>({
    status: "idle",
    messageId: null,
    error: null,
  });

  const stop = useCallback(() => {
    requestIdRef.current += 1;
    const synthesizer = synthesizerRef.current;
    const audioDestination = audioDestinationRef.current;
    synthesizerRef.current = null;
    audioDestinationRef.current = null;
    synthesizer?.close();
    audioDestination?.close();
    setState({ status: "idle", messageId: null, error: null });
  }, []);

  useEffect(() => stop, [stop]);

  const speak = useCallback(
    async (messageId: string, markdown: string) => {
      const text = toSpeakableText(markdown);
      if (!text) return;

      stop();
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      setState({ status: "loading", messageId, error: null });

      try {
        const response = await fetch("/api/speech/token", { method: "POST" });
        const body: unknown = await response.json();
        if (!response.ok || !isSpeechToken(body)) {
          throw new Error("Speech synthesis is unavailable");
        }

        const SpeechSDK =
          await import("microsoft-cognitiveservices-speech-sdk");
        if (requestId !== requestIdRef.current) return;

        const speechConfig = SpeechSDK.SpeechConfig.fromAuthorizationToken(
          body.token,
          body.region,
        );
        speechConfig.speechSynthesisVoiceName =
          body.voice || DEFAULT_SPEECH_VOICE;
        speechConfig.speechSynthesisOutputFormat =
          SpeechSDK.SpeechSynthesisOutputFormat.Audio16Khz32KBitRateMonoMp3;
        const audioDestination = new SpeechSDK.SpeakerAudioDestination();
        const synthesizer = new SpeechSDK.SpeechSynthesizer(
          speechConfig,
          SpeechSDK.AudioConfig.fromSpeakerOutput(audioDestination),
        );
        synthesizerRef.current = synthesizer;
        audioDestinationRef.current = audioDestination;
        setState({ status: "speaking", messageId, error: null });

        const finish = () => {
          if (requestId !== requestIdRef.current) return;
          synthesizerRef.current = null;
          audioDestinationRef.current = null;
          setState({ status: "idle", messageId: null, error: null });
        };
        // The synthesis callback below fires once Azure has supplied audio,
        // which can precede browser playback completing. Keep the Stop button
        // active until the destination reports that playback actually ended.
        audioDestination.onAudioEnd = finish;

        synthesizer.speakTextAsync(
          text,
          () => {
            if (requestId !== requestIdRef.current) return;
            // Closing the synthesizer closes its audio configuration, which
            // tells SpeakerAudioDestination no further bytes are coming. Its
            // onAudioEnd event then fires only after browser playback ends.
            synthesizer.close();
            synthesizerRef.current = null;
          },
          () => {
            if (requestId !== requestIdRef.current) return;
            synthesizer.close();
            audioDestination.close();
            synthesizerRef.current = null;
            audioDestinationRef.current = null;
            setState({
              status: "error",
              messageId,
              error: "Could not play this response",
            });
          },
        );
      } catch {
        if (requestId !== requestIdRef.current) return;
        setState({
          status: "error",
          messageId,
          error: "Speech synthesis is unavailable",
        });
      }
    },
    [stop],
  );

  return { ...state, speak, stop };
}
