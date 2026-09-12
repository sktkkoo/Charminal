import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentEndpoint,
  type CallResidentIdentity,
  type NativeAgentEvent,
  NativeCallAgent,
  publicCallIdentity,
} from "./native-agent";

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  channels: [] as Array<{ onmessage: (event: NativeAgentEvent) => void }>,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: native.invoke,
  Channel: class {
    onmessage = (_event: NativeAgentEvent) => {};
    constructor() {
      native.channels.push(this);
    }
  },
}));
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class TrackDouble {
  readonly kind = "audio";
  readyState: MediaStreamTrackState = "live";
  readonly clones: TrackDouble[] = [];
  readonly stop = vi.fn(() => {
    this.readyState = "ended";
  });

  constructor(readonly id: string) {}

  clone(): TrackDouble {
    const copy = new TrackDouble(`${this.id}:clone`);
    this.clones.push(copy);
    return copy;
  }
}

class StreamDouble {
  constructor(private readonly tracks: TrackDouble[]) {}

  getAudioTracks(): TrackDouble[] {
    return this.tracks;
  }
}

class PcDouble {
  static instances: PcDouble[] = [];
  connectionState: RTCPeerConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "complete";
  localDescription: RTCSessionDescriptionInit | null = null;
  ontrack: ((event: { track: TrackDouble }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  readonly sender = { replaceTrack: vi.fn(async (_track: TrackDouble | null) => {}) };
  readonly channel = {
    onmessage: null as ((event: { data: string }) => void) | null,
    readyState: "open" as RTCDataChannelState,
    close: vi.fn(),
  };
  readonly addTransceiver = vi.fn(() => ({ sender: this.sender }));
  readonly createDataChannel = vi.fn(() => this.channel);
  readonly createOffer = vi.fn(async () => ({ type: "offer" as const, sdp: "local-offer" }));
  readonly setLocalDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    this.localDescription = description;
  });
  readonly setRemoteDescription = vi.fn(async (_description: RTCSessionDescriptionInit) => {
    this.connectionState = "connected";
    this.onconnectionstatechange?.();
  });
  readonly close = vi.fn(() => {
    this.connectionState = "closed";
    this.onconnectionstatechange?.();
  });

  constructor() {
    PcDouble.instances.push(this);
  }
}

class EndpointDouble {
  readonly remoteListeners = new Set<(stream: MediaStream | null) => void>();
  readonly closeListeners = new Set<() => void>();
  readonly startAgentOutput = vi.fn(async (_stream: MediaStream) => {});
  readonly stopInput = vi.fn(async () => {});
  remote: MediaStream | null = null;

