/**
 * Tests for Gemini system instruction generation.
 *
 * buildSystemInstruction is a pure function — no API calls or side effects.
 * Tests verify that the instruction includes all required context and handles
 * edge cases (empty fields, special characters, large question sets).
 *
 * References: design.md §5.3 (Priority 1) | src/services/gemini.ts
 */

import { describe, it, expect } from 'vitest';
import { buildSystemInstruction } from '../../services/gemini';
import { Dossier, InterviewQuestion } from '../../types';

/** Minimal valid Dossier for testing. */
function makeDossier(overrides: Partial<Dossier> = {}): Dossier {
  return {
    storytellerName: 'Margaret',
    storytellerContext: 'Grew up on a farm in Iowa.',
    historicalContext: 'Post-war rural America, 1950s.',
    familyTree: [{ name: 'Arthur', relation: 'Father' }],
    selectedVoice: 'Zephyr',
    personality: 'empathetic',
    createdAt: { toDate: () => new Date() } as any,
    updatedAt: { toDate: () => new Date() } as any,
    ...overrides,
  };
}

/** Minimal valid question for testing. */
function makeQuestion(overrides: Partial<InterviewQuestion> = {}): InterviewQuestion {
  return {
    id: 'q1',
    text: 'Tell me about your childhood.',
    status: 'Unasked',
    findings: '',
    order: 0,
    createdAt: { toDate: () => new Date() } as any,
    updatedAt: { toDate: () => new Date() } as any,
    ...overrides,
  };
}

describe('buildSystemInstruction', () => {
  it('includes the storyteller name in the instruction', () => {
    const instruction = buildSystemInstruction(makeDossier(), []);
    expect(instruction).toContain('Margaret');
  });

  it('includes the storyteller name in the greeting section', () => {
    const instruction = buildSystemInstruction(makeDossier({ storytellerName: 'Eleanor' }), []);
    expect(instruction).toContain('Greet Eleanor warmly by name');
  });

  it('includes the personality traits for empathetic mode', () => {
    const instruction = buildSystemInstruction(makeDossier({ personality: 'empathetic' }), []);
    expect(instruction).toContain('warm, gentle biographer');
  });

  it('includes the personality traits for investigative mode', () => {
    const instruction = buildSystemInstruction(makeDossier({ personality: 'investigative' }), []);
    expect(instruction).toContain('oral historian');
  });

  it('includes the personality traits for casual mode', () => {
    const instruction = buildSystemInstruction(makeDossier({ personality: 'casual' }), []);
    expect(instruction).toContain('curious, respectful grandchild');
  });

  it('includes family tree members', () => {
    const dossier = makeDossier({
      familyTree: [
        { name: 'Arthur', relation: 'Father' },
        { name: 'Eleanor', relation: 'Mother' },
      ],
    });
    const instruction = buildSystemInstruction(dossier, []);
    expect(instruction).toContain('Arthur');
    expect(instruction).toContain('Eleanor');
    expect(instruction).toContain('Father');
  });

  it('includes historical context', () => {
    const instruction = buildSystemInstruction(makeDossier(), []);
    expect(instruction).toContain('Post-war rural America');
  });

  it('includes storyteller context when present', () => {
    const instruction = buildSystemInstruction(makeDossier(), []);
    expect(instruction).toContain('Grew up on a farm in Iowa');
  });

  it('omits storyteller context line when empty', () => {
    const instruction = buildSystemInstruction(makeDossier({ storytellerContext: '' }), []);
    expect(instruction).not.toContain('Storyteller Background:');
  });

  it('includes question text and status in the instruction', () => {
    const questions = [
      makeQuestion({ id: 'q1', text: 'Tell me about your childhood.', status: 'Unasked' }),
      makeQuestion({ id: 'q2', text: 'What was your first job?', status: 'InProgress', findings: 'Worked at a bakery' }),
    ];
    const instruction = buildSystemInstruction(makeDossier(), questions);

    expect(instruction).toContain('Tell me about your childhood');
    expect(instruction).toContain('What was your first job');
    expect(instruction).toContain('Unasked');
    expect(instruction).toContain('InProgress');
    expect(instruction).toContain('Worked at a bakery');
  });

  it('handles an empty question list', () => {
    const instruction = buildSystemInstruction(makeDossier(), []);
    expect(instruction).toContain('Story Queue: []');
  });

  it('handles special characters in storyteller name', () => {
    const dossier = makeDossier({ storytellerName: 'John "Johnny" O\'Brien' });
    const instruction = buildSystemInstruction(dossier, []);
    expect(instruction).toContain('John "Johnny" O\'Brien');
  });

  it('handles empty family tree', () => {
    const dossier = makeDossier({ familyTree: [] });
    const instruction = buildSystemInstruction(dossier, []);
    expect(instruction).toContain('Family Tree: []');
  });

  it('includes interviewing rules', () => {
    const instruction = buildSystemInstruction(makeDossier(), []);
    expect(instruction).toContain('NEVER INTERRUPT');
    expect(instruction).toContain('HANDLE PAUSES');
    expect(instruction).toContain('MAP STORIES TO QUESTIONS');
    expect(instruction).toContain('updateQuestionStatus');
  });

  it('handles a large number of questions without crashing', () => {
    const questions = Array.from({ length: 50 }, (_, i) =>
      makeQuestion({ id: `q${i}`, text: `Question ${i}: Tell me about topic ${i}.` }),
    );
    const instruction = buildSystemInstruction(makeDossier(), questions);

    // Instruction should be generated successfully and contain all questions
    expect(instruction.length).toBeGreaterThan(0);
    expect(instruction).toContain('Question 49');
  });

  it('does not throw with empty storyteller name', () => {
    const dossier = makeDossier({ storytellerName: '' });
    expect(() => buildSystemInstruction(dossier, [])).not.toThrow();
  });
});
