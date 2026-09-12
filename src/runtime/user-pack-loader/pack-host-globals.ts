import * as ReactThreeDrei from "@react-three/drei";
import * as ReactThreeFiber from "@react-three/fiber";
import * as ReactThreePostprocessing from "@react-three/postprocessing";
import * as Postprocessing from "postprocessing";
import * as React from "react";
import * as ReactJsxRuntime from "react/jsx-runtime";
import * as ReactDomClient from "react-dom/client";
import * as THREE from "three";
import * as YorishiroAttentionCue from "../../sdk/attention-cue";
import * as YorishiroControls from "../../sdk/controls";
import * as YorishiroR3f from "../../sdk/r3f";

/** The same host-owned imports for main and scene-only auxiliary WebViews. */
export function installPackHostGlobals(): void {
  globalThis.__YORISHIRO_REACT__ = React;
  globalThis.__YORISHIRO_REACT_DOM_CLIENT__ = ReactDomClient;
  globalThis.__YORISHIRO_REACT_JSX_RUNTIME__ = ReactJsxRuntime;
  globalThis.__YORISHIRO_REACT_THREE_DREI__ = ReactThreeDrei;
  globalThis.__YORISHIRO_REACT_THREE_FIBER__ = ReactThreeFiber;
  globalThis.__YORISHIRO_REACT_THREE_POSTPROCESSING__ = ReactThreePostprocessing;
  globalThis.__YORISHIRO_POSTPROCESSING__ = Postprocessing;
  globalThis.__YORISHIRO_THREE__ = THREE;
  globalThis.__YORISHIRO_SDK_ATTENTION_CUE__ = YorishiroAttentionCue;
  globalThis.__YORISHIRO_SDK_CONTROLS__ = YorishiroControls;
  globalThis.__YORISHIRO_SDK_R3F__ = YorishiroR3f;
}
