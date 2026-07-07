/**
 * Campfire call engine: WebRTC signalled over the %rtcswitchboard agent.
 *
 * This is a port of campfire's rtcswitchboard-js library
 * (https://github.com/mopfel-winrux/campfire, packages/rtcswitchboard-js)
 * onto @tloncorp/api's urbit client. The signalling protocol, including the
 * turn-taking state machine, is preserved verbatim: the switchboard grants
 * each side alternating turns to send SDP ('connected-our-turn' /
 * 'connected-their-turn' / 'connected-our-turn-asked'), and clients request a
 * turn with 'ask-signal' pokes rather than sending immediately.
 */
import {
  BadResponseError,
  poke,
  scry,
  subscribe,
  subscribeOnce,
  unsubscribe,
} from '@tloncorp/api';

const SWITCHBOARD = 'rtcswitchboard';
const MARK = 'rtcswitchboard-from-client';

/** The dap campfire's own UI uses for 1:1 calls; using the same value makes
 * calls interoperate with peers running the campfire app. */
export const CALL_DAP = 'campfire';

type SignalType = 'offer' | 'answer';

export type SwitchboardState =
  | 'placing'
  | 'dialing'
  | 'ringing'
  | 'incoming-ringing'
  | 'answering'
  | 'connected-our-turn'
  | 'connected-their-turn'
  | 'connected-want-turn'
  | 'connected-our-turn-asked';

type SignallingStateName =
  | 'stable'
  | 'waiting-to-send-offer'
  | 'waiting-to-send-answer'
  | 'sending'
  | 'sending-waiting-to-send-offer';

interface SwitchboardFact extends RTCIceCandidateInit {
  tag: 'connection-state' | 'sdp' | 'hungup' | 'icecandidate';
  type: SignalType;
  sdp?: string;
  connectionState: SwitchboardState;
}

interface IncomingFact {
  type: 'incoming' | 'hangup';
  peer: string;
  uuid: string;
}

export interface CampfireCallHandlers {
  onSwitchboardState: (state: SwitchboardState) => void;
  /** Actual WebRTC transport state — the truth about whether media flows. */
  onMediaState: (state: RTCPeerConnectionState) => void;
  onRemoteStream: (stream: MediaStream) => void;
  onLocalStream: (stream: MediaStream) => void;
  onEnded: () => void;
  onError: (err: unknown) => void;
}

/**
 * Client-side signalling state machine, ported verbatim from
 * rtcswitchboard-js. Prevents races between sending our SDP, receiving
 * remote SDP, and trickling ICE candidates.
 */
class SignallingState {
  private state: SignallingStateName = 'stable';
  private settingRemote = false;
  private settingRemoteDoneK: () => void = () => {};
  private whenDoneSendingK: () => void = () => {};

  startSettingRemote() {
    this.settingRemote = true;
  }

  doneSettingRemote() {
    this.settingRemote = false;
    this.settingRemoteDoneK();
    this.settingRemoteDoneK = () => {};
  }

  whenDoneSettingRemote(k: () => void) {
    if (this.settingRemote) {
      const oldK = this.settingRemoteDoneK;
      this.settingRemoteDoneK = () => {
        oldK();
        k();
      };
    } else {
      k();
    }
  }

  needToMakeOffer() {
    switch (this.state) {
      case 'stable':
        this.state = 'waiting-to-send-offer';
        break;
      case 'sending':
        this.state = 'sending-waiting-to-send-offer';
        break;
      default:
        break;
    }
  }

  gotOffer() {
    switch (this.state) {
      case 'stable':
      case 'waiting-to-send-offer':
        this.state = 'waiting-to-send-answer';
        break;
      case 'waiting-to-send-answer':
        break;
      default:
        throw new Error('Cannot receive SDP while sending');
    }
  }

  sending() {
    switch (this.state) {
      case 'waiting-to-send-offer':
      case 'waiting-to-send-answer':
        this.state = 'sending';
        break;
      case 'stable':
        throw new Error('Cannot send with nothing to send');
      default:
        throw new Error('Cannot send while sending');
    }
  }

  doneSending(sendOfferK: () => void) {
    switch (this.state) {
      case 'sending':
        this.state = 'stable';
        this.whenDoneSendingK();
        this.whenDoneSendingK = () => {};
        break;
      case 'sending-waiting-to-send-offer':
        this.state = 'waiting-to-send-offer';
        this.whenDoneSendingK();
        this.whenDoneSendingK = () => {};
        sendOfferK();
        break;
      default:
        throw new Error('Cannot be done sending if not sending');
    }
  }

