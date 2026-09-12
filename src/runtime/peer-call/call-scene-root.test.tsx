// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect, useState } from "react";
import { Vector3 } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useYorishiroControls } from "../../sdk/controls";
import type { ScenePackComponentProps } from "../../sdk/scene-pack";
import { AttentionLightCueStore } from "../attention-light-cue/cue-store";
import { levaStore } from "../leva";
import type { ScenePackEntry } from "../scene-pack-registry/types";
import { getThreeRuntime } from "../three-runtime";
import {
  AttentionCueLight,
  AttentionCueRuntimeProvider,
} from "../three-runtime/attention-cue-light";
import { AttentionLightSettingsStore } from "../three-runtime/attention-light-settings";
import { CallSceneRoot } from "./call-scene-root";

vi.mock("@react-three/fiber", () => ({ useFrame: vi.fn() }));
vi.mock("../three-runtime", () => ({
  getThreeRuntime: vi.fn(() => {
    throw new Error("Scene-only root must not create the main runtime");
  }),
}));

function entry(component: ScenePackEntry["component"]): ScenePackEntry {
  return {
    id: "room",
    origin: "user",
    component,
    manifest: {
      id: "room",
      type: "scene",
      version: "1",
      yorishiroVersion: "1",
      entry: "scene.tsx",
    },
    scene: { id: "room", layers: [] },
    resolveAsset: (path) => `resolved:${path}`,
  };
}

const getAnchor = () => new Vector3(0, 1.4, 0);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  levaStore.dispose();
});

describe("CallSceneRoot", () => {
  it("applies settings to controls registered after initial scene mount and later updates", async () => {
    let reveal: (() => void) | undefined;
    const evaluate = vi.fn();
    const unmounted = vi.fn();
    const onError = vi.fn();
    function Lights() {
      const [values] = useYorishiroControls("lights", () => ({
        intensity: { value: 1, min: 0, max: 10 },
      }));
      return <output data-testid="intensity">{values.intensity}</output>;
    }
    function Scene({ camera, resolveAsset }: ScenePackComponentProps) {
      const [ready, setReady] = useState(false);
      reveal = () => setReady(true);
      useEffect(() => {
        const handle = camera.addFovModulation("drift", evaluate);
        return () => {
          handle.dispose();
          unmounted();
        };
      }, [camera]);
      return (
        <>
          <span>{resolveAsset("./room.glb")}</span>
          <span>{String(camera.isSuspended)}</span>
          {ready ? <Lights /> : null}
        </>
      );
    }
    const selected = entry(Scene);
    const view = render(
      <CallSceneRoot
        entry={selected}
        controls={{ "lights.intensity": 3, "unknown.value": 9 }}
        getAnchor={getAnchor}
        onError={onError}
      />,
    );
    expect(screen.queryByTestId("intensity")).toBeNull();
    await act(async () => reveal?.());
    expect(screen.getByTestId("intensity").textContent).toBe("3");
    view.rerender(
      <CallSceneRoot
        entry={{ ...selected }}
        controls={{ "lights.intensity": 7 }}
        getAnchor={getAnchor}
        onError={onError}
      />,
    );
    expect(screen.getByTestId("intensity").textContent).toBe("7");
    expect(unmounted).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
    expect(getThreeRuntime).not.toHaveBeenCalled();
    expect(levaStore.get("lights.intensity")).toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
    view.unmount();
    expect(unmounted).toHaveBeenCalledOnce();
  });

  it("replaces a same-id component and its control schema after a scene reload", () => {
    const onError = vi.fn();
    function First() {
      const [values] = useYorishiroControls(() => ({ shade: { value: 2, min: 0, max: 10 } }));
      return <output>{values.shade}</output>;
    }
    function Second() {
      const [values] = useYorishiroControls(() => ({ shade: { value: "warm" } }));
      return <output>{values.shade}</output>;
    }
    const view = render(
      <CallSceneRoot
        entry={entry(First)}
        controls={{ shade: 4 }}
        getAnchor={getAnchor}
        onError={onError}
      />,
    );
    expect(screen.getByText("4")).toBeTruthy();
    view.rerender(
      <CallSceneRoot
        entry={entry(Second)}
        controls={{ shade: "cool" }}
        getAnchor={getAnchor}
        onError={onError}
      />,
    );
    expect(screen.getByText("cool")).toBeTruthy();
    expect(onError).not.toHaveBeenCalled();
  });

  it("uses the injected scene anchor for nested attention lights instead of main runtime", () => {
    const cueStore = new AttentionLightCueStore({ settings: new AttentionLightSettingsStore() });
    const anchor = vi.fn(getAnchor);
    const view = render(
      <AttentionCueRuntimeProvider value={{ cueStore, getAnchor: anchor }}>
        <AttentionCueLight />
      </AttentionCueRuntimeProvider>,
    );
    act(() => {
      cueStore.cueForAttention("test");
    });
    expect(anchor).toHaveBeenCalled();
    expect(view.container.querySelector('[name="yorishiro-attention-cue-light"]')).not.toBeNull();
    expect(getThreeRuntime).not.toHaveBeenCalled();
  });
});
