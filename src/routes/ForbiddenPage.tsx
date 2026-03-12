import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getFirstAuthorizedRoute } from "@/lib/backend-permissions";
import logger from "@/lib/logger";
import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";

type ForbiddenLocationState = {
  from?: string;
  permission?: string;
};

export default function ForbiddenPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as ForbiddenLocationState | null;
  const fallbackRoute = getFirstAuthorizedRoute();

  useEffect(() => {
    logger.warn("[route][forbidden] page mounted", {
      from: state?.from ?? null,
      permission: state?.permission ?? null,
      fallbackRoute,
    });
    return () => {
      logger.debug("[route][forbidden] page unmounted");
    };
  }, [fallbackRoute, state?.from, state?.permission]);

  return (
    <div className="mx-auto max-w-xl py-10">
      <Card>
        <CardHeader>
          <CardTitle>Accès refusé</CardTitle>
          <CardDescription>Cette page n'est pas autorisée pour votre profil backend.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {state?.permission ? (
            <p className="text-sm text-muted-foreground">
              Permission requise: <span className="font-medium text-foreground">{state.permission}</span>
            </p>
          ) : null}
          {state?.from ? (
            <p className="text-sm text-muted-foreground">
              Route demandée: <span className="font-medium text-foreground">{state.from}</span>
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">Accès refusé par vos permissions backend.</p>
          <Button
            onClick={() => {
              logger.info("[route][forbidden] navigating to first authorized route", {
                target: fallbackRoute,
              });
              navigate(fallbackRoute, { replace: true });
            }}
          >
            Aller à une page autorisée
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
