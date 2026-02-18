/**
 * Tests for the StorytellerDashboard component.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useParams: () => ({ familyId: 'family-1' }),
  useNavigate: () => mockNavigate,
}));

vi.mock('../../../hooks/useAuth', () => ({
  useAuth: () => ({ user: { uid: 'uid-1' }, loading: false }),
}));

let mockDossiers: any[] = [];
let mockLoading = false;

vi.mock('../../../hooks/useDossier', () => ({
  useDossierList: () => ({
    dossiers: mockDossiers,
    loading: mockLoading,
  }),
}));

import { StorytellerDashboard } from '../../../components/storyteller/StorytellerDashboard';

beforeEach(() => {
  mockNavigate.mockClear();
  mockDossiers = [];
  mockLoading = false;
});

describe('StorytellerDashboard — loading', () => {
  it('shows spinner when loading', () => {
    mockLoading = true;
    const { container } = render(<StorytellerDashboard />);
    expect(container.querySelector('.animate-spin')).not.toBeNull();
  });
});

describe('StorytellerDashboard — no dossiers', () => {
  it('shows welcome message when no dossiers assigned', () => {
    render(<StorytellerDashboard />);
    expect(screen.getByText('Welcome!')).toBeInTheDocument();
    expect(screen.getByText(/hasn't assigned you/)).toBeInTheDocument();
  });
});

describe('StorytellerDashboard — with dossiers', () => {
  beforeEach(() => {
    mockDossiers = [
      { id: 'd1', storytellerName: 'Margaret', storytellerContext: 'Born in 1935' },
    ];
  });

  it('displays storyteller name', () => {
    render(<StorytellerDashboard />);
    expect(screen.getByText('Margaret')).toBeInTheDocument();
  });

  it('displays storyteller context', () => {
    render(<StorytellerDashboard />);
    expect(screen.getByText('Born in 1935')).toBeInTheDocument();
  });

  it('shows Start Session button', () => {
    render(<StorytellerDashboard />);
    expect(screen.getByText('Start Session')).toBeInTheDocument();
  });

  it('shows History button', () => {
    render(<StorytellerDashboard />);
    expect(screen.getByText('History')).toBeInTheDocument();
  });

  it('navigates to session on Start Session click', () => {
    render(<StorytellerDashboard />);
    fireEvent.click(screen.getByText('Start Session'));
    expect(mockNavigate).toHaveBeenCalledWith('/family/family-1/dossier/d1/session');
  });

  it('navigates to history on History click', () => {
    render(<StorytellerDashboard />);
    fireEvent.click(screen.getByText('History'));
    expect(mockNavigate).toHaveBeenCalledWith('/family/family-1/dossier/d1/history');
  });
});
