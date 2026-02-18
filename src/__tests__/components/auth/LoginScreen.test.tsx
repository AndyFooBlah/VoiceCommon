/**
 * Tests for the LoginScreen component.
 *
 * Verifies form validation, error display, loading states,
 * and both sign-in paths (Google + email/password).
 *
 * References: design.md §5.3 (Priority 2) | src/components/auth/LoginScreen.tsx
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LoginScreen } from '../../../components/auth/LoginScreen';

let mockGoogleSignIn: Mock<() => Promise<void>>;
let mockEmailSignIn: Mock<(email: string, password: string) => Promise<void>>;

beforeEach(() => {
  mockGoogleSignIn = vi.fn().mockResolvedValue(undefined);
  mockEmailSignIn = vi.fn().mockResolvedValue(undefined);
});

function renderLogin() {
  return render(
    <LoginScreen
      onGoogleSignIn={mockGoogleSignIn}
      onEmailSignIn={mockEmailSignIn}
    />,
  );
}

describe('LoginScreen — rendering', () => {
  it('shows the LegacyBot heading', () => {
    renderLogin();
    expect(screen.getByText('LegacyBot')).toBeInTheDocument();
  });

  it('shows the tagline', () => {
    renderLogin();
    expect(screen.getByText(/Always archival, never forgotten/)).toBeInTheDocument();
  });

  it('shows the Google sign-in button', () => {
    renderLogin();
    expect(screen.getByText('Continue with Google')).toBeInTheDocument();
  });

  it('shows the email and password fields', () => {
    renderLogin();
    expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Enter your password')).toBeInTheDocument();
  });

  it('shows the Sign In button', () => {
    renderLogin();
    expect(screen.getByText('Sign In')).toBeInTheDocument();
  });

  it('shows new user hint text', () => {
    renderLogin();
    expect(
      screen.getByText(/Signing in with a new email will create your account automatically/),
    ).toBeInTheDocument();
  });
});

describe('LoginScreen — Google sign-in', () => {
  it('calls onGoogleSignIn when Google button is clicked', async () => {
    renderLogin();

    fireEvent.click(screen.getByText('Continue with Google'));

    await waitFor(() => {
      expect(mockGoogleSignIn).toHaveBeenCalledTimes(1);
    });
  });

  it('shows error when Google sign-in fails', async () => {
    mockGoogleSignIn.mockRejectedValueOnce(new Error('Popup closed'));
    renderLogin();

    fireEvent.click(screen.getByText('Continue with Google'));

    await waitFor(() => {
      expect(screen.getByText('Popup closed')).toBeInTheDocument();
    });
  });

  it('disables buttons during loading', async () => {
    // Make the sign-in hang
    mockGoogleSignIn.mockImplementation(() => new Promise(() => {}));
    renderLogin();

    fireEvent.click(screen.getByText('Continue with Google'));

    await waitFor(() => {
      expect(screen.getByText('Continue with Google')).toBeDisabled();
      expect(screen.getByText('Signing in...')).toBeDisabled();
    });
  });
});

describe('LoginScreen — email sign-in', () => {
  it('calls onEmailSignIn with email and password', async () => {
    renderLogin();

    fireEvent.change(screen.getByPlaceholderText('you@example.com'), {
      target: { value: 'test@example.com' },
    });
    fireEvent.change(screen.getByPlaceholderText('Enter your password'), {
      target: { value: 'secret123' },
    });
    fireEvent.click(screen.getByText('Sign In'));

    await waitFor(() => {
      expect(mockEmailSignIn).toHaveBeenCalledWith('test@example.com', 'secret123');
    });
  });

  it('shows validation error when fields are empty', async () => {
    renderLogin();

    fireEvent.click(screen.getByText('Sign In'));

    await waitFor(() => {
      expect(screen.getByText('Please enter both email and password.')).toBeInTheDocument();
    });

    // Should NOT call the sign-in handler
    expect(mockEmailSignIn).not.toHaveBeenCalled();
  });

  it('shows error when email sign-in fails', async () => {
    mockEmailSignIn.mockRejectedValueOnce(new Error('Invalid credentials'));
    renderLogin();

    fireEvent.change(screen.getByPlaceholderText('you@example.com'), {
      target: { value: 'test@example.com' },
    });
    fireEvent.change(screen.getByPlaceholderText('Enter your password'), {
      target: { value: 'wrong' },
    });
    fireEvent.click(screen.getByText('Sign In'));

    await waitFor(() => {
      expect(screen.getByText('Invalid credentials')).toBeInTheDocument();
    });
  });

  it('submits on Enter key via form', async () => {
    renderLogin();

    fireEvent.change(screen.getByPlaceholderText('you@example.com'), {
      target: { value: 'test@example.com' },
    });
    fireEvent.change(screen.getByPlaceholderText('Enter your password'), {
      target: { value: 'pass' },
    });
    fireEvent.submit(screen.getByPlaceholderText('you@example.com').closest('form')!);

    await waitFor(() => {
      expect(mockEmailSignIn).toHaveBeenCalledWith('test@example.com', 'pass');
    });
  });
});
