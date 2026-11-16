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
 * Secret redaction for the live conformance kit.
 *
 * The kit is handed a long-lived API key or an ephemeral token at runtime.
 * Neither may ever reach a log line, a thrown Error, a trace event or a
 * report. Every string that leaves the kit and could contain SDK or server
 * text goes through a redactor built here.
 */

const GENERIC_PATTERNS: readonly RegExp[] = [
  // Google API keys (Gemini, Maps, Firebase).
  /AIza[A-Za-z0-9_-]{20,}/g,
  // Ephemeral Live tokens.
  /auth_tokens\/[A-Za-z0-9_.-]+/g,
  // Credentials carried in a URL query string.
  /\b(key|access_token|api_key|apikey)=[^&\s"'<>)]+/gi,
  // OAuth bearer tokens.
  /\bya29\.[A-Za-z0-9_.-]{20,}/g,
];

export const REDACTED = '[REDACTED]';

/**
 * Build a redactor that removes the given secret values verbatim, plus
 * anything matching a known credential shape.
 */
export function makeRedactor(secrets: ReadonlyArray<string | null | undefined>): (value: unknown) => string {
  const literals = secrets.filter((s): s is string => typeof s === 'string' && s.length >= 6);
  return (value: unknown): string => {
    let text: string;
    if (typeof value === 'string') text = value;
    else if (value instanceof Error) text = value.message;
    else {
      try {
        text = JSON.stringify(value) ?? String(value);
      } catch {
        text = String(value);
      }
    }
    for (const secret of literals) {
      text = text.split(secret).join(REDACTED);
    }
    for (const pattern of GENERIC_PATTERNS) {
      text = text.replace(pattern, (match, name?: string) =>
        typeof name === 'string' && match.includes('=') ? `${name}=${REDACTED}` : REDACTED,
      );
    }
    return text;
  };
}

/** Redact by credential shape only (no known literal values). */
export const redactSecrets = makeRedactor([]);
