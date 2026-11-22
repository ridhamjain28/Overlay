import React, { Suspense, lazy } from "react";
import { Skeleton } from "./ui/skeleton";
import PreferencesSettings from "./settings/PreferencesSettings";
import HotkeysSettings from "./settings/HotkeysSettings";

// Heavier panels load on first visit so opening Settings stays instant.
const ToneStyleSection = lazy(() => import("./settings/ToneStyleSection"));
const SpeechToTextSettings = lazy(() => import("./settings/SpeechToTextSettings"));
const LanguageModelsSettings = lazy(() => import("./settings/LanguageModelsSettings"));

/**
 * Preferences, Hotkeys, Tone & Style, and AI Models (Speech-to-Text and
 * Language Models). There are no accounts, plans or per-feature AI tabs.
 */
export type SettingsSectionType = "general" | "hotkeys" | "toneStyle" | "speechToText" | "llms";

interface SettingsPageProps {
  activeSection?: SettingsSectionType;
  onNavigateToSection?: (section: SettingsSectionType, subTab?: string) => void;
}

function PanelFallback() {
  return (
    <div className="space-y-3" aria-busy="true">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

export default function SettingsPage({
  activeSection = "general",
  onNavigateToSection,
}: SettingsPageProps) {
  switch (activeSection) {
    case "hotkeys":
      return <HotkeysSettings />;
    case "toneStyle":
      return (
        <Suspense fallback={<PanelFallback />}>
          <ToneStyleSection onOpenCleanupSettings={() => onNavigateToSection?.("llms")} />
        </Suspense>
      );
    case "speechToText":
      return (
        <Suspense fallback={<PanelFallback />}>
          <SpeechToTextSettings />
        </Suspense>
      );
    case "llms":
      return (
        <Suspense fallback={<PanelFallback />}>
          <LanguageModelsSettings />
        </Suspense>
      );
    case "general":
    default:
      return <PreferencesSettings />;
  }
}
