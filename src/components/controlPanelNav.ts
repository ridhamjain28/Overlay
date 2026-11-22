import type React from "react";
import { useTranslation } from "react-i18next";
import { Home, MessageSquare } from "./icons";

export type ControlPanelView = "home" | "chat";

export interface ControlPanelNavItem {
  id: ControlPanelView;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}

/**
 * Single source of truth for main-window navigation. Overlay does two things
 * (dictation and computer control by voice), so the app has just Home (recent
 * dictation history) and Chat (the assistant). Settings opens from the sidebar.
 */
export function useControlPanelNavItems(): ControlPanelNavItem[] {
  const { t } = useTranslation();
  return [
    { id: "home", label: t("sidebar.home"), icon: Home },
    { id: "chat", label: t("sidebar.chat"), icon: MessageSquare },
  ];
}