/**
 * Tests for the DossierList component.
 *
 * Verifies empty state, dossier card display, create form,
 * delete confirmation, and navigation.
 *
 * References: design.md §5.3 (Priority 2) | src/components/dossier/DossierList.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Mock react-router-dom
const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

// Mock useAuth
const mockUser = { uid: 'uid-1', email: 'test@test.com', displayName: 'Test' };
vi.mock('../../../hooks/useAuth', () => ({
  useAuth: () => ({ user: mockUser, loading: false }),
}));

// Mock useDossierList with controllable returns
const mockCreateDossier = vi.fn().mockResolvedValue('new-id');
const mockDeleteDossier = vi.fn().mockResolvedValue(undefined);
let mockDossiers: any[] = [];
let mockLoading = false;

vi.mock('../../../hooks/useDossier', () => ({
  useDossierList: () => ({
    dossiers: mockDossiers,
    loading: mockLoading,
    createDossier: mockCreateDossier,
    deleteDossier: mockDeleteDossier,
  }),
}));

import { DossierList } from '../../../components/dossier/DossierList';

beforeEach(() => {
  mockNavigate.mockClear();
  mockCreateDossier.mockClear();
  mockDeleteDossier.mockClear();
  mockDossiers = [];
  mockLoading = false;
});

describe('DossierList — empty state', () => {
  it('shows empty state when no dossiers', () => {
    render(<DossierList />);
    expect(screen.getByText('No Storytellers yet')).toBeInTheDocument();
  });

  it('shows the page heading', () => {
    render(<DossierList />);
    expect(screen.getByText('Your Storytellers')).toBeInTheDocument();
  });

  it('shows the New Storyteller button', () => {
    render(<DossierList />);
    expect(screen.getByText('+ New Storyteller')).toBeInTheDocument();
  });
});

describe('DossierList — loading state', () => {
  it('shows spinner when loading', () => {
    mockLoading = true;
    const { container } = render(<DossierList />);
    expect(container.querySelector('.animate-spin')).not.toBeNull();
  });
});

describe('DossierList — dossier cards', () => {
  beforeEach(() => {
    mockDossiers = [
      { id: 'd1', storytellerName: 'Margaret', storytellerContext: 'Grew up in Iowa', personality: 'empathetic', selectedVoice: 'Zephyr' },
      { id: 'd2', storytellerName: 'Arthur', storytellerContext: '', personality: 'investigative', selectedVoice: 'Kore' },
    ];
  });

  it('displays storyteller names', () => {
    render(<DossierList />);
    expect(screen.getByText('Margaret')).toBeInTheDocument();
    expect(screen.getByText('Arthur')).toBeInTheDocument();
  });

  it('displays storyteller context when present', () => {
    render(<DossierList />);
    expect(screen.getByText('Grew up in Iowa')).toBeInTheDocument();
  });

  it('displays personality and voice badges', () => {
    render(<DossierList />);
    expect(screen.getByText('empathetic')).toBeInTheDocument();
    expect(screen.getByText('Zephyr')).toBeInTheDocument();
  });

  it('navigates to dossier on card click', () => {
    render(<DossierList />);
    fireEvent.click(screen.getByText('Margaret'));
    expect(mockNavigate).toHaveBeenCalledWith('/dossier/d1');
  });
});

describe('DossierList — create flow', () => {
  it('shows create form when button is clicked', () => {
    render(<DossierList />);
    fireEvent.click(screen.getByText('+ New Storyteller'));
    expect(screen.getByPlaceholderText('e.g. Grandma Margaret')).toBeInTheDocument();
  });

  it('creates dossier and navigates on submit', async () => {
    render(<DossierList />);
    fireEvent.click(screen.getByText('+ New Storyteller'));

    fireEvent.change(screen.getByPlaceholderText('e.g. Grandma Margaret'), {
      target: { value: 'Eleanor' },
    });
    fireEvent.click(screen.getByText('Create'));

    await waitFor(() => {
      expect(mockCreateDossier).toHaveBeenCalledWith('Eleanor');
      expect(mockNavigate).toHaveBeenCalledWith('/dossier/new-id');
    });
  });

  it('disables Create button when name is empty', () => {
    render(<DossierList />);
    fireEvent.click(screen.getByText('+ New Storyteller'));
    expect(screen.getByText('Create')).toBeDisabled();
  });

  it('hides create form on Cancel', () => {
    render(<DossierList />);
    fireEvent.click(screen.getByText('+ New Storyteller'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByPlaceholderText('e.g. Grandma Margaret')).not.toBeInTheDocument();
  });

  it('submits on Enter key', async () => {
    render(<DossierList />);
    fireEvent.click(screen.getByText('+ New Storyteller'));

    const input = screen.getByPlaceholderText('e.g. Grandma Margaret');
    fireEvent.change(input, { target: { value: 'Test' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(mockCreateDossier).toHaveBeenCalledWith('Test');
    });
  });
});

describe('DossierList — delete flow', () => {
  beforeEach(() => {
    mockDossiers = [
      { id: 'd1', storytellerName: 'Margaret', storytellerContext: '', personality: 'empathetic', selectedVoice: 'Zephyr' },
    ];
  });

  it('shows delete confirmation when delete button is clicked', () => {
    render(<DossierList />);
    // The delete button is the trash icon button
    const deleteBtn = screen.getByTitle('Delete Dossier');
    fireEvent.click(deleteBtn);

    expect(screen.getByText(/Delete Margaret/)).toBeInTheDocument();
  });

  it('deletes the dossier on confirm', async () => {
    render(<DossierList />);
    fireEvent.click(screen.getByTitle('Delete Dossier'));
    fireEvent.click(screen.getByText('Delete'));

    await waitFor(() => {
      expect(mockDeleteDossier).toHaveBeenCalledWith('d1');
    });
  });

  it('cancels delete on Cancel click', () => {
    render(<DossierList />);
    fireEvent.click(screen.getByTitle('Delete Dossier'));
    fireEvent.click(screen.getAllByText('Cancel')[0]);

    expect(mockDeleteDossier).not.toHaveBeenCalled();
  });
});
