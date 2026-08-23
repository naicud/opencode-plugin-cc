// Rolling tracker of assistant text parts, fed by OpenCode SSE
// "message.part.updated" events. Lets the supervision tools surface live
// progress (latest assistant output) without extra HTTP polling.

/**
 * @returns {{ handleEvent: (event: object) => void, assistantText: (sessionID: string) => string, size: () => number }}
 */
export function createPartTracker() {
  /** @type {Map<string, string>} partKey -> accumulated text */
  const parts = new Map();
  const MAX_PARTS = 500;

  function handleEvent(event) {
    if (event?.type !== "message.part.updated") return;
    const props = event.properties ?? {};
    const part = props.part ?? {};
    const sessionID = props.sessionID ?? part.sessionID;
    if (!sessionID || part.type !== "text" || typeof part.text !== "string") return;
    // Keyed by part id so repeated updates of one streaming part replace
    // instead of duplicate; insertion order preserves reading order.
    parts.set(`${sessionID}:${part.messageID ?? "?"}:${part.id ?? "?"}`, part.text);
    if (parts.size > MAX_PARTS) {
      // Map iterates in insertion order — drop the oldest entry.
      parts.delete(parts.keys().next().value);
    }
  }

  function assistantText(sessionID) {
    const prefix = `${sessionID}:`;
    let out = "";
    for (const [key, text] of parts) {
      if (key.startsWith(prefix)) out += text;
    }
    return out;
  }

  function size() {
    return parts.size;
  }

  return { handleEvent, assistantText, size };
}
