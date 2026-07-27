import {
  BrowserHandoffReadySchema,
  BrowserHandoffStateSchema,
  type BrowserHandoffInput,
  type BrowserHandoffReady,
  type BrowserHandoffState,
} from "@sparklab/shared-types";
import { z } from "zod";

/** Official control-plane schemas, narrowed for direct ephemeral routing. */
export const BrowserHandoffControlFrameSchema = z.union([
  BrowserHandoffReadySchema,
  BrowserHandoffStateSchema,
]);

export type BrowserHandoffControlFrame =
  BrowserHandoffReady | BrowserHandoffState;
export type HandoffInput = BrowserHandoffInput;
