/**
 * Vitest global test setup.
 *
 * - Extends expect with DOM-specific matchers (toBeInTheDocument, etc.)
 * - Sets up browser API mocks (AudioContext, MediaRecorder, getUserMedia)
 * - Mocks Firebase modules so tests never hit a real backend
 */

import '@testing-library/jest-dom/vitest';
import '../__mocks__/webAudioApi';
import '../__mocks__/firebase';
