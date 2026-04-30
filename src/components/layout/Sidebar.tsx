import { useEffect } from "react";
import { NavLink } from "react-router-dom";
import { Activity, type LucideIcon, Bot, Cloud, FileText, Monitor, Settings, WandSparkles } from "lucide-react";

import { BrandMark } from "@/components/branding/BrandMark";
import { useBackendPermissions } from "@/hooks/useBackendPermissions";
import { canAccessFeature, type FeaturePermission } from "@/lib/backend-permissions";
import logger from "@/lib/logger";
import { cn } from "@/lib/utils";

type NavItem = {
  to: string;
  label: string;
  icon: LucideIcon;
  permission?: FeaturePermission;
  preload?: () => Promise<unknown>;
};

const NAV_ITEMS: NavItem[] = [
  {
    to: "/assistant",
    label: "Assistant",
    icon: WandSparkles,
    permission: "feature.assistant",
    preload: () => import("@/routes/AssistantPage"),
  },
  { to: "/localupload", label: "Transcription locale", icon: Monitor, permission: "feature.localupload" },
  {
    to: "/cloudupload",
    label: "Transcription",
    icon: Cloud,
    permission: "feature.cloudupload",
    preload: () => import("@/routes/CloudUploadPage"),
  },
  {
    to: "/llmlocal",
    label: "LLM Local",
    icon: Bot,
    permission: "feature.llmlocal",
    preload: () => import("@/routes/LLMLocalPage"),
  },
  {
    to: "/llmapi",
    label: "Rédaction",
    icon: FileText,
    permission: "feature.llmapi",
    preload: () => import("@/routes/LLMApiPage"),
  },
  {
    to: "/settings",
    label: "Paramètres",
    icon: Settings,
    permission: "feature.settings",
    preload: () => import("@/routes/SettingsPage"),
  },
  {
    to: "/telemetry",
    label: "Télémetrie",
    icon: Activity,
    permission: "feature.telemetry",
    preload: () => import("@/routes/TelemetryPage"),
  },
];

export function Sidebar() {
  useBackendPermissions();

  const visibleItems = NAV_ITEMS.filter((item) => {
    if (!item.permission) return true;
    return canAccessFeature(item.permission);
  });
  const visibleItemsKey = visibleItems.map((item) => item.to).join("|");

  const triggerPreload = (preload?: () => Promise<unknown>) => {
    if (!preload) return;
    logger.debug("[ui][sidebar] preloading route chunk");
    void preload();
  };

  useEffect(() => {
    logger.info("[ui][sidebar] visible navigation updated", {
      items: visibleItems.map((item) => item.to),
    });
  }, [visibleItems, visibleItemsKey]);

  return (
    <aside className="hidden w-64 border-r bg-card/40 p-4 md:flex md:flex-col">
      <div className="mb-6">
        <BrandMark size="md" showTagline />
      </div>
      <nav className="flex flex-1 flex-col gap-1">
        {visibleItems.map(({ to, label, icon: Icon, preload }) => (
          <NavLink
            key={to}
            to={to}
            onMouseEnter={() => {
              logger.debug("[ui][sidebar] hover navigation item", { to, label });
              triggerPreload(preload);
            }}
            onFocus={() => {
              logger.debug("[ui][sidebar] focus navigation item", { to, label });
              triggerPreload(preload);
            }}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )
            }
          >
            <Icon className="h-4 w-4" />
            {label}
          </NavLink>
        ))}
      </nav>
      <p className="mt-6 text-xs text-muted-foreground">Transcription locale et distante · Chrome uniquement</p>
    </aside>
  );
}
