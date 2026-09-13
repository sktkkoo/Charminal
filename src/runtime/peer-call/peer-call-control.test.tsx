// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Options = {
  targetIdentityId?: string;
  endpoint: string;
  name: string;
  publicDescription: string;
  avatarUrl: string | null;
  getVoice?: () => Promise<string | undefined>;
  onChange: () => void;
  onActiveChange: (active: boolean) => void;
};
type Incoming = {
  roomId: string;
  identityId: string;
  name: string;
  expiresAt: number;
  invitation: string;
};
type PresenceOptions = { endpoint: string; name: string; onChange(): void; onIncoming(): void };
type TestPresence = {
  state: string;
  error: string;
  contacts: { identityId: string; name: string; lastAcceptedAt: number }[];
  incoming: Incoming | null;
  options: PresenceOptions;
  close: ReturnType<typeof vi.fn>;
  setPresence: ReturnType<typeof vi.fn>;
  decline: ReturnType<typeof vi.fn>;
  removeContact: ReturnType<typeof vi.fn>;
  ring(incoming: Incoming): void;
};
type TestRoom = {
  options: Options;
  signaling: {
    state: string;
    remoteName: string;
    pendingGuest: { requestId: string; name: string } | null;
    invitation: string;
    role: string;
    error: string;
  };
  closed: boolean;
  connected: boolean;
  ready: boolean;
  paused: boolean;
  error: string;
  remoteAvatarUrl: string | null;
  topic: string;
  transcripts: { id: string; speaker: string; text: string }[];
  peer: { audio: { microphoneActive: boolean } } | null;
  create: ReturnType<typeof vi.fn>;
  join: ReturnType<typeof vi.fn>;
  accept: ReturnType<typeof vi.fn>;
  reject: ReturnType<typeof vi.fn>;
  submitTopic: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  setMicrophone: ReturnType<typeof vi.fn>;
  leave: ReturnType<typeof vi.fn<() => void>>;
  connect: () => void;
  incoming: () => void;
};
const test = vi.hoisted(() => ({
  rooms: [] as TestRoom[],
  presences: [] as TestPresence[],
  endpoint: "ws://localhost:1531/rooms",
  persist: vi.fn(),
  creation: null as Promise<void> | null,
  constructionError: "",
  native: false,
  nativeFailure: false,
  nativeInvoke: vi.fn(),
  nativeHandlers: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("./call-presence", () => ({
  CallPresence: class {
    state = "online";
    error = "";
    contacts = [{ identityId: "A".repeat(43), name: "Mai", lastAcceptedAt: 1 }];
    incoming: Incoming | null = null;
    constructor(readonly options: PresenceOptions) {
      test.presences.push(this);
    }
    start = vi.fn(async () => this.options.onChange());
    close = vi.fn();
    setPresence = vi.fn();
    decline = vi.fn((roomId: string) => {
      if (this.incoming?.roomId === roomId) this.incoming = null;
      this.options.onChange();
    });
    removeContact = vi.fn((identityId: string) => {
      this.contacts = this.contacts.filter((contact) => contact.identityId !== identityId);
      this.options.onChange();
    });
    takeIncoming(roomId: string) {
      if (this.incoming?.roomId !== roomId || this.incoming.expiresAt < Date.now()) return null;
      const call = this.incoming;
      this.incoming = null;
      this.options.onChange();
      return call.invitation;
    }
    ring(incoming: Incoming) {
      this.incoming = incoming;
      this.options.onChange();
      this.options.onIncoming();
    }
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => test.native,
  invoke: async (command: string, args: unknown) => {
    test.nativeInvoke(command, args);
    if (test.nativeFailure && command === "call_controls_publish")
      throw Error("Command call_controls_publish not found");
  },
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "main",
    listen: async (event: string, callback: (event: { payload: unknown }) => void) => {
      test.nativeHandlers.set(event, callback);
      return () => {
        if (test.nativeHandlers.get(event) === callback) test.nativeHandlers.delete(event);
      };
    },
  }),
}));
vi.mock("../three-runtime/three-runtime", () => ({
  getThreeRuntime: () => ({ getVrm: () => null }),
}));
vi.mock("./call-avatar", () => ({
  NativeCallStage: ({
    participants,
    layout,
  }: {
    participants: { avatarUrl: string; label: string }[];
    layout: string;
  }) => (
    <div data-testid="call-stage" data-layout={layout}>
      {participants.map((person) => (
        <div key={person.avatarUrl} data-testid="rendered-avatar" data-source={person.avatarUrl}>
          {person.label}
        </div>
      ))}
    </div>
  ),
}));
vi.mock("./room-call", () => ({
  configuredRoomEndpoint: () => test.endpoint,
  persistRoomEndpoint: (value: string) => {
    test.persist(value);
    if (!value.startsWith("wss://") && !value.startsWith("ws://localhost:"))
      throw new Error("Invalid endpoint");
    test.endpoint = value;
  },
  RoomCall: class {
    signaling = {
      state: "idle",
      remoteName: "",
      pendingGuest: null as { requestId: string; name: string } | null,
      invitation: "yri1_0123456789012345678901",
      role: "host",
      error: "",
    };
    closed = false;
    connected = false;
    ready = false;
    paused = false;
    error = "";
    agentActivity = "listening";
    remoteActivity = "responding";
    remoteAvatarUrl: string | null = null;
    topic = "";
    transcripts: { id: string; speaker: string; text: string }[] = [];
    peer: {
      audio: {
        microphoneActive: boolean;
        sampleLocalMouth: () => number;
        sampleRemoteMouth: () => number;
      };
      motion: { sample: () => null };
    } | null = null;
    constructor(readonly options: Options) {
      if (test.constructionError) throw new Error(test.constructionError);
      test.rooms.push(this);
    }
    create = vi.fn(async () => {
      if (test.creation) await test.creation;
      if (this.closed) return;
      this.signaling.state = "hosting";
      this.options.onChange();
    });
    join = vi.fn(async () => {
      this.signaling.role = "guest";
      this.signaling.state = "requesting";
      this.signaling.remoteName = "GPT";
      this.options.onChange();
    });
    incoming = () => {
      this.signaling.state = "pending";
      this.signaling.pendingGuest = { requestId: "request-1", name: "GPT" };
      this.options.onChange();
    };
    connect = () => {
      this.signaling.state = "active";
      this.signaling.remoteName = "GPT";
      this.signaling.pendingGuest = null;
      this.connected = true;
      this.ready = true;
      this.peer = {
        audio: { microphoneActive: false, sampleLocalMouth: () => 0, sampleRemoteMouth: () => 0 },
        motion: { sample: () => null },
      };
      this.options.onActiveChange(true);
      this.options.onChange();
    };
    accept = vi.fn(async () => this.connect());
    reject = vi.fn(async () => {
      this.signaling.state = "hosting";
      this.signaling.pendingGuest = null;
      this.options.onChange();
    });
    submitTopic = vi.fn(async (text: string) => {
      this.topic = text;
      this.options.onChange();
    });
    pause = vi.fn(() => {
      this.paused = true;
      this.ready = false;
      this.options.onChange();
    });
    resume = vi.fn(async () => {
      this.error = "";
      this.paused = false;
      this.ready = true;
      this.options.onChange();
    });
    setMicrophone = vi.fn(async (value: boolean) => {
      if (this.peer) this.peer.audio.microphoneActive = value;
      this.options.onChange();
    });
    leave = vi.fn(() => {
      this.closed = true;
      this.connected = false;
      this.options.onActiveChange(false);
      this.options.onChange();
    });
  },
}));

import { requestControlSurface } from "../control-surface";
import { PeerCallControl } from "./peer-call-control";

beforeEach(() => {
  test.presences = [];
  test.endpoint = "ws://localhost:1531/rooms";
  test.creation = null;
  test.constructionError = "";
  test.native = false;
  test.nativeFailure = false;
  test.nativeHandlers.clear();
});
afterEach(() => {
  cleanup();
  test.rooms = [];
  vi.clearAllMocks();
});
function open() {
  fireEvent.click(screen.getByRole("button", { name: "通話" }));
}
async function createRoom() {
  open();
  fireEvent.click(screen.getByRole("button", { name: "新しい相手を招待" }));
  await screen.findByText("招待の準備ができました");
  return test.rooms[0];
}
async function connectedRoom() {
  const room = await createRoom();
  act(() => room.connect());
  return room;
}

describe("native room call experience", () => {
  it("opens the isolated session before constructing a room and cancels through its owner", async () => {
    const start = vi.fn((_owner: string, _end: () => void) => {
      expect(test.rooms).toHaveLength(0);
    });
    const changed = vi.fn();
    render(<PeerCallControl onSessionStart={start} onRoomChange={changed} />);
    open();
    expect(start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "新しい相手を招待" }));
    await screen.findByText("招待の準備ができました");
    const first = test.rooms[0];
    const endFirst = start.mock.calls[0][1];
    act(() => endFirst());
    expect(first.leave).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenLastCalledWith(null);
    start.mockImplementation(() => {});
    fireEvent.click(screen.getByRole("button", { name: "新しい相手を招待" }));
    await screen.findByText("招待の準備ができました");
    act(() => endFirst());
    expect(test.rooms[1].leave).not.toHaveBeenCalled();
    expect(changed).toHaveBeenLastCalledWith(test.rooms[1]);
  });

  it.each([
    "session",
    "constructor",
    "connection",
  ])("restores work after a %s setup failure", async (phase) => {
    const start = vi.fn(() => {
      if (phase === "session") throw new Error("Session setup failed");
    });
    const changed = vi.fn();
    render(<PeerCallControl onSessionStart={start} onRoomChange={changed} />);
    if (phase === "constructor") test.constructionError = "Room setup failed";
    let fail: ((value: Error) => void) | undefined;
    if (phase === "connection") {
      test.creation = new Promise<void>((_resolve, reject) => {
        fail = reject;
      });
    }
    open();
    fireEvent.click(screen.getByRole("button", { name: "新しい相手を招待" }));
    if (fail) await act(async () => fail?.(new Error("Connection failed")));
    await screen.findByRole("alert");
    expect(changed).toHaveBeenLastCalledWith(null);
    expect(screen.getByRole("button", { name: "新しい相手を招待" })).toHaveProperty(
      "disabled",
      false,
    );
    expect(test.rooms.every((room) => room.closed)).toBe(true);
  });

  it("publishes the static presence failure to the native entry window", async () => {
    test.native = true;
    test.endpoint = "wss://call.example.test/v2/rooms";
    render(<PeerCallControl viewMode="companion" />);
    open();
    const message = "通話の識別情報を準備できませんでした。アプリを再起動してお試しください。";
    act(() => {
      test.presences[0].state = "error";
      test.presences[0].error = message;
      test.presences[0].options.onChange();
    });
    await waitFor(() =>
      expect(test.nativeInvoke).toHaveBeenCalledWith("call_controls_publish", {
        snapshot: expect.objectContaining({ presenceState: "error", presenceError: message }),
      }),
    );
  });

  it("shows a direct-call failure immediately underneath the called person", async () => {
    test.endpoint = "wss://call.example.test/v2/rooms";
    render(<PeerCallControl />);
    open();
    fireEvent.click(screen.getByRole("button", { name: "Maiに通話" }));
    await screen.findByText("Maiを呼び出しています…");
    act(() => {
      test.rooms[0].error = "不在のため、つながりませんでした。";
      test.rooms[0].leave();
    });
    const error = screen.getByRole("alert");
    expect(error.className).toBe("peer-call-contact-error");
    expect(error.parentElement?.textContent).toContain("Mai");
    expect(error.textContent).toBe("不在のため、つながりませんでした。");
  });

  it("calls a remembered identity without displaying an invitation and keeps presence across modes", async () => {
    test.endpoint = "wss://call.example.test/v2/rooms";
    const view = render(<PeerCallControl residentName="Yori" viewMode="theater" />);
    open();
    const presence = test.presences[0];
    expect(test.rooms).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Maiに通話" }));
    await screen.findByText("Maiを呼び出しています…");
    expect(test.rooms[0].options.targetIdentityId).toBe("A".repeat(43));
    expect(test.rooms[0].create).toHaveBeenCalledOnce();
    expect(test.rooms[0].peer).toBeNull();
    expect(screen.queryByLabelText("部屋の招待コード")).toBeNull();
    expect(presence.setPresence).toHaveBeenLastCalledWith("Yori", true);
    view.rerender(<PeerCallControl residentName="Yori" viewMode="companion" />);
    expect(test.presences).toHaveLength(1);
    expect(presence.close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(test.rooms[0].leave).toHaveBeenCalledOnce();
    expect(presence.setPresence).toHaveBeenLastCalledWith("Yori", false);
  });

  it("receives a direct call without creating media and joins only after Answer", async () => {
    test.endpoint = "wss://call.example.test/v2/rooms";
    const start = vi.fn(() => expect(test.rooms).toHaveLength(0));
    render(<PeerCallControl residentName="Yori" onSessionStart={start} />);
    const incoming = {
      roomId: "12345678-1234-4234-8234-123456789012",
      identityId: "A".repeat(43),
      name: "Mai",
      expiresAt: Date.now() + 45_000,
      invitation: "yri2_12345678-1234-4234-8234-123456789012_0123456789012345678901",
    };
    act(() => test.presences[0].ring(incoming));
    expect(screen.getByText("Maiから着信です")).toBeTruthy();
    expect(test.rooms).toHaveLength(0);
    expect(start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "通話に出る" }));
    await waitFor(() => expect(test.rooms).toHaveLength(1));
    expect(test.rooms[0].join).toHaveBeenCalledWith(incoming.invitation);
    expect(start).toHaveBeenCalledOnce();
    expect(test.presences[0].decline).not.toHaveBeenCalled();
  });

  it("declines a direct call without creating a room and removes a contact through presence", async () => {
    test.endpoint = "wss://call.example.test/v2/rooms";
    render(<PeerCallControl residentName="Yori" />);
    const presence = test.presences[0];
    act(() =>
      presence.ring({
        roomId: "12345678-1234-4234-8234-123456789012",
        identityId: "A".repeat(43),
        name: "Mai",
        expiresAt: Date.now() + 45_000,
        invitation: "private-invitation",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "拒否" }));
    expect(presence.decline).toHaveBeenCalledOnce();
    expect(test.rooms).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Maiを連絡先から削除" }));
    expect(presence.removeContact).toHaveBeenCalledWith("A".repeat(43));
    expect(screen.queryByRole("button", { name: "Maiに通話" })).toBeNull();
  });

  it("opens a meaningful create/join entry without starting a connection or exposing the rejected test UI", () => {
    render(<PeerCallControl avatarUrl="/models/Yori.vrm" residentName="より" />);
    open();
    expect(screen.getByRole("dialog", { name: "通話" })).toBeTruthy();
    expect(test.rooms).toHaveLength(0);
    expect(screen.getByRole("button", { name: "新しい相手を招待" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "参加する" })).toBeTruthy();
    expect(screen.getByText(/参加すると、名前・アバター・通話の音声/).textContent).toContain(
      "OpenAI",
    );
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByText(/このPCで2体|応答コード|STUN|接続品質|AIを参加させる/)).toBeNull();
  });

  it("creates a waiting room with captured public identity and voice, and waits for admission with the microphone off", async () => {
    const getVoice = vi.fn(async () => "sage");
    const active = vi.fn();
    render(
      <PeerCallControl
        avatarUrl="/models/Yori.vrm"
        residentName="より"
        publicDescription="A curious resident"
        getVoice={getVoice}
        onActiveChange={active}
      />,
    );
    const room = await createRoom();
    expect(room.options).toMatchObject({
      name: "より",
      publicDescription: "A curious resident",
      avatarUrl: "/models/Yori.vrm",
      getVoice,
    });
    expect(room.create).toHaveBeenCalledOnce();
    expect(room.peer).toBeNull();
    expect(active).not.toHaveBeenCalled();
    expect(screen.getByLabelText("部屋の招待コード")).toHaveProperty(
      "value",
      room.signaling.invitation,
    );
    act(() => room.incoming());
    expect(screen.getByText("GPTから着信です")).toBeTruthy();
    expect(room.accept).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "通話に出る" }));
    await screen.findByRole("complementary", { name: "通話中" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(room.accept).toHaveBeenCalledOnce();
    expect(room.peer?.audio.microphoneActive).toBe(false);
    expect(room.setMicrophone).not.toHaveBeenCalled();
    expect(active).toHaveBeenCalledWith(true);
  });

  it("uses only the short invitation to call another room and lets the guest cancel while waiting", async () => {
    render(<PeerCallControl residentName="より" />);
    open();
    fireEvent.change(screen.getByRole("textbox", { name: "招待コード" }), {
      target: { value: "yri1_0123456789012345678901" },
    });
    fireEvent.click(screen.getByRole("button", { name: "参加する" }));
    await screen.findByText("GPTを呼び出しています…");
    const room = test.rooms[0];
    expect(room.join).toHaveBeenCalledWith("yri1_0123456789012345678901");
    expect(room.peer).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(room.leave).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "新しい相手を招待" })).toBeTruthy();
  });

  it("uses the chosen call name while retaining the resident's own voice and public description", async () => {
    const getVoice = vi.fn(async () => "sage");
    render(
      <PeerCallControl
        residentName="Yori"
        publicDescription="A curious resident"
        getVoice={getVoice}
      />,
    );
    open();
    fireEvent.change(screen.getByRole("textbox", { name: "通話での名前" }), {
      target: { value: "  GPT  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "新しい相手を招待" }));
    await screen.findByText("招待の準備ができました");
    expect(test.rooms[0].options).toMatchObject({
      name: "GPT",
      publicDescription: "A curious resident",
      getVoice,
    });
    expect(getVoice).not.toHaveBeenCalled();
  });

  it("surfaces an incoming call while hidden and can decline without closing the host room", async () => {
    render(<PeerCallControl residentName="より" />);
    const room = await createRoom();
    fireEvent.click(screen.getByRole("button", { name: "通話画面を閉じる" }));
    act(() => room.incoming());
    expect(screen.queryByRole("dialog")).toBeNull();
    const incoming = screen.getByRole("complementary", { name: "着信" });
    expect(within(incoming).getByText("GPT")).toBeTruthy();
    fireEvent.click(within(incoming).getByRole("button", { name: "拒否" }));
    await waitFor(() => expect(room.reject).toHaveBeenCalledOnce());
    expect(room.leave).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "通話に戻る" })).toBeTruthy();
    act(() => room.incoming());
    fireEvent.click(screen.getByRole("button", { name: "通話に出る" }));
    await screen.findByRole("complementary", { name: "通話中" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(room.accept).toHaveBeenCalledOnce();
  });

  it("closes the management surface on connection and keeps the room through main-view changes", async () => {
    const onRoomChange = vi.fn();
    const view = render(
      <PeerCallControl
        avatarUrl="/models/Yori.vrm"
        residentName="より"
        viewMode="portrait"
        onRoomChange={onRoomChange}
      />,
    );
    const room = await connectedRoom();
    const strip = screen.getByRole("complementary", { name: "通話中" });
    expect(within(strip).getByText("より")).toBeTruthy();
    expect(within(strip).getByText("GPT")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByTestId("call-stage")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "マイクをオン" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^(同じ部屋|コール|ポートレート)$/ })).toBeNull();
    for (const viewMode of ["theater", "companion", "portrait"]) {
      view.rerender(
        <PeerCallControl
          avatarUrl="/models/Different.vrm"
          residentName="Changed"
          viewMode={viewMode}
          onRoomChange={onRoomChange}
        />,
      );
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByTestId("call-stage")).toBeNull();
      expect(within(strip).getByText("より")).toBeTruthy();
      expect(within(strip).getByText("GPT")).toBeTruthy();
    }
    expect(test.rooms).toHaveLength(1);
    expect(room.leave).not.toHaveBeenCalled();
    expect(room.options.avatarUrl).toBe("/models/Yori.vrm");
    expect(onRoomChange).toHaveBeenLastCalledWith(room);
  });

  it("publishes the admitted room and later avatar/state changes to the main view, and clears it on leave", async () => {
    const onRoomChange = vi.fn();
    render(<PeerCallControl residentName="より" onRoomChange={onRoomChange} />);
    const room = await createRoom();
    expect(onRoomChange).toHaveBeenLastCalledWith(room);
    act(() => room.connect());
    expect(onRoomChange).toHaveBeenLastCalledWith(room);
    onRoomChange.mockClear();
    act(() => {
      room.remoteAvatarUrl = "blob:http://localhost/remote-vrm";
      room.options.onChange();
    });
    expect(onRoomChange).toHaveBeenCalledWith(room);
    expect(onRoomChange.mock.lastCall?.[0].remoteAvatarUrl).toBe(
      "blob:http://localhost/remote-vrm",
    );
    fireEvent.click(screen.getAllByRole("button", { name: "通話を終了" })[0]);
    expect(room.leave).toHaveBeenCalledOnce();
    expect(onRoomChange).toHaveBeenLastCalledWith(null);
    expect(screen.queryByRole("complementary", { name: "通話中" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the existing conversation and resident surfaces through callbacks, without a duplicate topic or microphone UI", async () => {
    const topic = vi.fn();
    const showResident = vi.fn();
    const view = render(
      <PeerCallControl
        viewMode="portrait"
        onTopicRequested={topic}
        onShowResident={showResident}
      />,
    );
    const room = await connectedRoom();
    fireEvent.click(screen.getByRole("button", { name: "話題や進め方を渡す" }));
    expect(topic).toHaveBeenCalledOnce();
    expect(room.submitTopic).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(room.setMicrophone).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "相手のウィンドウを表示" }));
    expect(showResident).toHaveBeenCalledOnce();
    view.rerender(
      <PeerCallControl viewMode="theater" onTopicRequested={topic} onShowResident={showResident} />,
    );
    expect(screen.queryByRole("button", { name: "相手のウィンドウを表示" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(room.leave).not.toHaveBeenCalled();
  });

  it("stops AI conversation explicitly while retaining the call, and can resume it", async () => {
    render(<PeerCallControl residentName="より" />);
    const room = await connectedRoom();
    fireEvent.click(screen.getByRole("button", { name: "AIの会話を止める" }));
    expect(room.pause).toHaveBeenCalledOnce();
    expect(screen.getByText("AIの会話は停止中")).toBeTruthy();
    expect(screen.queryByText("AIに接続できませんでした")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(room.leave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "AIの会話を再開" }));
    await waitFor(() => expect(room.resume).toHaveBeenCalledOnce());
    await screen.findByRole("button", { name: "AIの会話を止める" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(room.setMicrophone).not.toHaveBeenCalled();
  });

  it("identifies failed AI startup as a connection error and offers explicit retry", async () => {
    render(<PeerCallControl residentName="より" />);
    const room = await connectedRoom();
    act(() => {
      room.ready = false;
      room.paused = true;
      room.error = "initialize timeout";
      room.options.onChange();
    });
    expect(screen.getByText("AIに接続できませんでした")).toBeTruthy();
    expect(screen.queryByText(/ひと休み|お休み/)).toBeNull();
    expect(screen.queryByText("AIの会話は停止中")).toBeNull();
    fireEvent.click(screen.getByText("接続エラーの詳細"));
    expect(screen.getByRole("alert").textContent).toBe("initialize timeout");
    expect(room.resume).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "AIの接続をやり直す" }));
    await screen.findByRole("button", { name: "AIの会話を止める" });
    expect(room.resume).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(room.leave).not.toHaveBeenCalled();
  });

  it("hangs up directly from the existing phone button and does not reopen a connected modal", async () => {
    const onRoomChange = vi.fn();
    const active = vi.fn();
    render(<PeerCallControl onRoomChange={onRoomChange} onActiveChange={active} />);
    const room = await connectedRoom();
    const phone = screen.getAllByRole("button", { name: "通話を終了" })[0];
    expect(phone.getAttribute("aria-haspopup")).toBeNull();
    fireEvent.click(phone);
    expect(room.leave).toHaveBeenCalledOnce();
    expect(active).toHaveBeenLastCalledWith(false);
    expect(onRoomChange).toHaveBeenLastCalledWith(null);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("complementary", { name: "通話中" })).toBeNull();
    expect(screen.getByRole("button", { name: "通話" })).toBeTruthy();
  });

  it("leaves immediately during an AI retry and ignores the old retry failure", async () => {
    render(<PeerCallControl />);
    const room = await connectedRoom();
    act(() => {
      room.ready = false;
      room.paused = true;
      room.error = "initialize timeout";
      room.options.onChange();
    });
    let reject: ((error: Error) => void) | undefined;
    room.resume.mockImplementation(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "AIの接続をやり直す" }));
    fireEvent.click(screen.getAllByRole("button", { name: "通話を終了" })[0]);
    expect(room.leave).toHaveBeenCalledOnce();
    await act(async () => {
      reject?.(new Error("Cancelled startup"));
    });
    open();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "新しい相手を招待" })).toBeTruthy();
  });

  it("requires an explicit configured service, keeps configuration outside everyday call controls, and reports failures", async () => {
    test.endpoint = "";
    render(<PeerCallControl />);
    open();
    expect(screen.getByRole("button", { name: "新しい相手を招待" })).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "設定する" }));
    expect(screen.queryByRole("button", { name: "新しい相手を招待" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "通話サーバー" }), {
      target: { value: "bad-address" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存する" }));
    expect(screen.getByRole("alert").textContent).toBe("Invalid endpoint");
    fireEvent.change(screen.getByRole("textbox", { name: "通話サーバー" }), {
      target: { value: "wss://call.example.com/rooms" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存する" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "新しい相手を招待" })).toHaveProperty(
      "disabled",
      false,
    );
    expect(test.rooms).toHaveLength(0);
  });

  it("keeps toolbar keyboard access, restores the trigger on Escape, and preserves a waiting room until unmount", async () => {
    const onRoomChange = vi.fn();
    const view = render(<PeerCallControl onRoomChange={onRoomChange} />);
    const room = await createRoom();
    const dialog = screen.getByRole("dialog");
    const first = within(dialog).getAllByRole("button")[0];
    const cancel = screen.getByRole("button", { name: "キャンセル" });
    first.focus();
    expect(dialog.getAttribute("aria-modal")).toBeNull();
    expect(fireEvent.keyDown(first, { key: "Tab", shiftKey: true })).toBe(true);
    fireEvent.keyDown(cancel, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "通話" }));
    expect(room.leave).not.toHaveBeenCalled();
    view.unmount();
    expect(room.leave).toHaveBeenCalledOnce();
    expect(onRoomChange).toHaveBeenLastCalledWith(null);
  });

  it("uses the latest room callback and clears the connected main view when the page is hidden", async () => {
    const first = vi.fn();
    const latest = vi.fn();
    const view = render(<PeerCallControl onRoomChange={first} />);
    const room = await connectedRoom();
    view.rerender(<PeerCallControl onRoomChange={latest} />);
    first.mockClear();
    act(() => room.options.onChange());
    expect(latest).toHaveBeenLastCalledWith(room);
    expect(first).not.toHaveBeenCalled();
    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(room.leave).toHaveBeenCalledOnce();
    expect(latest).toHaveBeenLastCalledWith(null);
    view.unmount();
    expect(room.leave).toHaveBeenCalledOnce();
  });

  it("does not resurrect a room when creation finishes after cancellation", async () => {
    let resolve!: () => void;
    test.creation = new Promise<void>((done) => {
      resolve = done;
    });
    render(<PeerCallControl />);
    open();
    fireEvent.click(screen.getByRole("button", { name: "新しい相手を招待" }));
    const room = test.rooms[0];
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    await act(async () => {
      resolve();
    });
    expect(room.leave).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "新しい相手を招待" })).toBeTruthy();
    expect(screen.queryByText("招待の準備ができました")).toBeNull();
  });

  it.each([
    "portrait",
    "companion",
  ])("opens readable native entry for %s, keeps its room on handoff/close, and hides it on admission", async (viewMode) => {
    test.native = true;
    render(<PeerCallControl viewMode={viewMode} residentName="より" />);
    open();
    await waitFor(() =>
      expect(test.nativeInvoke).toHaveBeenCalledWith("auxiliary_window_open", {
        kind: "call-controls",
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    const latest = () =>
      test.nativeInvoke.mock.calls
        .filter(([command]) => command === "call_controls_publish")
        .slice(-1)[0]?.[1].snapshot;
    const dispatch = (action: unknown) =>
      act(() =>
        test.nativeHandlers.get("call-controls-action")?.({
          payload: { revision: latest().revision, action },
        }),
      );
    dispatch({ type: "create", name: "より" });
    await waitFor(() => expect(test.rooms).toHaveLength(1));
    const room = test.rooms[0];
    await waitFor(() => expect(latest().signalState).toBe("hosting"));
    act(() => requestControlSurface("settings"));
    await waitFor(() =>
      expect(test.nativeInvoke).toHaveBeenCalledWith("call_controls_hide", undefined),
    );
    expect(room.leave).not.toHaveBeenCalled();
    open();
    await waitFor(() => expect(latest().enabled).toBe(true));
    act(() => test.nativeHandlers.get("call-controls-closed")?.({ payload: null }));
    expect(room.leave).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "通話" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    open();
    act(() => room.incoming());
    await waitFor(() => expect(latest().guest?.name).toBe("GPT"));
    dispatch({ type: "accept", requestId: latest().guest.requestId });
    await screen.findByRole("complementary", { name: "通話中" });
    await waitFor(() => expect(latest().enabled).toBe(false));
    expect(room.accept).toHaveBeenCalledOnce();
    expect(room.leave).not.toHaveBeenCalled();
  });

  it.each([
    "settings",
    "sharing",
    "view-mode",
  ] as const)("keeps Theater entry inline and hands focus to %s without leaving", async (surface) => {
    test.native = true;
    render(
      <>
        <button type="button" onClick={() => requestControlSurface(surface)}>
          Settings destination
        </button>
        <PeerCallControl viewMode="theater" />
      </>,
    );
    const room = await createRoom();
    expect(screen.getByRole("dialog").getAttribute("aria-modal")).toBeNull();
    const target = screen.getByRole("button", { name: "Settings destination" });
    target.focus();
    fireEvent.click(target);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(target);
    expect(room.leave).not.toHaveBeenCalled();
    open();
    expect(screen.getByRole("textbox", { name: "部屋の招待コード" })).toHaveProperty(
      "value",
      room.signaling.invitation,
    );
    expect(test.rooms).toHaveLength(1);
    expect(
      test.nativeInvoke.mock.calls.some(([command]) => command === "auxiliary_window_open"),
    ).toBe(false);
  });

  it("falls back to usable inline entry with restart guidance for an older native binary", async () => {
    test.native = true;
    test.nativeFailure = true;
    render(<PeerCallControl viewMode="portrait" />);
    open();
    await screen.findByRole("dialog");
    expect(screen.getByRole("alert").textContent).toContain("再起動");
    expect(screen.getByRole("button", { name: "新しい相手を招待" })).toBeTruthy();
    expect(
      test.nativeInvoke.mock.calls.some(([command]) => command === "auxiliary_window_open"),
    ).toBe(false);
    expect(test.rooms).toHaveLength(0);
  });

  it("supports English entry and call controls without presenting a fake successful call", async () => {
    render(<PeerCallControl language="en" residentName="Yori" />);
    fireEvent.click(screen.getByRole("button", { name: "Call" }));
    fireEvent.click(screen.getByRole("button", { name: "Invite someone new" }));
    await screen.findByText("Your invitation is ready");
    expect(screen.queryByRole("button", { name: "Send topic" })).toBeNull();
    const room = test.rooms[0];
    act(() => {
      room.error = "Connection unavailable";
      room.closed = true;
      room.options.onChange();
    });
    expect(screen.getByRole("alert").textContent).toBe("Connection unavailable");
    expect(screen.getByRole("button", { name: "Invite someone new" })).toBeTruthy();
  });
});