  whenDoneSending(k: () => void) {
    if (this.state === 'stable') {
      k();
    } else {
      const oldK = this.whenDoneSendingK;
      this.whenDoneSendingK = () => {
        oldK();
        k();
      };
    }
  }

  waitingType(): SignalType {
    switch (this.state) {
      case 'waiting-to-send-offer':
        return 'offer';
      case 'waiting-to-send-answer':
        return 'answer';
      default:
        throw new Error('Asked for waiting type but nothing waiting to send');
    }
  }
}

export class CampfireCall {
  readonly peer: string;
  readonly isCaller: boolean;
  readonly isReconnect: boolean;
  uuid: string | null;

  private pc: RTCPeerConnection;
  private handlers: CampfireCallHandlers;
  private signalling = new SignallingState();
  private signallingReady: () => void = () => {};
  private signallingReadyPromise: Promise<void>;
  private subscriptionId: number | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream = new MediaStream();
  private closed = false;
  private iceRestartAttempts = 0;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private unloading = false;
  private markUnloading = () => {
    this.unloading = true;
  };

  constructor(
    peer: string,
    uuid: string | null,
    handlers: CampfireCallHandlers,
    configuration?: RTCConfiguration,
    options?: { reconnect?: boolean }
  ) {
    this.peer = peer;
    this.uuid = uuid;
    this.isReconnect = options?.reconnect ?? false;
    this.isCaller = uuid === null;
    this.handlers = handlers;
    this.pc = new RTCPeerConnection(configuration);
    // Pokes aborted by page navigation reject with fetch errors; without
    // this guard the resulting closeWithError would send a real reject poke
    // and erase the call the next page load could otherwise rejoin.
    window.addEventListener('beforeunload', this.markUnloading);
    window.addEventListener('pagehide', this.markUnloading);
    this.signallingReadyPromise = new Promise<void>((ready) => {
      this.signallingReady = () => {
        this.signallingReady = () => {};
        ready();
      };
    });

    this.pc.ontrack = (evt) => {
      this.remoteStream.addTrack(evt.track);
      this.handlers.onRemoteStream(this.remoteStream);
    };

    this.pc.onicecandidate = (evt) => {
      this.signalling.whenDoneSending(() => {
        if (evt.candidate !== null && this.pc.canTrickleIceCandidates) {
          this.signallingReadyPromise
            .then(() =>
              poke({
                app: SWITCHBOARD,
                mark: MARK,
                json: {
                  uuid: this.uuid,
                  tag: 'icecandidate',
                  ...evt.candidate?.toJSON(),
                },
              })
            )
            .catch((err) => this.closeWithError(err));
        }
      });
    };

    this.pc.onnegotiationneeded = () => {
      this.askSendSignal('offer').catch((err) => this.closeWithError(err));
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      this.handlers.onMediaState(state);
      if (state === 'connected') {
        this.iceRestartAttempts = 0;
        if (this.disconnectTimer) {
          clearTimeout(this.disconnectTimer);
          this.disconnectTimer = null;
        }
        return;
      }
      if (state === 'disconnected') {
        // Give it a moment to self-recover before forcing an ICE restart.
        this.disconnectTimer = setTimeout(() => {
          if (this.pc.connectionState === 'disconnected') {
            this.tryIceRestart();
          }
        }, 2000);
        return;
      }
      if (state === 'failed' && !this.tryIceRestart()) {
        this.hangup();
      }
    };
  }

  private tryIceRestart(): boolean {
    if (this.closed || this.iceRestartAttempts >= 3) {
      return false;
    }
    this.iceRestartAttempts += 1;
    try {
      // Triggers negotiationneeded, which renegotiates over the switchboard.
      this.pc.restartIce();
      return true;
    } catch (err) {
      console.warn('ICE restart failed', err);
      return false;
    }
  }

  get micMuted(): boolean {
    const track = this.localStream?.getAudioTracks()[0];
    return track ? !track.enabled : false;
  }

