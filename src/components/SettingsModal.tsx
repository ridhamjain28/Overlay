import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePolicyStore } from "../stores/policyStore";
import { Sliders, Mic, Brain, Keyboard, ShieldCheck, SquareSparkle } from "./icons";
import SidebarModal, { type SidebarItem } from "./ui/SidebarModal";
import SettingsPage, { SettingsSectionType } from "./SettingsPage";

export type { SettingsSectionType };

// Older deep-links (Home banners, toasts) land on the closest remaining section.
const SECTION_ALIASES: Record<string, SettingsSectionType> = {
  account: "general",
  plansBilling: "general",
  workspace: "general",
  privacyData: "general",
  privacy: "general",
  permissions: "general",
  system: "general",
  softwareUpdates: "general",
  developer: "general",
  dictionary: "general",
  aiModels: "llms",
  agentConfig: "llms",
  agentMode: "llms",
  dictationAgent: "llms",
  intelligence: "llms",
  noteFormatting: "llms",
  prompts: "llms",
  meetings: "llms",
  transcription: "speechToText",
  uploadTranscription: "speechToText",
  advanced: "llms",
};

interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSection?: string;
}

export default function SettingsModal({ open, onOpenChange, initialSection }: SettingsModalProps) {
  const { t } = useTranslation();
  const policyManaged = usePolicyStore((s) => s.managed);
  const sidebarItems: SidebarItem<SettingsSectionType>[] = useMemo(
    () => [
      {
        id: "general",
        label: t("settingsModal.sections.general.label"),
        icon: Sliders,
        description: t("settingsModal.sections.general.description"),
        group: t("settingsModal.groups.app"),
      },
      {
        id: "hotkeys",
        label: t("settingsModal.sections.hotkeys.label"),
        icon: Keyboard,
        description: t("settingsModal.sections.hotkeys.description"),
        group: t("settingsModal.groups.app"),
      },
      {
        id: "toneStyle",
        label: t("settingsModal.sections.toneStyle.label"),
        icon: SquareSparkle,
        description: t("settingsModal.sections.toneStyle.description"),
        group: t("settingsModal.groups.app"),
      },
      {
        id: "speechToText",
        label: t("settingsModal.sections.speechToText.label"),
        icon: Mic,
        description: t("settingsModal.sections.speechToText.description"),
        group: t("settingsModal.groups.aiModels"),
      },
      {
        id: "llms",
        label: t("settingsModal.sections.llms.label"),
        icon: Brain,
        description: t("settingsModal.sections.llms.description"),
        group: t("settingsModal.groups.aiModels"),
      },
    ],
    [t]
  );

  const resolveSection = (section: string | undefined): SettingsSectionType => {
    if (!section) return "general";
    return (SECTION_ALIASES[section] ?? section) as SettingsSectionType;
  };

  const [activeSection, setActiveSection] = useState<SettingsSectionType>(() =>
    resolveSection(initialSection)
  );
  const [prevOpen, setPrevOpen] = useState(open);

  if (open && !prevOpen && initialSection) {
    setPrevOpen(open);
    setActiveSection(resolveSection(initialSection));
  } else if (open !== prevOpen) {
    setPrevOpen(open);
  }

  return (
    <SidebarModal<SettingsSectionType>
      open={open}
      onOpenChange={onOpenChange}
      title={t("settingsModal.title")}
      sidebarItems={sidebarItems}
      activeSection={activeSection}
      onSectionChange={setActiveSection}
      notice={
        policyManaged
          ? {
              icon: <ShieldCheck className="h-3.5 w-3.5 shrink-0" />,
              label: t("settingsModal.managedAccount"),
              description: t("settingsModal.managedByOrg"),
            }
          : undefined
      }
    >
      <SettingsPage activeSection={activeSection} onNavigateToSection={setActiveSection} />
    </SidebarModal>
  );
}
