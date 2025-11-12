"use client";

import { Card } from "@/components/ui/card";

export function LoadingSpinner() {
  return (
    <Card className="p-12 border-none shadow-none bg-transparent">
      <div className="flex flex-col items-center justify-center gap-6">
        {/* Three bouncing dots */}
        <div className="flex gap-2">
          <div className="w-3 h-3 bg-primary rounded-full animate-bounce [animation-delay:-0.3s]" />
          <div className="w-3 h-3 bg-primary rounded-full animate-bounce [animation-delay:-0.15s]" />
          <div className="w-3 h-3 bg-primary rounded-full animate-bounce" />
        </div>
        
        <p className="text-sm font-medium text-muted-foreground">
          Loading warehouses...
        </p>
      </div>
    </Card>
  );
}
