import { checkCampfireInstalled, getCurrentUserId } from '@tloncorp/api';
import {
  CampfireActiveCall,
  CampfireCallsContext,
  CampfireCallsContextValue,
  CampfireCallStatus,
  CampfireIncomingCall,
  CampfireMissedCall,
  CampfireOrphanedCall,
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
  SwitchboardState,
  checkLiveCall,
  rejectIncomingCall,
  watchIceServers,
  watchIncomingCalls,
} from './engine';
import { CallSounds } from './sounds';

const STORAGE_KEY = 'tlon-campfire-active-call';
const MAX_MISSED = 5;

function toCallStatus(state: SwitchboardState): CampfireCallStatus {
  switch (state) {
    case 'placing':
    case 'dialing':
      return 'dialing';
    case 'ringing': // remote side is ringing
    case 'incoming-ringing':
    case 'answering':
      return 'ringing';
    default:
      return 'connected';
  }
}

function requestNotificationPermission() {
  try {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  } catch {
    // notifications unavailable
  }
}

function notify(title: string, body: string) {
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      const n = new Notification(title, { body, tag: 'campfire-call' });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    }
  } catch {
    // notifications unavailable
  }
}

function rememberCall(uuid: string, peer: string) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ uuid, peer }));
  } catch {
    // storage unavailable
  }
}

function forgetCall() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage unavailable
  }
}

function recallCall(): CampfireOrphanedCall | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (typeof parsed?.uuid === 'string' && typeof parsed?.peer === 'string') {
      return parsed;
    }
  } catch {
    // storage unavailable / corrupt
  }
  return null;
}

