import { checkCampfireInstalled } from '@tloncorp/api';
import {
  CampfireActiveCall,
  CampfireCallsContext,
  CampfireCallsContextValue,
  CampfireCallStatus,
  CampfireIncomingCall,
} from '@tloncorp/app/contexts/campfireCalls';
import {
  PropsWithChildren,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  CampfireCall,
  rejectIncomingCall,
  watchIceServers,
  watchIncomingCalls,
} from './engine';

function toCallStatus(switchboardState: string): CampfireCallStatus {
  switch (switchboardState) {
    case 'dialing':
      return 'dialing';
    case 'incoming-ringing':
      return 'ringing';
    default:
      // connected-our-turn / connected-their-turn / connected-our-turn-asked
      return 'connected';
  }
}

export function CampfireCallProvider({ children }: PropsWithChildren) {
  const [supported, setSupported] = useState(false);
  const [activeCall, setActiveCall] = useState<CampfireActiveCall | null>(
    null
  );
  const [incomingCall, setIncomingCall] =
    useState<CampfireIncomingCall | null>(null);

  const callRef = useRef<CampfireCall | null>(null);
  const iceServersRef = useRef<RTCIceServer[]>([]);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    let cancelled = false;
    checkCampfireInstalled().then((installed) => {
      if (cancelled || !installed) {
        return;
      }
      setSupported(true);
      watchIncomingCalls({
        onIncoming: (peer, uuid) => {
          // Busy: decline a second call outright.
          if (callRef.current) {
            rejectIncomingCall(uuid).catch(() => {});
            return;
          }
          setIncomingCall({ peer, uuid });
        },
        onHangup: (uuid) => {
          setIncomingCall((cur) => (cur?.uuid === uuid ? null : cur));
        },
      }).catch((err) => console.warn('campfire incoming watch failed', err));
      watchIceServers((server) => {
        iceServersRef.current = [...iceServersRef.current, server];
      }).catch(() => {});
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const startCall = useCallback((peer: string, uuid: string | null) => {
    if (callRef.current) {
      return;
    }
    const isCaller = uuid === null;
    const call = new CampfireCall(
      peer,
      uuid,
      {
        onSwitchboardState: (state) => {
          setActiveCall((cur) =>
            cur && callRef.current === call
              ? { ...cur, uuid: call.uuid, status: toCallStatus(state) }
              : cur
          );
        },
        onRemoteStream: (stream) => {
          if (audioRef.current) {
            audioRef.current.srcObject = stream;
            audioRef.current.play().catch(() => {});
          }
        },
        onLocalStream: () => {},
        onEnded: () => {
          if (callRef.current === call) {
            callRef.current = null;
            setActiveCall(null);
            if (audioRef.current) {
              audioRef.current.srcObject = null;
            }
          }
        },
        onError: () => {},
      },
      { iceServers: iceServersRef.current }
    );
    callRef.current = call;
    setActiveCall({
      uuid,
      peer,
      isCaller,
      status: isCaller ? 'dialing' : 'ringing',
      micMuted: false,
    });
    call.start().catch((err) => {
      console.error('campfire call failed to start', err);
      call.hangup();
    });
  }, []);

  const placeCall = useCallback(
    (peer: string) => startCall(peer, null),
    [startCall]
  );

  const answerCall = useCallback(() => {
    setIncomingCall((incoming) => {
      if (incoming) {
        startCall(incoming.peer, incoming.uuid);
      }
      return null;
    });
  }, [startCall]);

  const rejectCall = useCallback(() => {
    setIncomingCall((incoming) => {
      if (incoming) {
        rejectIncomingCall(incoming.uuid).catch(() => {});
      }
      return null;
    });
  }, []);

  const hangup = useCallback(() => {
    callRef.current?.hangup();
  }, []);

  const toggleMute = useCallback(() => {
    const muted = callRef.current?.toggleMute() ?? false;
    setActiveCall((cur) => (cur ? { ...cur, micMuted: muted } : cur));
  }, []);

  const value: CampfireCallsContextValue = useMemo(
    () => ({
      supported,
      activeCall,
      incomingCall,
      placeCall,
      answerCall,
      rejectCall,
      hangup,
      toggleMute,
    }),
    [
      supported,
      activeCall,
      incomingCall,
      placeCall,
      answerCall,
      rejectCall,
      hangup,
      toggleMute,
    ]
  );

  return (
    <CampfireCallsContext.Provider value={value}>
      {children}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={audioRef} autoPlay />
      <CallOverlay
        activeCall={activeCall}
        incomingCall={incomingCall}
        onAnswer={answerCall}
        onReject={rejectCall}
        onHangup={hangup}
        onToggleMute={toggleMute}
      />
    </CampfireCallsContext.Provider>
  );
}

const overlayStyles = {
  container: {
    position: 'fixed',
    bottom: 24,
    right: 24,
    zIndex: 9999,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    alignItems: 'center',
    background: 'var(--overlay-bg, #1a1818)',
    color: '#fff',
    borderRadius: 12,
    padding: '16px 20px',
    boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
    fontFamily: 'inherit',
    minWidth: 220,
  } as const,
  peer: { fontWeight: 600, fontSize: 15 } as const,
  status: { fontSize: 13, opacity: 0.7 } as const,
  buttonRow: { display: 'flex', gap: 8 } as const,
  button: {
    border: 'none',
    borderRadius: 8,
    padding: '8px 14px',
    fontSize: 13,
    cursor: 'pointer',
    color: '#fff',
  } as const,
};

function CallOverlay({
  activeCall,
  incomingCall,
  onAnswer,
  onReject,
  onHangup,
  onToggleMute,
}: {
  activeCall: CampfireActiveCall | null;
  incomingCall: CampfireIncomingCall | null;
  onAnswer: () => void;
  onReject: () => void;
  onHangup: () => void;
  onToggleMute: () => void;
}) {
  if (incomingCall && !activeCall) {
    return (
      <div style={overlayStyles.container} data-testid="CampfireIncomingCall">
        <div style={overlayStyles.peer}>{incomingCall.peer}</div>
        <div style={overlayStyles.status}>Incoming audio call</div>
        <div style={overlayStyles.buttonRow}>
          <button
            style={{ ...overlayStyles.button, background: '#2a9d3f' }}
            onClick={onAnswer}
            data-testid="CampfireAnswerButton"
          >
            Answer
          </button>
          <button
            style={{ ...overlayStyles.button, background: '#c53030' }}
            onClick={onReject}
            data-testid="CampfireRejectButton"
          >
            Decline
          </button>
        </div>
      </div>
    );
  }

  if (!activeCall) {
    return null;
  }

  const statusLabel =
    activeCall.status === 'dialing'
      ? 'Calling…'
      : activeCall.status === 'ringing'
        ? 'Ringing…'
        : activeCall.micMuted
          ? 'Connected · muted'
          : 'Connected';

  return (
    <div style={overlayStyles.container} data-testid="CampfireActiveCall">
      <div style={overlayStyles.peer}>{activeCall.peer}</div>
      <div style={overlayStyles.status} data-testid="CampfireCallStatus">
        {statusLabel}
      </div>
      <div style={overlayStyles.buttonRow}>
        <button
          style={{ ...overlayStyles.button, background: '#444' }}
          onClick={onToggleMute}
          data-testid="CampfireMuteButton"
        >
          {activeCall.micMuted ? 'Unmute' : 'Mute'}
        </button>
        <button
          style={{ ...overlayStyles.button, background: '#c53030' }}
          onClick={onHangup}
          data-testid="CampfireHangupButton"
        >
          Hang up
        </button>
      </div>
    </div>
  );
}
