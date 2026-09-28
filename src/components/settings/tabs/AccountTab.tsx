import { useState } from "react";
import { invoke } from "../../../lib/electron";
import { useAuthStore } from "../../../stores/authStore";
import { useTierStore } from "../../../stores/tierStore";
import { UserIcon } from "../../../lib/icons";
import { Badge, Button, Callout, EmptyState } from "../../ui";
import { HINT, SECTION_LABEL } from "../settings-styles";

interface AccountTabProps {
  onClose: () => void;
}

export default function AccountTab({ onClose }: AccountTabProps) {
  const { user, profile, authMode, signOut } = useAuthStore();
  const { isTrialing, trialDaysRemaining } = useTierStore();
  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false);

  return (
    <div className="space-y-4">
      {authMode === 'local' ? (
        <EmptyState
          icon={UserIcon}
          title="Not signed in"
          description="Sign in to unlock multi-device sync, cloud backup, and more."
          action={
            <Button
              variant="primary"
              className="mt-2"
              onClick={() => {
                onClose();
                useAuthStore.getState().exitToSignIn();
              }}
            >
              Sign In
            </Button>
          }
        />
      ) : (
        <>
          <div>
            <label className={`${SECTION_LABEL} mb-1`}>Email</label>
            <div className="flex items-center gap-2">
              <p className="text-body text-ink-secondary">{user?.email ?? 'Not signed in'}</p>
              {authMode === 'cached' && <Badge tone="warning">offline</Badge>}
            </div>
          </div>
          {profile?.display_name && (
            <div>
              <label className={`${SECTION_LABEL} mb-1`}>Display Name</label>
              <p className="text-body text-ink-secondary">{profile.display_name}</p>
            </div>
          )}
          <div>
            <label className={`${SECTION_LABEL} mb-1`}>Tier</label>
            <div className="flex items-center gap-2">
              <span className="text-body text-ink-secondary">
                {profile?.tier?.display_name ?? 'Free'}
                {isTrialing && ' (Trial)'}
              </span>
              {profile?.is_team_member && <Badge tone="neutral">Team Member</Badge>}
            </div>
          </div>

          {isTrialing && trialDaysRemaining >= 0 && (
            <div>
              <label className={`${SECTION_LABEL} mb-1`}>Trial Status</label>
              <div className="space-y-2">
                <div className="flex items-center justify-between text-body">
                  <span className="text-ink-secondary">{trialDaysRemaining} days remaining</span>
                  <span className="text-ink-faint">{30 - trialDaysRemaining}/30 days</span>
                </div>
                <div className="h-1 w-full rounded-full bg-selected">
                  <div
                    className="h-1 rounded-full bg-(--c-progress)"
                    style={{ width: `${Math.max(0, ((30 - trialDaysRemaining) / 30) * 100)}%` }}
                  />
                </div>
                {profile?.trial_ends_at && (
                  <p className={HINT}>
                    Trial ends {new Date(profile.trial_ends_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                  </p>
                )}
                <Button variant="primary" size="sm" onClick={() => invoke("auth_open_pricing")}>
                  Subscribe Now
                </Button>
              </div>
            </div>
          )}

          {!isTrialing && profile?.has_used_trial && profile?.subscription_status !== 'active' && (
            <Callout
              tone="warning"
              actions={
                <Button variant="primary" size="sm" onClick={() => invoke("auth_open_pricing")}>
                  Subscribe
                </Button>
              }
            >
              Your trial has ended. Subscribe to continue using Pro features.
            </Callout>
          )}

          <div className="border-t border-divider pt-4">
            {showSignOutConfirm ? (
              <div className="flex items-center gap-2">
                <span className="text-body text-ink-muted">Sign out?</span>
                <Button
                  variant="danger"
                  onClick={async () => {
                    await signOut();
                    onClose();
                  }}
                >
                  Confirm
                </Button>
                <Button variant="ghost" onClick={() => setShowSignOutConfirm(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <Button variant="ghost" className="text-danger! hover:text-danger!" onClick={() => setShowSignOutConfirm(true)}>
                Sign Out
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
