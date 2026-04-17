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
    <div className="flex items-center justify-center h-screen bg-canvas">
      <div className="w-full max-w-4xl mx-6">
        {/* Main card — fixed height so it never resizes between steps */}
        <div className="rounded-xl border border-stroke-dim bg-panel/50 shadow-lg overflow-hidden">
          <div className="flex h-[520px]">
            {/* ── Left Panel: Video + Title ── */}
            <div className="w-[55%] flex-shrink-0 flex flex-col p-8">
              {/* Sliding content fills available space, vertically centered */}
              <div
                className="flex-1 flex flex-col justify-center"
                style={{ ...slideStyle, transition }}
              >
                {/* Video / placeholder */}
                <div className="w-full aspect-video rounded-lg border border-stroke overflow-hidden mb-5 bg-well/30 flex-shrink-0">
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
                    <div className="w-full h-full flex flex-col items-center justify-center border-2 border-dashed border-stroke rounded-lg">
                      <Icon size={48} stroke={1.2} className="text-ink-faint mb-3" />
                      <span className="text-xs text-ink-faint">Animation coming soon</span>
                    </div>
                  )}
                </div>

                {/* Title + short description */}
                <div className="flex items-start gap-3">
                  <div className="w-9 h-9 rounded-lg bg-conduit-500/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <Icon size={20} className="text-conduit-500" />
                  </div>
                  <div className="min-w-0">
                    <h2 className="text-lg font-semibold text-ink leading-tight">
                      {step.title}
                    </h2>
                    <p className="text-sm text-ink-muted mt-1 leading-relaxed">
                      {step.description}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Vertical divider */}
            <div className="w-px bg-stroke-dim my-8" />

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
                  <span className="text-[11px] font-semibold text-ink-faint uppercase tracking-wider">
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
                      <div className="w-5 h-5 rounded-full bg-conduit-500/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                        <CheckIcon size={12} className="text-conduit-500" />
                      </div>
                      <span className="text-sm text-ink-secondary leading-relaxed">
                        {detail}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* ── Fixed footer — never moves ── */}
              <div className="flex-shrink-0 pt-5">
                {/* Step counter */}
                <div className="text-xs text-ink-faint mb-3">
                  {currentStep + 1} of {steps.length}
                </div>

                {/* Dot indicators */}
                <div className="flex items-center gap-1.5 mb-5">
                  {steps.map((_, i) => (
                    <button
                      key={i}
                      onClick={() => goTo(i)}
                      className={`h-1.5 rounded-full transition-all duration-300 ${
                        i === currentStep
                          ? "w-6 bg-conduit-500"
                          : i < currentStep
                            ? "w-1.5 bg-conduit-500/40"
                            : "w-1.5 bg-ink-faint/30"
                      }`}
                    />
                  ))}
                </div>

                {/* Navigation buttons */}
                <div className="flex items-center justify-between">
                  <button
                    onClick={finish}
                    className="text-sm text-ink-muted hover:text-ink hover:underline transition-colors"
                  >
                    Skip
                  </button>

                  <div className="flex items-center gap-2">
                    {!isFirst && (
                      <button
                        onClick={() => goTo(currentStep - 1)}
                        disabled={isAnimating}
                        className="flex items-center justify-center gap-1 px-3 py-1.5 text-sm rounded border border-stroke hover:bg-raised transition-colors text-ink-secondary disabled:opacity-50"
                      >
                        <ChevronLeftIcon size={16} />
                        Back
                      </button>
                    )}

                    {isLast ? (
                      <button
                        onClick={finish}
                        className="flex items-center justify-center px-5 py-1.5 text-sm font-medium rounded bg-conduit-500 hover:bg-conduit-600 text-white transition-colors"
                      >
                        Get Started
                      </button>
                    ) : (
                      <button
                        onClick={() => goTo(currentStep + 1)}
                        disabled={isAnimating}
                        className="flex items-center justify-center gap-1.5 pl-3.5 pr-3 py-1.5 text-sm font-medium rounded bg-conduit-500 hover:bg-conduit-600 text-white transition-colors disabled:opacity-50"
                      >
                        Next
                        <ChevronRightIcon size={16} />
                      </button>
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
