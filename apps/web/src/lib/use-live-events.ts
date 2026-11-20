"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { config } from "./config";
import { connectLive, eventsUrl, keyBatcher, queryKeysForEvent, type LiveStatus } from "./api/live";

/**
 * Keeps React Query data in sync with the API's SSE stream. Pass a bounty id to
 * receive only that bounty's events. Returns "live" while connected; callers
 * should fall back to polling otherwise. Disabled in mock mode.
 */
export function useLiveEvents(bountyId?: string): LiveStatus | "off" {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<LiveStatus | "off">(config.mock ? "off" : "connecting");

  useEffect(() => {
    if (config.mock || typeof EventSource === "undefined") {
      setStatus("off");
      return;
    }
    const batch = keyBatcher((queryKey) => void queryClient.invalidateQueries({ queryKey }));
    const stop = connectLive({
      url: eventsUrl(config.apiUrl, bountyId),
      onStatus: setStatus,
      // Catch up on anything missed before (or between) connections.
      onReady: () => batch.add(bountyId ? [["bounty", bountyId], ["submissions", bountyId]] : [["bounties"]]),
      onEvent: (e) => batch.add(queryKeysForEvent(e)),
    });
    return () => {
      stop();
      batch.cancel();
    };
  }, [bountyId, queryClient]);

  return status;
}
