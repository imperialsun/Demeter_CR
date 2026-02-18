import { NavLink } from "react-router-dom";
import { cn } from "@/lib/utils";
import { Activity, type LucideIcon, Bot, Cloud, FileText, Monitor, Settings } from "lucide-react";
import { BrandMark } from "@/components/branding/BrandMark";

type NavItem = {
  to: string;
  label: string;
  icon: LucideIcon;
  preload?: () => Promise<unknown>;
};

const NAV_ITEMS: NavItem[] = [
  { to: "/localupload", label: "Transcription locale", icon: Monitor },
  {
    to: "/cloudupload",
    label: "Transcription cloud",
    icon: Cloud,
    preload: () => import("@/routes/CloudUploadPage"),
  },
  {
    to: "/llmlocal",
    label: "LLM Local",
    icon: Bot,
    preload: () => import("@/routes/LLMLocalPage"),
  },
  {
    to: "/llmapi",
    label: "LLM Cloud",
    icon: FileText,
    preload: () => import("@/routes/LLMApiPage"),
  },
  {
    to: "/settings",
    label: "Paramètres",
    icon: Settings,
    preload: () => import("@/routes/SettingsPage"),
  },
  {
    to: "/telemetry",
    label: "Télémetrie",
    icon: Activity,
    preload: () => import("@/routes/TelemetryPage"),
  },
];

export function Sidebar() {
  const triggerPreload = (preload?: () => Promise<unknown>) => {
    if (!preload) return;
    void preload();
  };

  return (
    <aside className="hidden w-64 border-r bg-card/40 p-4 md:flex md:flex-col">
      <div className="mb-6">
        <BrandMark size="md" showTagline />
      </div>
      <nav className="flex flex-1 flex-col gap-1">
        {NAV_ITEMS.map(({ to, label, icon: Icon, preload }) => (
          <NavLink
            key={to}
            to={to}
            onMouseEnter={() => triggerPreload(preload)}
            onFocus={() => triggerPreload(preload)}
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
      <p className="mt-6 text-xs text-muted-foreground">
        Whisper sur Transformers.js — Chrome uniquement
      </p>
    </aside>
  );
}
