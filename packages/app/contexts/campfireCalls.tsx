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
  micMuted: boolean;
}

export interface CampfireIncomingCall {
  uuid: string;
  peer: string;
}

export interface CampfireCallsContextValue {
  supported: boolean;
  activeCall: CampfireActiveCall | null;
  incomingCall: CampfireIncomingCall | null;
  placeCall: (peer: string) => void;
  answerCall: () => void;
  rejectCall: () => void;
  hangup: () => void;
  toggleMute: () => void;
}

const noop = () => {};

const inertValue: CampfireCallsContextValue = {
  supported: false,
  activeCall: null,
  incomingCall: null,
  placeCall: noop,
  answerCall: noop,
  rejectCall: noop,
  hangup: noop,
  toggleMute: noop,
};

export const CampfireCallsContext =
  createContext<CampfireCallsContextValue>(inertValue);

export function useCampfireCalls() {
  return useContext(CampfireCallsContext);
}
