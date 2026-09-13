import { PeerCallConnection } from "../../src/runtime/peer-call/peer-connection.ts";
import { RoomAudio } from "../../src/runtime/peer-call/room-audio.ts";

const button = document.querySelector("#run");
const status = document.querySelector("#status");
const rows = document.querySelector("#phases");
const output = document.querySelector("#result");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function requireCheck(condition, message) {
  if (!condition) throw new Error(message);
}

async function until(check, timeout = 30_000) {
  const deadline = performance.now() + timeout;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error("Local WebRTC connection timed out");
    await delay(50);
  }
}

button.addEventListener("click", async () => {
  button.disabled = true;
  rows.replaceChildren();
  output.textContent = "";
  status.className = "";
  status.textContent = "Connecting two local endpoints…";
  const report = { status: "running", received: { left: [], right: [] }, phases: [], cleanup: {} };
  const context = new AudioContext();
  const left = new RoomAudio(false);
  const right = new RoomAudio(false);
  const nodes = [];
  const ownedTracks = [];
  const productTracks = [];
  const decoderSinks = [];
  const peers = [];
  const media = navigator.mediaDevices;
  const originalCapture = Object.getOwnPropertyDescriptor(media, "getUserMedia");
  let captureRequests = 0;
  let failure;
  const states = { left: "new", right: "new" };

  function tone(frequency) {
    const oscillator = context.createOscillator();
    oscillator.frequency.value = frequency;
    const gain = context.createGain();
    gain.gain.value = 0;
    const destination = context.createMediaStreamDestination();
    oscillator.connect(gain).connect(destination);
    oscillator.start();
    nodes.push(oscillator, gain, destination);
    ownedTracks.push(...destination.stream.getTracks());
    return { oscillator, gain, stream: destination.stream };
  }

  function meter(stream) {
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    nodes.push(source, analyser);
    const samples = new Float32Array(analyser.fftSize);
    return () => {
      analyser.getFloatTimeDomainData(samples);
      return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
    };
  }

  try {
    const human = tone(880);
    const agent = tone(220);
    // The replacement belongs to this isolated fixture page, not the app. It
    // returns a fresh owned clone each time and never delegates to real capture.
    Object.defineProperty(media, "getUserMedia", {
      configurable: true,
      value: async () => {
        ++captureRequests;
        const stream = human.stream.clone();
        ownedTracks.push(...stream.getTracks());
        productTracks.push(...stream.getTracks());
        return stream;
      },
    });
    // Start all contexts during this button's user activation.
    const [, leftTracks, rightTracks] = await Promise.all([
      context.resume(),
      left.prepare(),
      right.prepare(),
    ]);
    await Promise.all([left.setOutput(false), right.setOutput(false)]);
    ownedTracks.push(...Object.values(leftTracks), ...Object.values(rightTracks));
    productTracks.push(...Object.values(leftTracks), ...Object.values(rightTracks));
    const receivedMeters = {};
    const errors = [];
    for (const [name, audio] of [
      ["left", left],
      ["right", right],
    ]) {
      const peer = new PeerCallConnection({
        iceServers: [],
        productCall: true,
        onState: (state) => {
          states[name] = state;
        },
        onError: (error) => errors.push(error.message),
        onRemoteStream: (stream, kind) => {
          report.received[name].push(kind);
          ownedTracks.push(...stream.getTracks());
          productTracks.push(...stream.getTracks());
          if (kind !== "agent" && kind !== "human") {
            errors.push("An incoming track did not have a validated agent/human MID");
            return;
          }
          // Headless Chrome can receive RTP without starting its audio decoder
          // until a media-element sink consumes the stream. Keep that sink silent;
          // all measured routing and mouth values still come from real RoomAudio.
          const sink = new Audio();
          sink.muted = true;
          sink.srcObject = stream;
          decoderSinks.push(sink);
          void sink.play().catch((error) => errors.push(error.message));
          audio.setRemote(kind, stream);
          if (name === "right") receivedMeters[kind] = meter(stream);
        },
      });
      peers.push(peer);
    }
    await Promise.all([
      peers[0].setAudioTrack(leftTracks.agent, "agent"),
      peers[0].setAudioTrack(leftTracks.human, "human"),
      peers[1].setAudioTrack(rightTracks.agent, "agent"),
      peers[1].setAudioTrack(rightTracks.human, "human"),
    ]);
    const offer = await peers[0].createOffer();
    const answer = await peers[1].acceptOffer(offer);
    report.iceCandidates = [offer, answer].map((signal) => {
      const candidates = JSON.parse(signal)
        .sdp.split(/\r?\n/)
        .filter((line) => line.startsWith("a=candidate:"));
      return {
        count: candidates.length,
        types: candidates.map((line) => / typ (\w+)/.exec(line)?.[1] ?? "unknown"),
        mdns: candidates.filter((line) => line.includes(".local ")).length,
      };
    });
    await peers[0].acceptAnswer(answer);
    await until(
      () =>
        errors.length ||
        (Object.values(states).every((state) => state === "connected") &&
          Object.values(report.received).every((kinds) => kinds.length === 2)),
    );
    requireCheck(errors.length === 0, errors.join("; "));
    for (const kinds of Object.values(report.received)) {
      requireCheck(
        [...kinds].sort().join(",") === "agent,human",
        "Exactly two typed tracks required",
      );
    }
    await left.setMicrophone(true);
    await left.setAgent(agent.stream);
    const inputRms = meter(right.getAgentInput());
    const ownInputRms = meter(left.getAgentInput());
    const sentHumanRms = meter(new MediaStream([leftTracks.human]));
    const sentAgentRms = meter(new MediaStream([leftTracks.agent]));
    productTracks.push(...left.getAgentInput().getTracks(), ...right.getAgentInput().getTracks());

    async function phase(name, humanEnabled, agentEnabled) {
      status.textContent = `Measuring ${name}…`;
      human.gain.gain.value = humanEnabled ? 0.1 : 0;
      agent.gain.gain.value = agentEnabled ? 0.1 : 0;
      await delay(1000); // Drain buffered Opus and the input compressor release.
      const values = { human: 0, agent: 0, input: 0, mouth: 0, ownInput: 0 };
      for (let i = 0; i < 16; ++i) {
        values.human += receivedMeters.human();
        values.agent += receivedMeters.agent();
        values.input += inputRms();
        values.mouth += right.sampleRemoteMouth();
        values.ownInput += ownInputRms();
        await delay(40);
      }
      for (const key of Object.keys(values)) values[key] = Number((values[key] / 16).toFixed(6));
      report.phases.push({ name, ...values });
      report.lastSender = { human: sentHumanRms(), agent: sentAgentRms() };
      const row = document.createElement("tr");
      for (const value of [name, ...Object.values(values)]) {
        const cell = document.createElement("td");
        cell.textContent = String(value);
        row.append(cell);
      }
      rows.append(row);
      requireCheck(errors.length === 0, errors.join("; "));
      requireCheck(
        humanEnabled ? values.human > 0.015 : values.human < 0.004,
        `${name}: human track contamination or silence`,
      );
      requireCheck(
        agentEnabled ? values.agent > 0.015 : values.agent < 0.004,
        `${name}: AI track contamination or silence`,
      );
      requireCheck(
        humanEnabled || agentEnabled ? values.input > 0.01 : values.input < 0.004,
        `${name}: provider input mix is incorrect`,
      );
      requireCheck(
        agentEnabled ? values.mouth > 0.05 : values.mouth < 0.01,
        `${name}: remote mouth must follow only AI audio`,
      );
      requireCheck(
        humanEnabled ? values.ownInput > 0.01 : values.ownInput < 0.004,
        `${name}: own AI leaked into its provider input`,
      );
    }

    await phase("silent", false, false);
    await phase("human only", true, false);
    await phase("AI only", false, true);
    await phase("human + AI", true, true);
    left.stopMicrophone();
    left.stopAgent();
    await phase("sources stopped", false, false);
    report.captureRequests = captureRequests;
    requireCheck(captureRequests === 1, "Expected exactly one synthetic microphone request");
    const trackCounts = await Promise.all(
      peers.map(async (peer) => {
        const stats = await peer.getStats();
        return [...stats.values()].filter(
          (entry) =>
            entry.type === "inbound-rtp" && entry.kind === "audio" && entry.bytesReceived > 0,
        ).length;
      }),
    );
    report.inboundAudioRtp = trackCounts;
    requireCheck(
      trackCounts.every((count) => count === 2),
      "Both endpoints must receive two real RTP audio streams",
    );
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    report.connectionStates = { ...states };
    report.transports = await Promise.all(
      peers.map(async (peer) => {
        try {
          const stats = await peer.getStats();
          return [...stats.values()]
            .filter((entry) =>
              ["transport", "candidate-pair", "inbound-rtp", "media-source"].includes(entry.type),
            )
            .map((entry) => ({
              type: entry.type,
              state: entry.state,
              dtlsState: entry.dtlsState,
              iceState: entry.iceState,
              nominated: entry.nominated,
              bytesSent: entry.bytesSent,
              bytesReceived: entry.bytesReceived,
              kind: entry.kind,
              audioLevel: entry.audioLevel,
              totalAudioEnergy: entry.totalAudioEnergy,
              totalSamplesReceived: entry.totalSamplesReceived,
            }));
        } catch {
          return [];
        }
      }),
    );
  } finally {
    for (const peer of peers) peer.close();
    left.close();
    right.close();
    const allProductTracksEnded = productTracks.every((track) => track.readyState === "ended");
    for (const sink of decoderSinks) {
      sink.pause();
      sink.srcObject = null;
    }
    for (const node of nodes) {
      if (node instanceof OscillatorNode) node.stop();
      node.disconnect();
    }
    for (const track of ownedTracks) track.stop();
    await context.close();
    if (originalCapture) Object.defineProperty(media, "getUserMedia", originalCapture);
    else delete media.getUserMedia;
    report.cleanup = {
      syntheticContext: context.state,
      allProductTracksEnded,
      localMouth: left.sampleLocalMouth(),
      remoteMouth: right.sampleRemoteMouth(),
      providerInputsReleased: left.getAgentInput() === null && right.getAgentInput() === null,
      microphoneReleased: !left.microphoneActive && !right.microphoneActive,
    };
    if (
      !report.cleanup.allProductTracksEnded ||
      !report.cleanup.providerInputsReleased ||
      !report.cleanup.microphoneReleased
    ) {
      failure ??= "Audio resources were not released";
    }
    report.status = failure ? "FAIL" : "PASS";
    if (failure) report.error = failure;
    output.textContent = JSON.stringify(report, null, 2);
    status.textContent = failure
      ? `FAIL: ${failure}`
      : "PASS: five phases, two RTP audio streams per endpoint, cleanup complete";
    status.className = failure ? "fail" : "pass";
    button.disabled = false;
  }
});
