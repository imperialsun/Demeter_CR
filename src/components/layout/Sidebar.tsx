import { NavLink } from "react-router-dom";
import { cn } from "@/lib/utils";
import { Activity, Bot, Cloud, FileText, Monitor, Settings } from "lucide-react";
import { BrandMark } from "@/components/branding/BrandMark";

const NAV_ITEMS = [
  { to: "/localupload", label: "Transcription locale", icon: Monitor },
  { to: "/cloudupload", label: "Transcription cloud", icon: Cloud },
  { to: "/llmlocal", label: "LLM Local", icon: Bot },
  { to: "/llmapi", label: "LLM Cloud", icon: FileText },
  { to: "/settings", label: "Paramètres", icon: Settings },
  { to: "/telemetry", label: "Télémetrie", icon: Activity },
];

export function Sidebar() {
  return (
    <aside className="hidden w-64 border-r bg-card/40 p-4 md:flex md:flex-col">
      <div className="mb-6">
        <BrandMark size="md" showTagline />
      </div>
      <nav className="flex flex-1 flex-col gap-1">
        {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
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