  async start() {
    if (this.isReconnect) {
      // Rejoining a call that survived a page reload: the switchboard still
      // has it in a connected state, so signalling turns are already
      // available. Adding our tracks below renegotiates media from scratch.
      this.handlers.onSwitchboardState('connected-their-turn');
      await this.subscribeToCall();
      this.signallingReady();
    } else if (this.isCaller) {
      this.handlers.onSwitchboardState('dialing');
      await this.dial();
    } else {
      this.handlers.onSwitchboardState('incoming-ringing');
      await this.subscribeToCall();
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });
    if (this.closed) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.localStream = stream;
    this.handlers.onLocalStream(stream);
    // Adding tracks fires negotiationneeded, which queues an offer to be
    // sent once the switchboard grants us a turn.
    stream.getTracks().forEach((track) => this.pc.addTrack(track, stream));
  }

  /** Switch the microphone without renegotiating, preserving mute state. */
  async setAudioDevice(deviceId: string) {
    const sender = this.pc.getSenders().find((s) => s.track?.kind === 'audio');
    if (!sender || this.closed) {
      return;
    }
    const wasMuted = this.micMuted;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId } },
      video: false,
    });
    const newTrack = stream.getAudioTracks()[0];
    if (!newTrack) {
      return;
    }
    newTrack.enabled = !wasMuted;
    await sender.replaceTrack(newTrack);
    this.localStream?.getAudioTracks().forEach((t) => {
      this.localStream?.removeTrack(t);
      t.stop();
    });
    this.localStream?.addTrack(newTrack);
  }

  /** Ask the switchboard for a call uuid; it responds with one fact on
   * /uuid and kicks the subscription. */
  private async dial() {
    const uuid = await subscribeOnce<string>(
      { app: SWITCHBOARD, path: '/uuid' },
      15000
    );
    await this.ring(String(uuid));
  }

  private async ring(uuid: string) {
    this.uuid = uuid;
    await poke({
      app: SWITCHBOARD,
      mark: MARK,
      json: {
        uuid,
        tag: 'place-call',
        // fed:ag on the other end parses the ship name without its sig
        peer: this.peer.replace(/^~/, ''),
        dap: CALL_DAP,
      },
    });
    await this.subscribeToCall();
  }

  private async subscribeToCall() {
    this.subscriptionId = await subscribe<SwitchboardFact>(
      { app: SWITCHBOARD, path: `/call/${this.uuid}` },
      (fact) => this.handleFact(fact),
      {
        // The switchboard deletes the call and kicks subscribers when either
        // side hangs up; resubscribing to the dead path would crash its
        // on-watch. Treat the kick as the call ending.
        resubOnQuit: false,
        onQuit: () => this.remoteHungup(),
      }
    );
  }

  private handleFact(fact: SwitchboardFact) {
    switch (fact.tag) {
      case 'connection-state':
        this.signalling.whenDoneSettingRemote(() =>
          this.dispatchSwitchboardState(fact.connectionState)
        );
        return;
      case 'hungup':
        this.remoteHungup();
        return;
      case 'sdp':
        this.signalling.startSettingRemote();
        this.handleSdp(fact)
          .then(() => this.signalling.doneSettingRemote())
          .catch((err) => this.closeWithError(err));
        return;
      case 'icecandidate':
        this.signalling.whenDoneSettingRemote(() => {
          this.pc
            .addIceCandidate(fact)
            .catch((err) => console.warn('bad ICE candidate', err));
        });
    }
  }

  private async handleSdp(sdp: SwitchboardFact) {
    await this.pc.setRemoteDescription(sdp);
    // An offer means the peer is (re)negotiating; queue an answer.
    if (sdp.type === 'offer') {
      await this.askSendSignal('answer');
    }
  }

  private dispatchSwitchboardState(state: SwitchboardState) {
    switch (state) {
      case 'connected-our-turn':
      case 'connected-their-turn':
        this.signallingReady();
        break;
      case 'connected-our-turn-asked':
        this.sendSignal().catch((err) => this.closeWithError(err));
        break;
      default:
        break;
    }
    this.handlers.onSwitchboardState(state);
  }

  private async askSendSignal(signalType: SignalType) {
    await this.signallingReadyPromise;
    if (signalType === 'offer') {
      this.signalling.needToMakeOffer();
    } else {
      this.signalling.gotOffer();
    }
    await this.askSignal();
  }

  private askSignal() {
    return poke({
      app: SWITCHBOARD,
      mark: MARK,
      json: { uuid: this.uuid, tag: 'ask-signal' },
    });
  }

  /** The switchboard granted our requested turn: create and send the queued
   * offer/answer. */
  private async sendSignal() {
    const signalType = this.signalling.waitingType();
    this.signalling.sending();
    const description =
      signalType === 'offer'
        ? await this.pc.createOffer()
        : await this.pc.createAnswer();
    await this.pc.setLocalDescription(description);
    if (!this.pc.canTrickleIceCandidates) {
      await this.iceCandidatesGathered();
    }
    await poke({
      app: SWITCHBOARD,
      mark: MARK,
      json: {
        uuid: this.uuid,
        tag: 'sdp',
        ...this.pc.localDescription?.toJSON(),
      },
    });
    this.signalling.doneSending(() => {
      this.askSignal().catch((err) => this.closeWithError(err));
    });
  }

  private iceCandidatesGathered(): Promise<void> {
    return new Promise((resolve) => {
      if (this.pc.iceGatheringState === 'complete') {
        resolve();
        return;
      }
      const check = () => {
        if (this.pc.iceGatheringState === 'complete') {
          this.pc.removeEventListener('icegatheringstatechange', check);
          resolve();
        }
      };
      this.pc.addEventListener('icegatheringstatechange', check);
    });
  }

  private remoteHungup() {
    if (!this.closed) {
      this.teardown();
      this.handlers.onEnded();
    }
  }

  private closeWithError(err: unknown) {
    if (this.unloading) {
      return;
    }
    console.error('campfire call error', err);
    this.hangup();
    this.handlers.onError(err);
  }

  /** End the call: tell the switchboard, then release local resources. */
  hangup() {
    if (this.closed) {
      return;
    }
    if (this.uuid) {
      poke({
        app: SWITCHBOARD,
        mark: MARK,
        json: { tag: 'reject', uuid: this.uuid },
      }).catch(() => {});
    }
    this.teardown();
    this.handlers.onEnded();
  }

  private teardown() {
    this.closed = true;
    window.removeEventListener('beforeunload', this.markUnloading);
    window.removeEventListener('pagehide', this.markUnloading);
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.remoteStream.getTracks().forEach((t) => t.stop());
    try {
      this.pc.close();
    } catch {
      // already closed
    }
    if (this.subscriptionId !== null) {
      unsubscribe(this.subscriptionId).catch(() => {});
      this.subscriptionId = null;
    }
  }

  toggleMute(): boolean {
    let muted = false;
    this.localStream?.getAudioTracks().forEach((t) => {
      t.enabled = !t.enabled;
      muted = !t.enabled;
    });
    return muted;
  }
}

