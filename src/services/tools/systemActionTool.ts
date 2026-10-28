import type { ToolDefinition, ToolResult } from "./ToolRegistry";

// Overlay: the assistant's only way to act on the laptop. The main process
// (src/helpers/overlay/systemActions.js) enforces the allowlist and shows a
// confirmation for risky actions, so this tool can't do more than listed here.
export const SYSTEM_ACTION_NAMES = [
  "volume_up",
  "volume_down",
  "volume_mute",
  "volume_set",
  "media_play_pause",
  "media_next",
  "media_previous",
  "open_app",
  "open_url",
  "show_time",
  "lock_screen",
  "screenshot",
  "brightness_set",
] as const;

export const systemActionTool: ToolDefinition = {
  name: "system_action",
  description:
    "Do one simple action on the user's Windows laptop: change volume, control media, open an " +
    "installed app by name, open a web link, tell the time, lock the screen, take a screenshot, " +
    "or set brightness. Use it only when the user asks for that action.",
  promptInstruction:
    "system_action: use for laptop commands like 'open Chrome', 'volume down', 'pause music', " +
    "'what time is it'. Only the listed actions exist; shutdown, restart and running commands are " +
    "not possible. Lock screen, screenshot and brightness ask the user to confirm on screen.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [...SYSTEM_ACTION_NAMES],
        description: "Which action to perform",
      },
      app: {
        type: "string",
        description: "For open_app: the app's name, e.g. 'chrome', 'notepad', 'spotify'",
      },
      url: { type: "string", description: "For open_url: a full https:// link" },
      level: {
        type: "number",
        description: "For volume_set / brightness_set: 0 to 100",
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
  readOnly: false,

  async execute(args: Record<string, unknown>, context): Promise<ToolResult> {
    const api = window.electronAPI;
    if (!api?.overlaySystemAction) {
      return { success: false, data: null, displayText: "Laptop actions need the desktop app" };
    }
    const result = await api.overlaySystemAction({
      action: String(args.action || ""),
      app: typeof args.app === "string" ? args.app : undefined,
      url: typeof args.url === "string" ? args.url : undefined,
      level: typeof args.level === "number" ? args.level : undefined,
    });
    // An action happened outside the app: keep the answer in the overlay
    // instead of typing it at the cursor.
    if (result.success) context?.onHoldDelivery?.();
    return {
      success: result.success,
      data: result.success ? result.message || "Done" : null,
      displayText: result.success ? result.message || "Done" : result.error || "Action failed",
    };
  },
};
