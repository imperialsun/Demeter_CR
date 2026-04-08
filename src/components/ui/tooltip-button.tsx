import * as React from "react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type TooltipSide = "top" | "right" | "bottom" | "left";

export interface TooltipButtonProps extends ButtonProps {
  tooltip: React.ReactNode;
  tooltipSide?: TooltipSide;
  tooltipClassName?: string;
  tooltipDelay?: number;
}

export function TooltipButton({
  tooltip,
  tooltipSide = "top",
  tooltipClassName,
  tooltipDelay = 150,
  type = "button",
  children,
  className,
  ...buttonProps
}: TooltipButtonProps) {
  return (
    <TooltipProvider delayDuration={tooltipDelay}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type={type} className={className} {...buttonProps}>
            {children}
          </Button>
        </TooltipTrigger>
        <TooltipContent side={tooltipSide} className={cn("max-w-72 text-balance", tooltipClassName)}>
          {tooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
