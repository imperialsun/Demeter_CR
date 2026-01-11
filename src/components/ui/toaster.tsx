import { Toaster as SonnerToaster, type ToasterProps } from "sonner";

export function Toaster(props: ToasterProps) {
  return (
    <SonnerToaster
      position="top-right"
      richColors
      duration={4000}
      closeButton
      theme="system"
      toastOptions={{ className: "border border-border bg-background text-foreground" }}
      {...props}
    />
  );
}