  onRemoteAudio(listener: (stream: MediaStream | null) => void): () => void {
    this.remoteListeners.add(listener);
    listener(this.remote);
    return () => {
      this.remoteListeners.delete(listener);
    };
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  receive(track: TrackDouble | null): void {
    this.remote = track ? (new StreamDouble([track]) as unknown as MediaStream) : null;
    for (const listener of this.remoteListeners) listener(this.remote);
  }

  close(): void {
    for (const listener of this.closeListeners) listener();
  }
}

function createAgent(label: string | CallResidentIdentity = "A", endpoint = new EndpointDouble()) {
  const callbacks = { changed: vi.fn(), transcript: vi.fn(), ended: vi.fn(), activity: vi.fn() };
  const agent = new NativeCallAgent(label, endpoint as unknown as AgentEndpoint, callbacks);
  return {
    agent,
    endpoint,
    callbacks,
    pc: PcDouble.instances[PcDouble.instances.length - 1],
    events: native.channels[native.channels.length - 1],
  };
}
async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}
beforeEach(() => {
  vi.useFakeTimers();
  PcDouble.instances = [];
  native.channels = [];
  native.invoke
    .mockReset()
    .mockImplementation(async (command: string) =>
      command === "peer_call_agent_start" ? { sdp: "v=0\r\nprovider-answer" } : undefined,
    );
  vi.stubGlobal("RTCPeerConnection", PcDouble);
  vi.stubGlobal("MediaStream", StreamDouble);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("NativeCallAgent", () => {
  it("selects distinct role defaults without depending on a local session slot", async () => {
    const host = createAgent({ name: "こはる", publicDescription: "", startsConversation: true });
    await host.agent.start();
    expect(native.invoke).toHaveBeenCalledWith(
      "peer_call_agent_start",
      expect.objectContaining({ voice: "sol" }),
    );
    host.agent.stop();
    native.invoke.mockClear();
    // Guest starts independently with no running local host session.
    const guest = createAgent({ name: "ひなた", publicDescription: "", startsConversation: false });
    await guest.agent.start();
    expect(native.invoke).toHaveBeenCalledWith(
      "peer_call_agent_start",
      expect.objectContaining({ voice: "sage" }),
    );
    guest.agent.stop();
    native.invoke.mockClear();
    const configured = createAgent({
      name: "こはる",
      publicDescription: "",
      startsConversation: true,
      voice: " juniper ",
    });
    await configured.agent.start();
    expect(native.invoke).toHaveBeenCalledWith(
      "peer_call_agent_start",
      expect.objectContaining({ voice: "juniper" }),
    );
    configured.agent.stop();
  });

  it("validates identity and configured voices before allocating audio resources", () => {
    expect(() => createAgent({ name: "", publicDescription: "" })).toThrow("名前");
    expect(() => createAgent({ name: "こはる", publicDescription: "", voice: "unknown" })).toThrow(
      "声",
    );
    expect(PcDouble.instances).toHaveLength(0);
    expect(native.channels).toHaveLength(0);
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("closes a partially configured peer when channel initialization fails", () => {
    vi.stubGlobal(
      "RTCPeerConnection",
      class extends PcDouble {
        readonly createDataChannel = vi.fn(() => {
          throw new Error("channel initialization failed");
        });
      },
    );
    expect(() => createAgent()).toThrow("channel initialization failed");
    expect(PcDouble.instances[0].close).toHaveBeenCalledOnce();
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("releases constructor resources if the endpoint rejects a subscription", () => {
    const endpoint = new EndpointDouble();
    vi.spyOn(endpoint, "onRemoteAudio").mockImplementation(() => {
      throw new Error("subscription failed");
    });
    expect(() => createAgent("こはる", endpoint)).toThrow("subscription failed");
    expect(PcDouble.instances[0].close).toHaveBeenCalledOnce();
    expect(PcDouble.instances[0].channel.close).toHaveBeenCalledOnce();
    expect(endpoint.closeListeners.size).toBe(0);
    expect(endpoint.stopInput).not.toHaveBeenCalled();
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("copies only bounded public resident fields into native startup", async () => {
    const resident = {
      name: "  こはる\n\u202e ",
      publicDescription: ` 穏やかで好奇心旺盛。\n${"猫".repeat(300)}`,
      peerName: "ひなた\u2028",
      startsConversation: true,
      systemPrompt: "private persona instructions",
      memories: ["private history"],
      cwd: "/private/work",
    };
    const { agent } = createAgent(resident);
    resident.name = "mutated";
    await agent.start();
    const args = native.invoke.mock.calls.find(
      ([method]) => method === "peer_call_agent_start",
    )?.[1];
    expect(args.label).toBe("こはる");
    expect(args.peerName).toBe("ひなた");
    expect(args.startsConversation).toBe(true);
    expect(Array.from(args.publicDescription)).toHaveLength(240);
    expect(args).not.toHaveProperty("systemPrompt");
    expect(JSON.stringify(args)).not.toContain("private");
    expect(Object.isFrozen(agent.identity)).toBe(true);
    expect(() => publicCallIdentity("\n")).toThrow("名前");
    agent.stop();
  });

  it("fails before external startup if exclusive managed turns are required", async () => {
    const { agent, callbacks } = createAgent();
    await expect(agent.start({ managedTurns: true })).rejects.toThrow("発話順");
    expect(native.invoke.mock.calls.some(([method]) => method === "peer_call_agent_start")).toBe(
      false,
    );
    expect(callbacks.ended).toHaveBeenCalledOnce();
    expect(agent.capabilities.playbackCompletion).toBe(false);
    expect(agent.capabilities.utteranceCancellation).toBe(false);
  });

  it("seeds natural conversation only through supported appendText", async () => {
    const { agent, pc } = createAgent();
    await agent.start();
    await agent.requestTurn("こはる、この話題をどう思う？");
    expect(native.invoke).toHaveBeenCalledWith("peer_call_agent_text", {
      id: agent.id,
      text: "こはる、この話題をどう思う？",
    });
    expect(pc.channel).not.toHaveProperty("send");
    agent.stop();
  });

  it("uses native IPC and routes only borrowed remote audio into its independent provider connection", async () => {
    const a = createAgent();
    const b = createAgent("B");
    await Promise.all([a.agent.start(), b.agent.start()]);
    const generated = new TrackDouble("provider-A");
    a.pc.ontrack?.({ track: generated });
    await flush();
    expect(a.endpoint.startAgentOutput.mock.calls[0][0].getAudioTracks()).toEqual([generated]);
    expect(b.endpoint.startAgentOutput).not.toHaveBeenCalled();
    const received = new TrackDouble("received-at-B");
    b.endpoint.receive(received);
    await flush();
    expect(b.pc.sender.replaceTrack).toHaveBeenLastCalledWith(received.clones[0]);
    expect(a.pc.sender.replaceTrack).not.toHaveBeenCalledWith(received.clones[0]);
    expect(native.invoke).toHaveBeenCalledWith(
      "peer_call_agent_start",
      expect.objectContaining({ id: a.agent.id, onEvent: a.events }),
    );
    expect(
      native.invoke.mock.calls.filter(([command]) => command === "peer_call_agent_text"),
    ).toHaveLength(0);
    await a.agent.greet();
    expect(native.invoke).toHaveBeenCalledWith(
      "peer_call_agent_text",
      expect.objectContaining({ id: a.agent.id }),
    );
    a.agent.stop();
    b.agent.stop();
    expect(received.stop).not.toHaveBeenCalled();
    expect(received.clones[0].stop).toHaveBeenCalledOnce();
  });
  it("cancels native startup by caller-owned ID and rejects late answers", async () => {
    const pending = deferred<{ sdp: string }>();
    native.invoke.mockImplementation(async (command: string) =>
      command === "peer_call_agent_start" ? pending.promise : undefined,
    );
    const { agent, pc, callbacks, endpoint } = createAgent();
    const started = agent.start().catch((error) => error);
    await flush();
    agent.stop();
    expect(native.invoke).toHaveBeenCalledWith("peer_call_agent_stop", { id: agent.id });
    pending.resolve({ sdp: "late-answer" });
    expect(await started).toBeInstanceOf(Error);
    expect(pc.setRemoteDescription).not.toHaveBeenCalled();
    const lateOutput = new TrackDouble("late-output");
    pc.ontrack?.({ track: lateOutput });
    expect(lateOutput.stop).toHaveBeenCalledOnce();
    expect(endpoint.startAgentOutput).not.toHaveBeenCalled();
    expect(callbacks.ended).toHaveBeenCalledOnce();
  });
  it("detaches input on permission revocation and keeps source tracks alive", async () => {
    const { agent, endpoint, pc } = createAgent();
    const first = new TrackDouble("old");
    const second = new TrackDouble("new");
    endpoint.receive(first);
    endpoint.receive(second);
    expect(first.clones[0].readyState).toBe("ended");
    await flush();
    expect(pc.sender.replaceTrack).not.toHaveBeenCalledWith(first.clones[0]);
    expect(pc.sender.replaceTrack).toHaveBeenLastCalledWith(second.clones[0]);
    endpoint.receive(null);
    expect(second.clones[0].readyState).toBe("ended");
    await flush();
    expect(pc.sender.replaceTrack).toHaveBeenLastCalledWith(null);
    agent.stop();
    expect(first.readyState).toBe("live");
    expect(second.readyState).toBe("live");
  });
  it("keeps the same received track across unrelated participant state updates", async () => {
    const { agent, endpoint, pc } = createAgent();
    const source = new TrackDouble("stable");
    endpoint.receive(source);
    await flush();
    endpoint.receive(source);
    await flush();
    expect(source.clones).toHaveLength(1);
    expect(source.clones[0].readyState).toBe("live");
    expect(pc.sender.replaceTrack).toHaveBeenCalledTimes(1);
    agent.stop();
  });

  it("uses the room-owned human/remote input mix and gates it without stopping borrowed sources", async () => {
    const endpoint = new EndpointDouble();
    const mixedSource = new TrackDouble("human-and-remote-mix");
    const mix = new StreamDouble([mixedSource]) as unknown as MediaStream;
    let receiveMix: ((stream: MediaStream | null) => void) | null = null;
    const unsubscribe = vi.fn();
    Object.assign(endpoint, {
      onInputAudio: vi.fn((listener: (stream: MediaStream | null) => void) => {
        receiveMix = listener;
        listener(mix);
        return unsubscribe;
      }),
    });
    const { agent, pc } = createAgent("こはる", endpoint);
    await agent.start();
    await flush();
    expect(pc.sender.replaceTrack).toHaveBeenLastCalledWith(mixedSource.clones[0]);
    expect(endpoint.remoteListeners.size).toBe(0);
    agent.setInputEnabled(false);
    expect(mixedSource.clones[0].readyState).toBe("ended");
    await flush();
    expect(pc.sender.replaceTrack).toHaveBeenLastCalledWith(null);
    const later = new TrackDouble("later-mix");
    (receiveMix as unknown as (stream: MediaStream) => void)(
      new StreamDouble([later]) as unknown as MediaStream,
    );
    await flush();
    expect(later.clones).toHaveLength(0);
    agent.setInputEnabled(true);
    await flush();
    expect(pc.sender.replaceTrack).toHaveBeenLastCalledWith(later.clones[0]);
    agent.stop();
    expect(mixedSource.readyState).toBe("live");
    expect(later.readyState).toBe("live");
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("does not revive an in-flight track replacement after stop", async () => {
    const { agent, endpoint, pc } = createAgent();
    await flush();
    const pending = deferred<void>();
    pc.sender.replaceTrack.mockImplementationOnce(async () => pending.promise);
    const source = new TrackDouble("source");
    endpoint.receive(source);
    await flush();
    agent.stop();
    pending.resolve();
    await flush();
    expect(source.clones[0].readyState).toBe("ended");
    expect(source.readyState).toBe("live");
    expect(pc.close).toHaveBeenCalledOnce();
  });
  it("preserves startup errors and stops once", async () => {
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "peer_call_agent_start") throw new Error("Sign in required");
    });
    const { agent, callbacks } = createAgent();
    await expect(agent.start()).rejects.toThrow("Sign in required");
    expect(callbacks.ended).toHaveBeenCalledExactlyOnceWith("Sign in required");
    agent.stop();
    expect(callbacks.ended).toHaveBeenCalledOnce();
  });
  it("shows bounded native transcript events without forwarding their text or accepting late events", async () => {
    const { agent, events, callbacks } = createAgent();
    await agent.start();
    events.onmessage({ type: "transcript", role: "assistant", text: "x".repeat(6000) });
    expect(callbacks.transcript.mock.calls[0][0].text).toHaveLength(4000);
    expect(callbacks.transcript.mock.calls[0][0].agentId).toBe(agent.id);
    expect(native.invoke.mock.calls.some(([command]) => command === "peer_call_agent_text")).toBe(
      false,
    );
    agent.stop();
    events.onmessage({ type: "transcript", role: "user", text: "late" });
    expect(callbacks.transcript).toHaveBeenCalledOnce();
  });
  it("never treats transcript completion as audible playback completion", async () => {
    const { agent, events, callbacks } = createAgent();
    await agent.start();
    events.onmessage({ type: "activity", activity: "responding" });
    events.onmessage({ type: "transcript", role: "assistant", text: "まだ音声は再生中です。" });
    expect(agent.activity).toBe("responding");
    expect(callbacks.activity).toHaveBeenLastCalledWith("responding");
    agent.stop();
    events.onmessage({ type: "activity", activity: "listening" });
    expect(callbacks.activity).toHaveBeenLastCalledWith("closed");
  });

  it("immediately stops its provider output when endpoint playback is still starting", async () => {
    const { agent, pc, endpoint } = createAgent();
    await agent.start();
    const pending = deferred<void>();
    endpoint.startAgentOutput.mockImplementationOnce(() => pending.promise);
    const output = new TrackDouble("own-provider");
    pc.ontrack?.({ track: output });
    agent.stop();
    expect(output.stop).toHaveBeenCalledOnce();
    pending.resolve();
    await flush();
    // Late completion may overlap a replacement agent using this endpoint. Its cleanup
    // must not stop the new owner's output; the old owned source is already ended.
    expect(endpoint.stopInput).toHaveBeenCalledOnce();
  });

  it("stops owned audio and native work even when endpoint output methods throw synchronously", async () => {
    const { agent, pc, endpoint, callbacks } = createAgent();
    await agent.start();
    endpoint.startAgentOutput.mockImplementationOnce(() => {
      throw new Error("output failed");
    });
    endpoint.stopInput.mockImplementationOnce(() => {
      throw new Error("cleanup failed");
    });
    const output = new TrackDouble("own-provider");
    expect(() => pc.ontrack?.({ track: output })).not.toThrow();
    expect(output.stop).toHaveBeenCalledOnce();
    expect(pc.close).toHaveBeenCalledOnce();
    expect(native.invoke).toHaveBeenCalledWith("peer_call_agent_stop", { id: agent.id });
    expect(callbacks.ended).toHaveBeenCalledExactlyOnceWith("output failed");
  });
  it("fails closed on provider tool delegation requests", async () => {
    const { agent, pc, callbacks } = createAgent();
    await agent.start();
    pc.channel.onmessage?.({
      data: JSON.stringify({ type: "response.output_item.added", item: { type: "function_call" } }),
    });
    expect(callbacks.ended).toHaveBeenCalledOnce();
    expect(pc.close).toHaveBeenCalledOnce();
  });
  it("allows short network recovery and stops after a sustained disconnection", async () => {
    const { agent, pc, callbacks } = createAgent();
    await agent.start();
    pc.connectionState = "disconnected";
    pc.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(5000);
    expect(callbacks.ended).not.toHaveBeenCalled();
    pc.connectionState = "connected";
    pc.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(6000);
    expect(callbacks.ended).not.toHaveBeenCalled();
    pc.connectionState = "disconnected";
    pc.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(10000);
    expect(callbacks.ended).toHaveBeenCalledOnce();
  });
  it("stops on host expiry and endpoint closure", async () => {
    const first = createAgent();
    await first.agent.start();
    first.events.onmessage({ type: "closed" });
    expect(first.callbacks.ended).toHaveBeenCalledOnce();
    const second = createAgent();
    await second.agent.start();
    second.endpoint.close();
    expect(second.callbacks.ended).toHaveBeenCalledOnce();
    expect(second.endpoint.stopInput).toHaveBeenCalledOnce();
  });
});
