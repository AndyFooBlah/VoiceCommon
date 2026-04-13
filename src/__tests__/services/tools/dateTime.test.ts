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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  computeTimeDifferenceTool,
  computeTimeOffsetTool,
  getTimeDifference,
  getTimeOffset,
} from '../../../services/tools/dateTime';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../../services/config', () => ({
  getConfig: vi.fn().mockReturnValue({ geminiApiKey: 'test-key' }),
}));

vi.mock('../../../services/dateTimeUtils', () => ({
  computeTimeDifference: vi.fn(),
  computeTimeOffset: vi.fn(),
}));

import { computeTimeDifference, computeTimeOffset } from '../../../services/dateTimeUtils';

const NOW = 'Sunday, April 12, 2026 at 12:00 AM PDT';

// ---------------------------------------------------------------------------
// Tool declarations
// ---------------------------------------------------------------------------

describe('computeTimeDifferenceTool declaration', () => {
  it('has the correct name', () => {
    expect(computeTimeDifferenceTool.name).toBe('computeTimeDifference');
  });

  it('has a description', () => {
    expect(computeTimeDifferenceTool.description).toBeTruthy();
  });

  it('requires dateA, dateB, and currentDateTime', () => {
    const required = (computeTimeDifferenceTool.parameters as any)?.required ?? [];
    expect(required).toContain('dateA');
    expect(required).toContain('dateB');
    expect(required).toContain('currentDateTime');
  });
});

describe('computeTimeOffsetTool declaration', () => {
  it('has the correct name', () => {
    expect(computeTimeOffsetTool.name).toBe('computeTimeOffset');
  });

  it('has a description', () => {
    expect(computeTimeOffsetTool.description).toBeTruthy();
  });

  it('requires date, offset, and currentDateTime', () => {
    const required = (computeTimeOffsetTool.parameters as any)?.required ?? [];
    expect(required).toContain('date');
    expect(required).toContain('offset');
    expect(required).toContain('currentDateTime');
  });
});

// ---------------------------------------------------------------------------
// getTimeDifference
// ---------------------------------------------------------------------------

describe('getTimeDifference', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('calls computeTimeDifference with the correct args and returns the result string', async () => {
    (computeTimeDifference as any).mockResolvedValue({
      result: 'about 27 years after summer 1997 (summer 2024)',
      parsedA: {},
      parsedB: {},
    });

    const result = await getTimeDifference('summer 1997', 'summer 2024', NOW);

    expect(computeTimeDifference).toHaveBeenCalledWith('summer 1997', 'summer 2024', NOW, 'test-key');
    expect(result).toBe('about 27 years after summer 1997 (summer 2024)');
  });

  it('propagates errors from computeTimeDifference', async () => {
    (computeTimeDifference as any).mockRejectedValue(new Error('Gemini error'));
    await expect(getTimeDifference('bad', 'input', NOW)).rejects.toThrow('Gemini error');
  });
});

// ---------------------------------------------------------------------------
// getTimeOffset
// ---------------------------------------------------------------------------

describe('getTimeOffset', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('calls computeTimeOffset with the correct args and returns the result string', async () => {
    (computeTimeOffset as any).mockResolvedValue({
      result: 'about 6 months later from July 4th, 1976 — around January 1977',
      parsedBase: {},
    });

    const result = await getTimeOffset('July 4th 1976', '6 months later', NOW);

    expect(computeTimeOffset).toHaveBeenCalledWith('July 4th 1976', '6 months later', NOW, 'test-key');
    expect(result).toBe('about 6 months later from July 4th, 1976 — around January 1977');
  });

  it('propagates errors from computeTimeOffset', async () => {
    (computeTimeOffset as any).mockRejectedValue(new Error('Gemini error'));
    await expect(getTimeOffset('bad', 'input', NOW)).rejects.toThrow('Gemini error');
  });
});
