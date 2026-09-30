import { useState, useCallback, useEffect } from "react";
import { useAppIcon } from "../../hooks/useAppIcon";
import { useAuthStore } from "../../stores/authStore";
import { invoke } from "../../lib/electron";
import {
  getStepsForTier,
  getUserTierLevel,
  type OnboardingStep,
} from "./onboarding-steps";
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon } from "../../lib/icons";
import { Button, cx } from "../ui";

interface OnboardingWizardProps {
  onComplete: () => void;
}

export default function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  const appIcon = useAppIcon();
  const profile = useAuthStore((s) => s.profile);
  const tierLevel = getUserTierLevel(
    profile?.tier?.name,
    profile?.is_team_member ?? false
  );
  const steps = getStepsForTier(tierLevel);
  const [currentStep, setCurrentStep] = useState(0);
  const [direction, setDirection] = useState<"left" | "right">("right");
  const [isAnimating, setIsAnimating] = useState(false);

  const goTo = useCallback(
    (next: number) => {
      if (isAnimating || next === currentStep) return;
      setDirection(next > currentStep ? "right" : "left");
      setIsAnimating(true);
      setTimeout(() => {
        setCurrentStep(next);
        requestAnimationFrame(() => {
          setIsAnimating(false);
        });
      }, 200);
    },
    [currentStep, isAnimating]
  );

  const finish = useCallback(async () => {
    try {
      const settings = await invoke<Record<string, unknown>>("settings_get");
      await invoke("settings_save", {
        settings: { ...settings, onboarding_completed: true },
      });
    } catch {
      // Best-effort save
    }
    onComplete();
  }, [onComplete]);

  const step: OnboardingStep = steps[currentStep];
  const isLast = currentStep === steps.length - 1;
  const isFirst = currentStep === 0;
  const Icon = step.icon;

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" && !isLast) goTo(currentStep + 1);
      else if (e.key === "ArrowLeft" && !isFirst) goTo(currentStep - 1);
      else if (e.key === "Escape") finish();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isFirst, isLast, finish, goTo, currentStep]);

  const slideStyle: React.CSSProperties = isAnimating
    ? {
        transform: `translateX(${direction === "right" ? "-40px" : "40px"})`,
        opacity: 0,
      }
    : { transform: "translateX(0)", opacity: 1 };

  const transition = "transform 200ms ease-out, opacity 200ms ease-out";

  return (
    <div className="flex items-center justify-center h-screen bg-editor">
      <div className="w-full max-w-4xl mx-6">
        {/* Main card — fixed height so it never resizes between steps */}
        <div className="rounded-lg border border-card-border bg-sidebar overflow-hidden">
          <div className="flex h-[520px]">
            {/* ── Left Panel: Video + Title ── */}
            <div className="w-[55%] flex-shrink-0 flex flex-col p-8">
              {/* Sliding content fills available space, vertically centered */}
              <div
                className="flex-1 flex flex-col justify-center"
                style={{ ...slideStyle, transition }}
              >
                {/* Video / placeholder */}
                <div className="w-full aspect-video rounded-lg border border-card-border overflow-hidden mb-5 bg-well flex-shrink-0">
                  {step.video ? (
                    <video
                      key={step.id}
                      src={step.video}
                      autoPlay
                      loop
                      muted
                      playsInline
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center border-2 border-dashed border-card-border rounded-lg">
                      <Icon size={48} stroke={1.2} className="text-ink-faint mb-3" />
                      <span className="text-label text-ink-faint">Animation coming soon</span>
                    </div>
                  )}
                </div>

                {/* Title + short description */}
                <div className="flex items-start gap-3">
                  <div className="w-9 h-9 rounded-md bg-selected flex items-center justify-center flex-shrink-0 mt-0.5">
                    <Icon size={20} className="text-link" />
                  </div>
                  <div className="min-w-0">
                    <h2 className="text-display font-semibold text-ink">
                      {step.title}
                    </h2>
                    <p className="text-body text-ink-muted mt-1 leading-relaxed">
                      {step.description}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Vertical divider */}
            <div className="w-px bg-divider my-8" />

            {/* ── Right Panel: Details + Fixed Footer ── */}
            <div className="flex-1 flex flex-col p-8">
              {/* Sliding content — fills remaining space, vertically centered */}
              <div
                className="flex-1 flex flex-col justify-center"
                style={{ ...slideStyle, transition }}
              >
                {/* Tier badge */}
                <div className="flex items-center gap-2 mb-5">
                  <img src={appIcon} alt="Conduit" className="w-7 h-7 rounded-md" />
                  <span className="text-meta font-semibold text-ink-muted">
                    {step.minTier === "free"
                      ? "Included"
                      : step.minTier === "pro"
                        ? "Pro Feature"
                        : "Teams Feature"}
                  </span>
                </div>

                {/* Detail bullets */}
                <ul className="space-y-3">
                  {step.details.map((detail, i) => (
                    <li key={i} className="flex items-start gap-2.5">
                      <div className="w-5 h-5 rounded-full bg-selected flex items-center justify-center flex-shrink-0 mt-0.5">
                        <CheckIcon size={12} className="text-link" />
                      </div>
                      <span className="text-body text-ink-secondary leading-relaxed">
                        {detail}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* ── Fixed footer — never moves ── */}
              <div className="flex-shrink-0 pt-5">
                {/* Step counter */}
                <div className="text-label text-ink-faint mb-3">
                  {currentStep + 1} of {steps.length}
                </div>

                {/* Dot indicators */}
                <div className="flex items-center gap-1.5 mb-5">
                  {steps.map((_, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => goTo(i)}
                      aria-label={`Go to step ${i + 1}`}
                      title={`Go to step ${i + 1}`}
                      aria-current={i === currentStep ? "step" : undefined}
                      className={cx(
                        "h-1.5 rounded-full transition-all duration-300",
                        i === currentStep ? "w-6 bg-accent" : i < currentStep ? "w-1.5 bg-accent/40" : "w-1.5 bg-ink-faint/30",
                      )}
                    />
                  ))}
                </div>

                {/* Navigation buttons */}
                <div className="flex items-center justify-between">
                  <Button variant="ghost" size="lg" onClick={finish} className="-ml-3">
                    Skip
                  </Button>

                  <div className="flex items-center gap-2">
                    {!isFirst && (
                      <Button
                        variant="secondary"
                        size="lg"
                        icon={ChevronLeftIcon}
                        onClick={() => goTo(currentStep - 1)}
                        disabled={isAnimating}
                      >
                        Back
                      </Button>
                    )}

                    {isLast ? (
                      <Button variant="primary" size="lg" onClick={finish}>
                        Get Started
                      </Button>
                    ) : (
                      <Button
                        variant="primary"
                        size="lg"
                        iconEnd={ChevronRightIcon}
                        onClick={() => goTo(currentStep + 1)}
                        disabled={isAnimating}
                      >
                        Next
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
