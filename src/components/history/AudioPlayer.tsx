/**
 * AudioPlayer — playback controls for archived session audio.
 *
 * A simple wrapper around the HTML5 <audio> element that streams
 * the session's WebM/Opus file from Firebase Cloud Storage. The audio
 * streams on demand (no full download required before playback).
 *
 * Handles the case where the audio URL is missing (e.g. interrupted
 * sessions where the upload failed) by not rendering.
 *
 * References: product_requirements.md §3.6 | GitHub Issue #15
 */

import React from 'react';

interface AudioPlayerProps {
  audioUrl: string;
}

export const AudioPlayer: React.FC<AudioPlayerProps> = ({ audioUrl }) => {
  if (!audioUrl) return null;

  return (
    <div className="bg-slate-50 rounded-2xl border border-slate-200 p-4 space-y-2">
      <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
        Session Audio
      </label>
      <audio
        controls
        preload="metadata"
        className="w-full"
        src={audioUrl}
      >
        Your browser does not support audio playback.
      </audio>
    </div>
  );
};
