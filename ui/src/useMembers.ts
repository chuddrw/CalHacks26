/** WHAT IT'S FOR: React hooks over members.ts, so a component re-renders when names or the identity change. */
import { useSyncExternalStore } from "react";
import { getIdentity, getMembers, subscribeMembers } from "./members";

export const useMembers = () => useSyncExternalStore(subscribeMembers, getMembers);
export const useIdentity = () => useSyncExternalStore(subscribeMembers, getIdentity);
