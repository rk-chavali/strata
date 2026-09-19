import { useCallback, useEffect, useRef, useState } from "react";
import { api, setConnectionId } from "./api";
import type { Lock, Peer } from "./types";

/**
 * Live awareness of everyone else in the workspace.
 *
 * The browser's own `EventSource` handles reconnection, including backoff and resuming
 * after a laptop wakes from sleep. That is most of the hard part of a live connection,
 * and it is why this is under a hundred lines rather than a small state machine of our
 * own that would get the edge cases wrong.
 *
 * A reconnect issues a *new* connection id, so anything keyed to the old one, the
 * "where am I" announcement, any lock this tab held, has to be re-established. The
 * `hello` handler is the single place that happens.
 */

export interface PresenceState {
  connectionId: string | undefined;
  connected: boolean;
  peers: Peer[];
  locks: Lock[];
}

interface Options {
  /** Off when signed out: opening a stream that will 401 on a loop helps nobody. */
  enabled: boolean;
  /** Called when someone else changed the repo, so the app can refetch. */
  onChanged: (change: { scope: string; by?: string }) => void;
}

export function usePresence({ enabled, onChanged }: Options): PresenceState & {
  claim: (objectId: string, name?: string) => Promise<Lock | undefined>;
  release: (objectId: string) => void;
  lockFor: (objectId: string) => Lock | undefined;
} {
  const [state, setState] = useState<PresenceState>({
    connectionId: undefined,
    connected: false,
    peers: [],
    locks: [],
  });

  // Kept in a ref as well as state: the EventSource handlers are created once and would
  // otherwise close over the first render's value forever.
  const changedRef = useRef(onChanged);
  changedRef.current = onChanged;
  const connectionRef = useRef<string | undefined>(undefined);
  const heldRef = useRef(new Set<string>());

  useEffect(() => {
    if (!enabled) {
      setConnectionId(undefined);
      connectionRef.current = undefined;
      setState({ connectionId: undefined, connected: false, peers: [], locks: [] });
      return;
    }

    const source = new EventSource("/api/events", { withCredentials: true });

    source.addEventListener("hello", (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as { connectionId: string };
      connectionRef.current = data.connectionId;
      setConnectionId(data.connectionId);
      setState((prev) => ({ ...prev, connectionId: data.connectionId, connected: true }));
    });

    source.addEventListener("presence", (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as { peers: Peer[] };
      setState((prev) => ({ ...prev, peers: data.peers }));
    });

    source.addEventListener("locks", (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as { locks: Lock[] };
      setState((prev) => ({ ...prev, locks: data.locks }));
    });

    source.addEventListener("changed", (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as {
        scope: string;
        by?: string;
      };
      changedRef.current(data);
    });

    source.onerror = () => {
      // `EventSource` retries on its own; this only reflects the gap in the UI. Marking
      // the connection id undefined here would be wrong, the retry usually succeeds in
      // a second or two and the id is still valid until `hello` replaces it.
      setState((prev) => ({ ...prev, connected: false }));
    };

    return () => {
      source.close();
      setConnectionId(undefined);
      connectionRef.current = undefined;
    };
  }, [enabled]);

  /**
   * Renew held locks before they lapse.
   *
   * Re-claiming is idempotent for the current holder, so this doubles as the recovery
   * path after a reconnect: whatever this tab still has open gets re-asserted under the
   * new connection id without any special case.
   */
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      const connection = connectionRef.current;
      if (!connection || heldRef.current.size === 0) return;
      for (const objectId of heldRef.current) {
        void api.claimLock({ objectId, connectionId: connection }).catch(() => {
          // Lost it to someone else, or the server restarted. The `locks` broadcast is
          // what the UI actually renders, so it will correct itself.
        });
      }
    }, 45_000);
    return () => clearInterval(timer);
  }, [enabled]);

  const claim = useCallback(async (objectId: string, name?: string) => {
    const connection = connectionRef.current;
    if (!connection) return undefined;
    const result = await api.claimLock({ objectId, connectionId: connection, ...(name ? { name } : {}) });
    heldRef.current.add(objectId);
    return result.lock;
  }, []);

  const release = useCallback((objectId: string) => {
    const connection = connectionRef.current;
    heldRef.current.delete(objectId);
    if (!connection) return;
    void api.releaseLock(objectId, connection).catch(() => {
      // Best effort. If this never lands the lock expires on its own within two minutes,
      // which is the whole reason it has a TTL.
    });
  }, []);

  const lockFor = useCallback(
    (objectId: string) => state.locks.find((lock) => lock.objectId === objectId),
    [state.locks],
  );

  return { ...state, claim, release, lockFor };
}

/** Announce which model this tab is looking at, so peers show up in the right place. */
export function useAnnounceLocation(
  connectionId: string | undefined,
  model: string | undefined,
  diagram: string | undefined,
): void {
  useEffect(() => {
    if (!connectionId) return;
    void api
      .announceWhere({
        connectionId,
        ...(model ? { model } : {}),
        ...(diagram ? { diagram } : {}),
      })
      .catch(() => {
        // Presence is decoration; a failed announcement must never surface as an error.
      });
  }, [connectionId, model, diagram]);
}
