// Overlay: which "reconnect your calendar" message a failed event add shows.
// The main process names the provider that refused; the chosen target covers
// replies that leave it out.

export function reconnectMessageKey(result, target) {
  const provider = result?.provider;
  const outlook = provider === "microsoft" || (!provider && target === "mcal");
  return outlook
    ? "dictationAgent.intents.reconnectNeededMcal"
    : "dictationAgent.intents.reconnectNeededGcal";
}