export type LiveCallCheck =
  | { status: 'live'; state: string }
  | { status: 'gone' }
  | { status: 'unknown' };

/** Whether the switchboard still has a live call with this uuid — used to
 * detect a call orphaned by a page reload. 'unknown' means the scry itself
 * failed (e.g. during early boot) and the answer should be retried, not
 * treated as gone. */
export async function checkLiveCall(uuid: string): Promise<LiveCallCheck> {
  try {
    const state = await scry<string>({
      app: SWITCHBOARD,
      path: `/call/${uuid}/connection-state`,
    });
    return state == null
      ? { status: 'gone' }
      : { status: 'live', state: String(state) };
  } catch (err) {
    if (err instanceof BadResponseError && err.status === 404) {
      return { status: 'gone' };
    }
    return { status: 'unknown' };
  }
}

/** Decline an incoming call without constructing a connection. */
export function rejectIncomingCall(uuid: string) {
  return poke({
    app: SWITCHBOARD,
    mark: MARK,
    json: { tag: 'reject', uuid },
  });
}

/** Watch for incoming 1:1 campfire calls. Returns the subscription id. */
export function watchIncomingCalls(handlers: {
  onIncoming: (peer: string, uuid: string) => void;
  onHangup: (uuid: string) => void;
}): Promise<number> {
  return subscribe<IncomingFact>(
    { app: SWITCHBOARD, path: `/incoming/${CALL_DAP}` },
    (evt) => {
      if (evt.type === 'incoming') {
        handlers.onIncoming(evt.peer, evt.uuid);
      } else if (evt.type === 'hangup') {
        handlers.onHangup(evt.uuid);
      }
    }
  );
}

/**
 * Collect STUN/TURN servers from the %icepond agent. Servers trickle in as
 * facts; each one is passed to the callback. The subscription ends with a
 * kick when icepond has no more to give.
 */
export function watchIceServers(
  onServer: (server: RTCIceServer) => void
): Promise<number> {
  let uid = '';
  for (let i = 0; i < 32; i++) {
    uid += Math.floor(Math.random() * 16).toString(16);
  }
  return subscribe<RTCIceServer>(
    { app: 'icepond', path: `/ice-servers/${uid}` },
    onServer,
    // icepond kicks when it has no more servers to give; that's completion,
    // not a lost connection.
    { resubOnQuit: false, onQuit: () => {} }
  );
}
