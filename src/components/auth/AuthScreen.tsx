import { useState } from 'react';
import { useAppIcon } from '../../hooks/useAppIcon';
import { useAuthStore } from '../../stores/authStore';
import {
  BoltIcon, ExternalLinkIcon, ServerIcon, ShieldLockIcon, SparklesIcon
} from "../../lib/icons";
import { Button, Callout, Spinner } from '../ui';

export default function AuthScreen() {
  const appIcon = useAppIcon();
  const [waitingForBrowser, setWaitingForBrowser] = useState(false);
  const { openLogin, openSignup, enterLocalMode, error } = useAuthStore();

  const handleSignIn = () => {
    openLogin();
    setWaitingForBrowser(true);
  };

  const handleSignUp = () => {
    openSignup();
    setWaitingForBrowser(true);
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-editor">
      <div className="w-full max-w-md mx-4">
        {/* Branding */}
        <div className="text-center mb-8">
          <img src={appIcon} alt="Conduit" className="w-16 h-16 rounded-2xl mx-auto mb-4" />
          <h1 className="text-display font-semibold text-ink">Conduit</h1>
          <p className="text-body text-ink-muted mt-1">Remote Connection Manager</p>
        </div>

        <Callout tone="info" icon={SparklesIcon} title="30-day free trial of Pro" className="mb-4">
          Use one vault on all your devices at once. No commitment.
        </Callout>

        <div className="rounded-lg border border-card-border bg-sidebar p-6">
          {error && (
            <Callout tone="danger" className="mb-4">
              {error}
            </Callout>
          )}

          {waitingForBrowser ? (
            <div className="text-center py-4">
              <div className="flex justify-center mb-4">
                <Spinner size={24} className="text-link" />
              </div>
              <p className="text-body text-ink mb-1">Complete sign-in in your browser...</p>
              <p className="text-label text-ink-muted mb-6">
                A browser window has been opened. Return here after signing in.
              </p>
              <Button variant="link" size="lg" onClick={handleSignIn}>
                Open browser again
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <Button variant="primary" size="lg" icon={ExternalLinkIcon} fullWidth onClick={handleSignIn}>
                Sign In
              </Button>

              <p className="text-center text-body text-ink-muted">
                Don't have an account?{' '}
                <Button variant="link" size="lg" onClick={handleSignUp}>
                  Create Account
                </Button>
              </p>

              <div className="relative pt-2">
                <div className="absolute inset-x-0 top-1/2 h-px bg-divider" />
                <span className="relative mx-auto block w-fit bg-sidebar px-2 text-meta text-ink-faint">
                  or
                </span>
              </div>

              <Button variant="secondary" size="lg" fullWidth onClick={enterLocalMode}>
                Continue without signing in
              </Button>
            </div>
          )}
        </div>

        {/* Feature preview */}
        <div className="mt-6 text-center">
          <p className="text-label text-ink-faint mb-2">Free accounts include</p>
          <div className="flex justify-center gap-6 text-label text-ink-muted">
            <span className="flex items-center gap-1.5">
              <ServerIcon size={13} className="text-link" />
              SSH · RDP · VNC · Web
            </span>
            <span className="flex items-center gap-1.5">
              <ShieldLockIcon size={13} className="text-link" />
              Encrypted Vault
            </span>
            <span className="flex items-center gap-1.5">
              <BoltIcon size={13} className="text-link" />
              Unlimited MCP Tools
            </span>
          </div>
        </div>

        {/* Open-source footer */}
        <div className="text-center mt-8">
          <p className="text-meta text-ink-faint/50">
            Open source · Apache 2.0
          </p>
        </div>
      </div>
    </div>
  );
}