export function CampfireCallProvider({ children }: PropsWithChildren) {
  const [supported, setSupported] = useState(false);
  const [activeCall, setActiveCall] = useState<CampfireActiveCall | null>(
    null
  );
  const [incomingCall, setIncomingCall] =
    useState<CampfireIncomingCall | null>(null);
  const [orphanedCall, setOrphanedCall] =
    useState<CampfireOrphanedCall | null>(null);
  const [missedCalls, setMissedCalls] = useState<CampfireMissedCall[]>([]);

  const callRef = useRef<CampfireCall | null>(null);
  const activeCallRef = useRef<CampfireActiveCall | null>(null);
  // Set while the page is unloading: pokes aborted by navigation look like
  // call failures, and their cleanup must not erase the remembered call that
  // the next load's orphan check relies on.
  const unloadingRef = useRef(false);
  const iceServersRef = useRef<RTCIceServer[]>([]);
  const audioRef = useRef<HTMLAudioElement>(null);
  const soundsRef = useRef<CallSounds | null>(null);
  if (!soundsRef.current) {
    soundsRef.current = new CallSounds();
  }

  activeCallRef.current = activeCall;

  const addMissedCall = useCallback((peer: string) => {
    setMissedCalls((cur) =>
      [{ peer, at: Date.now() }, ...cur].slice(0, MAX_MISSED)
    );
    notify('Missed call', `${peer} tried to call you`);
  }, []);

  const startCall = useCallback(
    (peer: string, uuid: string | null, reconnect = false) => {
      if (callRef.current) {
        return;
      }
      const isCaller = uuid === null;
      const call = new CampfireCall(
        peer,
        uuid,
        {
          onSwitchboardState: (state) => {
            const status = toCallStatus(state);
            setActiveCall((cur) =>
              cur && callRef.current === call
                ? {
                    ...cur,
                    uuid: call.uuid,
                    status,
                    startedAt:
                      cur.startedAt ??
                      (status === 'connected' ? Date.now() : null),
                  }
                : cur
            );
            if (call.uuid) {
              rememberCall(call.uuid, peer);
            }
          },
          onMediaState: (state) => {
            setActiveCall((cur) =>
              cur && callRef.current === call
                ? { ...cur, mediaState: state }
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
            if (unloadingRef.current) {
              return;
            }
            if (callRef.current === call) {
              callRef.current = null;
              setActiveCall(null);
              forgetCall();
              if (audioRef.current) {
                audioRef.current.srcObject = null;
              }
            }
          },
          onError: () => {},
        },
        { iceServers: iceServersRef.current },
        { reconnect }
      );
      callRef.current = call;
      setActiveCall({
        uuid,
        peer,
        isCaller,
        status: isCaller && !reconnect ? 'dialing' : 'ringing',
        mediaState: null,
        startedAt: null,
        micMuted: false,
      });
      call.start().catch((err) => {
        console.error('campfire call failed to start', err);
        call.hangup();
      });
    },
    []
  );

  const answerIncoming = useCallback(
    (incoming: CampfireIncomingCall) => {
      requestNotificationPermission();
      startCall(incoming.peer, incoming.uuid);
    },
    [startCall]
  );

  // Detect campfire, then watch for incoming calls, ICE servers, and any
  // call this page orphaned (e.g. by reloading mid-call).
  useEffect(() => {
    let cancelled = false;
    checkCampfireInstalled().then((installed) => {
      if (cancelled || !installed) {
        return;
      }
      setSupported(true);

      const remembered = recallCall();
      if (remembered) {
        (async () => {
          for (let attempt = 0; attempt < 5; attempt++) {
            const result = await checkLiveCall(remembered.uuid);
            if (cancelled) {
              return;
            }
            if (result.status === 'unknown') {
              // Scry failed (early boot, flaky connection) — retry rather
              // than misreading it as a dead call.
              await new Promise((r) => setTimeout(r, 2000));
              continue;
            }
            if (
              result.status === 'live' &&
              result.state.startsWith('connected')
            ) {
              setOrphanedCall(remembered);
            } else {
              // Gone, or live-but-not-connected (stale dial). Only clear
              // what we actually checked — a new call may have been placed
              // while the scry was in flight.
              const current = recallCall();
              if (current?.uuid === remembered.uuid) {
                forgetCall();
              }
            }
            return;
          }
        })();
      }

      watchIncomingCalls({
        onIncoming: (peer, uuid) => {
          const current = activeCallRef.current;
          if (current) {
            // Glare: both sides dialed each other at once. Resolve
            // deterministically — the side whose ship name sorts lower keeps
            // its outgoing call; the other cancels and answers.
            const samePeer = current.peer === peer;
            if (samePeer && current.status === 'dialing') {
              const us = getCurrentUserId().replace(/^~/, '');
              const them = peer.replace(/^~/, '');
              if (us < them) {
                rejectIncomingCall(uuid).catch(() => {});
              } else {
                callRef.current?.hangup();
                startCall(peer, uuid);
              }
              return;
            }
            // Busy on another call: decline and record it as missed.
            rejectIncomingCall(uuid).catch(() => {});
            addMissedCall(peer);
            return;
          }
          setIncomingCall({ peer, uuid });
          notify('Incoming call', `${peer} is calling you`);
        },
        onHangup: (uuid) => {
          setIncomingCall((cur) => {
            if (cur?.uuid === uuid) {
              // They gave up before we answered.
              addMissedCall(cur.peer);
              return null;
            }
            return cur;
          });
        },
      }).catch((err) => console.warn('campfire incoming watch failed', err));

      watchIceServers((server) => {
        iceServersRef.current = [...iceServersRef.current, server];
      }).catch(() => {});
    });
    return () => {
      cancelled = true;
    };
  }, [startCall, addMissedCall]);

  // Ring sounds follow call state.
  useEffect(() => {
    const sounds = soundsRef.current as CallSounds;
    if (incomingCall && !activeCall) {
      sounds.play('ringtone');
    } else if (
      activeCall?.isCaller &&
      (activeCall.status === 'dialing' || activeCall.status === 'ringing')
    ) {
      sounds.play('ringback');
    } else {
      sounds.stop();
    }
  }, [incomingCall, activeCall]);

  // If the tab closes mid-call, tell the switchboard via sendBeacon — a
  // normal poke wouldn't survive unload.
  useEffect(() => {
    const uuid = activeCall?.uuid;
    if (!uuid) {
      return;
    }
    const onBeforeUnload = () => {
      unloadingRef.current = true;
      // If the navigation ends up cancelled, let call teardown behave
      // normally again.
      setTimeout(() => {
        unloadingRef.current = false;
      }, 5000);
      try {
        const ship = getCurrentUserId().replace(/^~/, '');
        const body = JSON.stringify([
          {
            id: 1,
            action: 'poke',
            ship,
            app: 'rtcswitchboard',
            mark: 'rtcswitchboard-from-client',
            json: { tag: 'reject', uuid },
          },
        ]);
        // Deliberately not clearing the remembered call here: if the beacon
        // fails, the next page load's liveness check offers a rejoin; if it
        // succeeds, that check cleans up.
        navigator.sendBeacon(
          `${window.location.origin}/~/channel/${Date.now()}`,
          new Blob([body], { type: 'application/json' })
        );
      } catch {
        // best effort
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [activeCall?.uuid]);

  const placeCall = useCallback(
    (peer: string) => {
      requestNotificationPermission();
      startCall(peer, null);
    },
    [startCall]
  );

  const answerCall = useCallback(() => {
    setIncomingCall((incoming) => {
      if (incoming) {
        answerIncoming(incoming);
      }
      return null;
    });
  }, [answerIncoming]);

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

  const rejoinOrphanedCall = useCallback(() => {
    setOrphanedCall((orphan) => {
      if (orphan && !callRef.current) {
        startCall(orphan.peer, orphan.uuid, true);
      }
      return null;
    });
  }, [startCall]);

  const discardOrphanedCall = useCallback(() => {
    setOrphanedCall((orphan) => {
      if (orphan) {
        rejectIncomingCall(orphan.uuid).catch(() => {});
        forgetCall();
      }
      return null;
    });
  }, []);

  const dismissMissedCall = useCallback((at: number) => {
    setMissedCalls((cur) => cur.filter((m) => m.at !== at));
  }, []);

  const selectMic = useCallback((deviceId: string) => {
    callRef.current?.setAudioDevice(deviceId).catch((err) => {
      console.warn('failed to switch microphone', err);
    });
  }, []);

  const value: CampfireCallsContextValue = useMemo(
    () => ({
      supported,
      activeCall,
      incomingCall,
      orphanedCall,
      missedCalls,
      placeCall,
      answerCall,
      rejectCall,
      hangup,
      toggleMute,
      rejoinOrphanedCall,
      discardOrphanedCall,
      dismissMissedCall,
    }),
    [
      supported,
      activeCall,
      incomingCall,
      orphanedCall,
      missedCalls,
      placeCall,
      answerCall,
      rejectCall,
      hangup,
      toggleMute,
      rejoinOrphanedCall,
      discardOrphanedCall,
      dismissMissedCall,
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
        orphanedCall={orphanedCall}
        missedCalls={missedCalls}
        onAnswer={answerCall}
        onReject={rejectCall}
        onHangup={hangup}
        onToggleMute={toggleMute}
        onRejoin={rejoinOrphanedCall}
        onDiscardOrphan={discardOrphanedCall}
        onDismissMissed={dismissMissedCall}
        onSelectMic={selectMic}
      />
    </CampfireCallsContext.Provider>
  );
}

const styles = {
  stack: {
    position: 'fixed',
    top: 72,
    right: 24,
    zIndex: 9999,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    alignItems: 'flex-end',
  } as const,
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    alignItems: 'center',
    background: '#1a1818',
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
  select: {
    background: '#2a2828',
    color: '#fff',
    border: '1px solid #444',
    borderRadius: 6,
    fontSize: 12,
    padding: '4px 6px',
    maxWidth: 200,
  } as const,
  missedCard: {
    display: 'flex',
    gap: 10,
    alignItems: 'center',
    background: '#1a1818',
    color: '#fff',
    borderRadius: 10,
    padding: '10px 14px',
    boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
    fontSize: 13,
  } as const,
};

function formatElapsed(startedAt: number, now: number) {
  const total = Math.max(0, Math.floor((now - startedAt) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function CallDuration({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);
  return <span data-testid="CampfireCallDuration">{formatElapsed(startedAt, now)}</span>;
}

function MicPicker({ onSelectMic }: { onSelectMic: (id: string) => void }) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    navigator.mediaDevices
      .enumerateDevices()
      .then((all) => setDevices(all.filter((d) => d.kind === 'audioinput')))
      .catch(() => {});
  }, []);
  if (devices.length < 2) {
    return null;
  }
  return (
    <select
      style={styles.select}
      onChange={(e) => onSelectMic(e.target.value)}
      data-testid="CampfireMicPicker"
    >
      {devices.map((d, i) => (
        <option key={d.deviceId} value={d.deviceId}>
          {d.label || `Microphone ${i + 1}`}
        </option>
      ))}
    </select>
  );
}

function CallOverlay({
  activeCall,
  incomingCall,
  orphanedCall,
  missedCalls,
  onAnswer,
  onReject,
  onHangup,
  onToggleMute,
  onRejoin,
  onDiscardOrphan,
  onDismissMissed,
  onSelectMic,
}: {
  activeCall: CampfireActiveCall | null;
  incomingCall: CampfireIncomingCall | null;
  orphanedCall: CampfireOrphanedCall | null;
  missedCalls: CampfireMissedCall[];
  onAnswer: () => void;
  onReject: () => void;
  onHangup: () => void;
  onToggleMute: () => void;
  onRejoin: () => void;
  onDiscardOrphan: () => void;
  onDismissMissed: (at: number) => void;
  onSelectMic: (deviceId: string) => void;
}) {
  const cards = [];

  if (orphanedCall && !activeCall) {
    cards.push(
      <div
        key="orphan"
        style={styles.card}
        data-testid="CampfireOrphanedCall"
      >
        <div style={styles.peer}>{orphanedCall.peer}</div>
        <div style={styles.status}>Call still in progress</div>
        <div style={styles.buttonRow}>
          <button
            style={{ ...styles.button, background: '#2a9d3f' }}
            onClick={onRejoin}
            data-testid="CampfireRejoinButton"
          >
            Rejoin
          </button>
          <button
            style={{ ...styles.button, background: '#c53030' }}
            onClick={onDiscardOrphan}
            data-testid="CampfireDiscardButton"
          >
            End call
          </button>
        </div>
      </div>
    );
  }

  if (incomingCall && !activeCall) {
    cards.push(
      <div
        key="incoming"
        style={styles.card}
        data-testid="CampfireIncomingCall"
      >
        <div style={styles.peer}>{incomingCall.peer}</div>
        <div style={styles.status}>Incoming audio call</div>
        <div style={styles.buttonRow}>
          <button
            style={{ ...styles.button, background: '#2a9d3f' }}
            onClick={onAnswer}
            data-testid="CampfireAnswerButton"
          >
            Answer
          </button>
          <button
            style={{ ...styles.button, background: '#c53030' }}
            onClick={onReject}
            data-testid="CampfireRejectButton"
          >
            Decline
          </button>
        </div>
      </div>
    );
  }

  if (activeCall) {
    const reconnecting =
      activeCall.status === 'connected' &&
      activeCall.mediaState !== null &&
      activeCall.mediaState !== 'connected';
    const statusLabel =
      activeCall.status === 'dialing'
        ? 'Calling…'
        : activeCall.status === 'ringing'
          ? 'Ringing…'
          : reconnecting
            ? 'Reconnecting…'
            : activeCall.micMuted
              ? 'Connected · muted'
              : 'Connected';

    cards.push(
      <div key="active" style={styles.card} data-testid="CampfireActiveCall">
        <div style={styles.peer}>{activeCall.peer}</div>
        <div style={styles.status} data-testid="CampfireCallStatus">
          {statusLabel}
          {activeCall.startedAt && !reconnecting ? (
            <>
              {' · '}
              <CallDuration startedAt={activeCall.startedAt} />
            </>
          ) : null}
        </div>
        {activeCall.status === 'connected' && (
          <MicPicker onSelectMic={onSelectMic} />
        )}
        <div style={styles.buttonRow}>
          <button
            style={{ ...styles.button, background: '#444' }}
            onClick={onToggleMute}
            data-testid="CampfireMuteButton"
          >
            {activeCall.micMuted ? 'Unmute' : 'Mute'}
          </button>
          <button
            style={{ ...styles.button, background: '#c53030' }}
            onClick={onHangup}
            data-testid="CampfireHangupButton"
          >
            Hang up
          </button>
        </div>
      </div>
    );
  }

  missedCalls.forEach((missed) => {
    cards.push(
      <div
        key={`missed-${missed.at}`}
        style={styles.missedCard}
        data-testid="CampfireMissedCall"
      >
        <span>
          Missed call from <strong>{missed.peer}</strong>
        </span>
        <button
          style={{ ...styles.button, background: '#444', padding: '4px 8px' }}
          onClick={() => onDismissMissed(missed.at)}
          data-testid="CampfireDismissMissedButton"
        >
          ✕
        </button>
      </div>
    );
  });

  if (!cards.length) {
    return null;
  }
  return <div style={styles.stack}>{cards}</div>;
}
