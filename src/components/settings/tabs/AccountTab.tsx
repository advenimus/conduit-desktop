import { useState, useEffect, useCallback } from "react";
import { invoke } from "../../../lib/electron";
import { useAuthStore } from "../../../stores/authStore";
import { useTierStore } from "../../../stores/tierStore";
import { UsageBar } from "../SettingsHelpers";
import type { UsageData } from "../SettingsHelpers";
import { UserIcon } from "../../../lib/icons";

interface AccountTabProps {
  onClose: () => void;
}

export default function AccountTab({ onClose }: AccountTabProps) {
  const { user, profile, authMode, signOut } = useAuthStore();
  const { isTrialing, trialDaysRemaining } = useTierStore();
  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false);
  const [usageData, setUsageData] = useState<UsageData | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);

  const fetchUsage = useCallback(async () => {
    if (!user) return;
    setUsageLoading(true);
    try {
      const data = await invoke<UsageData>("auth_get_usage");
      setUsageData(data);
    } catch (err) {
      console.error("Failed to fetch usage:", err);
    } finally {
      setUsageLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchUsage();
  }, [fetchUsage]);

  return (
    <div className="space-y-4">
      {authMode === 'local' ? (
        <div className="text-center py-8">
          <UserIcon size={48} className="text-ink-faint mx-auto mb-3" />
          <p className="text-ink-muted mb-2">Not signed in</p>
          <p className="text-xs text-ink-faint mb-4">
            Sign in to unlock AI features, cloud sync, and more
          </p>
          <button
            onClick={() => {
              onClose();
              useAuthStore.getState().exitToSignIn();
            }}
            className="px-4 py-2 bg-conduit-600 hover:bg-conduit-700 text-white text-sm rounded"
          >
            Sign In
          </button>
        </div>
      ) : (
        <>
          <div>
            <label className="block text-sm font-medium mb-1">Email</label>
            <div className="flex items-center gap-2">
              <p className="text-sm text-ink-secondary">{user?.email ?? 'Not signed in'}</p>
              {authMode === 'cached' && (
                <span className="px-1.5 py-0.5 text-[10px] font-medium bg-amber-600/20 text-amber-400 rounded">
                  offline
                </span>
              )}
            </div>
          </div>
          {profile?.display_name && (
            <div>
              <label className="block text-sm font-medium mb-1">Display Name</label>
              <p className="text-sm text-ink-secondary">{profile.display_name}</p>
            </div>
          )}
          <div>
            <label className="block text-sm font-medium mb-1">Tier</label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-ink-secondary">
                {profile?.tier?.display_name ?? 'Free'}
                {isTrialing && ' (Trial)'}
              </span>
              {profile?.is_team_member && (
                <span className="px-2 py-0.5 text-xs font-medium bg-conduit-600/20 text-conduit-400 rounded-full">
                  Team Member
                </span>
              )}
            </div>
          </div>

          {isTrialing && trialDaysRemaining >= 0 && (
            <div>
              <label className="block text-sm font-medium mb-1">Trial Status</label>
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-ink-secondary">{trialDaysRemaining} days remaining</span>
                  <span className="text-ink-faint">{30 - trialDaysRemaining}/30 days</span>
                </div>
                <div className="w-full bg-well rounded-full h-1.5">
                  <div
                    className="bg-conduit-500 h-1.5 rounded-full transition-all"
                    style={{ width: `${Math.max(0, ((30 - trialDaysRemaining) / 30) * 100)}%` }}
                  />
                </div>
                {profile?.trial_ends_at && (
                  <p className="text-xs text-ink-muted">
                    Trial ends {new Date(profile.trial_ends_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                  </p>
                )}
                <button
                  onClick={() => invoke("auth_open_pricing")}
                  className="px-3 py-1.5 text-xs bg-conduit-600 hover:bg-conduit-500 text-white rounded transition-colors"
                >
                  Subscribe Now
                </button>
              </div>
            </div>
          )}

          {!isTrialing && profile?.has_used_trial && profile?.subscription_status !== 'active' && (
            <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 px-3 py-2">
              <p className="text-xs text-amber-400">
                Your trial has ended. Subscribe to continue using Pro features.
              </p>
              <button
                onClick={() => invoke("auth_open_pricing")}
                className="mt-2 px-3 py-1.5 text-xs bg-conduit-600 hover:bg-conduit-500 text-white rounded transition-colors"
              >
                Subscribe
              </button>
            </div>
          )}

          {authMode === 'authenticated' && (
            <div className="pt-4 border-t border-stroke space-y-3">
              <label className="block text-sm font-medium">Token Usage</label>
              {usageLoading ? (
                <div className="flex items-center gap-2">
                  <div className="w-4 h-4 border-2 border-conduit-500 border-t-transparent rounded-full animate-spin" />
                  <span className="text-xs text-ink-muted">Loading usage...</span>
                </div>
              ) : usageData ? (
                <>
                  <UsageBar
                    used={usageData.usage.total_used}
                    limit={usageData.usage.monthly_limit}
                    label="Monthly"
                    resetsAt={usageData.usage.monthly_resets_at}
                  />
                  {usageData.usage.daily_limit !== -1 && (
                    <UsageBar
                      used={usageData.usage.daily_used}
                      limit={usageData.usage.daily_limit}
                      label="Daily"
                      resetsAt={usageData.usage.daily_resets_at}
                    />
                  )}
                  <p className="text-[10px] text-ink-muted">
                    {usageData.usage.request_count} requests this month
                  </p>
                </>
              ) : (
                <p className="text-xs text-ink-muted">Usage data unavailable</p>
              )}
            </div>
          )}

          <div className="pt-4 border-t border-stroke">
            {showSignOutConfirm ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-ink-muted">Sign out?</span>
                <button
                  onClick={async () => {
                    await signOut();
                    onClose();
                  }}
                  className="px-3 py-1.5 text-sm text-white bg-red-600 hover:bg-red-700 rounded"
                >
                  Confirm
                </button>
                <button
                  onClick={() => setShowSignOutConfirm(false)}
                  className="px-3 py-1.5 text-sm hover:bg-raised rounded"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowSignOutConfirm(true)}
                className="px-4 py-2 text-sm text-red-400 hover:bg-red-500/10 rounded"
              >
                Sign Out
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
