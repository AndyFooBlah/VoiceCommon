// Copyright 2026 Andrew Brook
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * SystemDiagnostics — runs lightweight test calls to all external APIs on mount
 * and displays latency at the bottom of the page.
 *
 * Styling:
 *   - Normal (< 2 s): small grey text
 *   - High latency (≥ 2 s): orange + semibold
 *   - Error: red + semibold
 */

import React, { useEffect, useState } from 'react';
import { GoogleGenAI } from '@google/genai';
import { getDoc, doc } from 'firebase/firestore';
import { db } from '../../services/firebase';
import { useAuth } from '../../hooks/useAuth';
import {
  searchWikipedia,
  searchPlace,
  getDistanceBetweenPlaces,
  getJoke,
  getWeather,
} from '../../services/externalSearch';

// ---------------------------------------------------------------------------
// Types

interface DiagResult {
  label: string;
  latencyMs: number | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Individual timed probe

async function probe(label: string, fn: () => Promise<unknown>): Promise<DiagResult> {
  const start = performance.now();
  try {
    await fn();
    return { label, latencyMs: Math.round(performance.now() - start), error: null };
  } catch (err) {
    return {
      label,
      latencyMs: Math.round(performance.now() - start),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Component

interface SystemDiagnosticsProps {
  uid?: string;
}

export const SystemDiagnostics: React.FC<SystemDiagnosticsProps> = ({ uid: uidProp }) => {
  const { user } = useAuth();
  const uid = uidProp ?? user?.uid;

  const [results, setResults] = useState<DiagResult[] | null>(null);

  useEffect(() => {
    const run = async () => {
      const settled = await Promise.allSettled([
        probe('Wikipedia', () => searchWikipedia('John F. Kennedy')),
        probe('Jokes', () => getJoke()),
        probe('Places', () => searchPlace('New York, NY')),
        probe('Distance', () => getDistanceBetweenPlaces('New York, NY', 'Los Angeles, CA')),
        probe('Weather', () => getWeather('New York, NY')),
        probe('Gemini', async () => {
          const ai = new GoogleGenAI({ apiKey: import.meta.env.VITE_GEMINI_API_KEY as string });
          const response = await ai.models.generateContent({
            model: 'gemini-2.0-flash-lite',
            contents: 'Reply with one word: OK',
          });
          if (!response.text) throw new Error('empty response');
        }),
        probe('Firestore', async () => {
          if (!uid) throw new Error('not authenticated');
          await getDoc(doc(db, 'users', uid));
        }),
      ]);

      setResults(
        settled.map((s) =>
          s.status === 'fulfilled' ? s.value : { label: '?', latencyMs: null, error: String(s.reason) },
        ),
      );
    };

    void run();
    // Run once on mount — uid is stable after login
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mt-12 pt-6 border-t border-slate-100">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-300 mb-2">
        System Diagnostics
      </p>

      {results === null ? (
        <p className="text-[11px] text-slate-300 animate-pulse">Running diagnostics…</p>
      ) : (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {results.map((r) => {
            const isError = !!r.error;
            const isHighLatency = !isError && r.latencyMs !== null && r.latencyMs >= 2000;

            const labelClass = isError
              ? 'text-red-400 font-semibold'
              : isHighLatency
                ? 'text-orange-400 font-semibold'
                : 'text-slate-300';

            const latencyText =
              r.latencyMs !== null ? `${r.latencyMs} ms` : '—';

            const tooltip = r.error ?? undefined;

            return (
              <span
                key={r.label}
                className={`text-[11px] ${labelClass}`}
                title={tooltip}
              >
                {r.label}: {isError ? 'error' : latencyText}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
};
