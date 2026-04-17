import { useState } from 'react';
import { useAppIcon } from '../../hooks/useAppIcon';
import { useAuthStore } from '../../stores/authStore';
import {
  CloudIcon, DevicesIcon, ExternalLinkIcon, LoaderIcon, MessageChatbotIcon, SparklesIcon
} from "../../lib/icons";

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
    <div className="flex items-center justify-center min-h-screen bg-canvas">
      <div className="w-full max-w-md mx-4">
        {/* Branding */}
        <div className="text-center mb-8">
          <img src={appIcon} alt="Conduit" className="w-16 h-16 rounded-2xl mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-ink">Conduit</h1>
          <p className="text-sm text-ink-muted mt-1">Remote Connection Manager</p>
        </div>

        {/* Trial banner */}
        <div className="mb-4 mx-auto max-w-md rounded-lg bg-conduit-500/5 border border-conduit-500/20 px-4 py-3 text-center">
          <div className="flex items-center justify-center gap-2 mb-1">
            <SparklesIcon size={14} className="text-conduit-400" />
            <span className="text-sm font-medium text-ink">30-day free trial of Pro</span>
          </div>
          <p className="text-xs text-ink-muted">
            Full AI assistant, MCP tools, cloud sync — no commitment
          </p>
        </div>

        {/* Auth Card */}
        <div className="bg-panel border border-stroke rounded-lg p-6 shadow-xl">
          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-md mb-4">
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          {waitingForBrowser ? (
            <div className="text-center py-4">
              <LoaderIcon size={32} className="text-conduit-400 animate-spin mx-auto mb-4" />
              <p className="text-sm text-ink mb-1">Complete sign-in in your browser...</p>
              <p className="text-xs text-ink-muted mb-6">
                A browser window has been opened. Return here after signing in.
              </p>
              <button
                onClick={handleSignIn}
                className="text-sm text-conduit-400 hover:text-conduit-300 transition-colors"
              >
                Open browser again
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <button
                onClick={handleSignIn}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-conduit-600 hover:bg-conduit-500 text-white text-sm font-medium rounded-md transition-colors"
              >
                <ExternalLinkIcon size={16} />
                Sign In
              </button>

              <p className="text-center text-sm text-ink-muted">
                Don't have an account?{' '}
                <button
                  onClick={handleSignUp}
                  className="text-conduit-400 hover:text-conduit-300 transition-colors"
                >
                  Create Account
                </button>
              </p>
            </div>
          )}
        </div>

        {/* Feature preview */}
        <div className="mt-6 text-center">
          <p className="text-xs text-ink-faint mb-2">Free accounts include</p>
          <div className="flex justify-center gap-6 text-xs text-ink-muted">
            <span className="flex items-center gap-1.5">
              <MessageChatbotIcon size={13} className="text-conduit-400" />
              AI Chat
            </span>
            <span className="flex items-center gap-1.5">
              <CloudIcon size={13} className="text-conduit-400" />
              Cloud Backup
            </span>
            <span className="flex items-center gap-1.5">
              <DevicesIcon size={13} className="text-conduit-400" />
              Cross-device Sync
            </span>
          </div>
        </div>

        {/* Skip sign-in option */}
        <div className="text-center mt-8">
          <button
            onClick={enterLocalMode}
            className="text-[11px] text-ink-faint/50 hover:text-ink-muted transition-colors"
          >
            Continue without signing in
          </button>
        </div>
      </div>
    </div>
  );
}
