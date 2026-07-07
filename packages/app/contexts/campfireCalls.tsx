import { createContext, useContext } from 'react';

// Campfire (https://github.com/mopfel-winrux/campfire) audio calls. The
// actual WebRTC engine only exists on web (apps/tlon-web/src/campfire), which
// mounts a real provider; everywhere else consumers see this inert default
// with `supported: false` and hide their call affordances.

export type CampfireCallStatus =
  | 'dialing'
  | 'ringing'
  | 'connected'
  | 'ended';

export interface CampfireActiveCall {
  uuid: string | null;
  peer: string;
  isCaller: boolean;
  status: CampfireCallStatus;
  /** RTCPeerConnectionState — whether media actually flows right now. */
  mediaState: string | null;
  /** Epoch ms when the call reached connected; drives the duration timer. */
  startedAt: number | null;
  micMuted: boolean;
}

export interface CampfireIncomingCall {
  uuid: string;
  peer: string;
}

/** A call the switchboard still considers live but this page lost track of
 * (e.g. after a reload). The user can rejoin or end it. */
export interface CampfireOrphanedCall {
  uuid: string;
  peer: string;
}

export interface CampfireMissedCall {
  peer: string;
  at: number;
}

export interface CampfireCallsContextValue {
  supported: boolean;
  activeCall: CampfireActiveCall | null;
  incomingCall: CampfireIncomingCall | null;
  orphanedCall: CampfireOrphanedCall | null;
  missedCalls: CampfireMissedCall[];
  placeCall: (peer: string) => void;
  answerCall: () => void;
  rejectCall: () => void;
  hangup: () => void;
  toggleMute: () => void;
  rejoinOrphanedCall: () => void;
  discardOrphanedCall: () => void;
  dismissMissedCall: (at: number) => void;
}

const noop = () => {};

const inertValue: CampfireCallsContextValue = {
  supported: false,
  activeCall: null,
  incomingCall: null,
  orphanedCall: null,
  missedCalls: [],
  placeCall: noop,
  answerCall: noop,
  rejectCall: noop,
  hangup: noop,
  toggleMute: noop,
  rejoinOrphanedCall: noop,
  discardOrphanedCall: noop,
  dismissMissedCall: noop,
};

export const CampfireCallsContext =
  createContext<CampfireCallsContextValue>(inertValue);

export function useCampfireCalls() {
  return useContext(CampfireCallsContext);
}
