// Rolling tracker of assistant text and reasoning parts, fed by OpenCode SSE
// "message.part.updated" events. Lets the supervision tools surface live
// progress (latest assistant output AND chain-of-thought reasoning) without
// extra HTTP polling.

/**
 * @returns {{
 *   handleEvent: (event: object) => void,
 *   assistantText: (sessionID: string) => string,
 *   reasoningText: (sessionID: string) => string,
 *   size: () => number
 * }}
 */
export function createPartTracker() {
  /** @type {Map<string, {type: string, text: string}>} partKey -> part */
  const parts = new Map();
  const MAX_PARTS = 500;

  function handleEvent(event) {
    if (event?.type !== "message.part.updated") return;
    const props = event.properties ?? {};
    const part = props.part ?? {};
    const sessionID = props.sessionID ?? part.sessionID;
    if (!sessionID || typeof part.text !== "string") return;
    if (part.type !== "text" && part.type !== "reasoning") return;
    // Keyed by part id so repeated updates of one streaming part replace
    // instead of duplicate; insertion order preserves reading order.
    parts.set(`${sessionID}:${part.messageID ?? "?"}:${part.id ?? "?"}`, {
      type: part.type,
      text: part.text,
    });
    if (parts.size > MAX_PARTS) {
      // Map iterates in insertion order — drop the oldest entry.
      parts.delete(parts.keys().next().value);
    }
  }

  function collect(sessionID, type) {
    const prefix = `${sessionID}:`;
    let out = "";
    for (const [key, part] of parts) {
      if (key.startsWith(prefix) && part.type === type) out += part.text;
    }
    return out;
  }

  function assistantText(sessionID) {
    return collect(sessionID, "text");
  }

  function reasoningText(sessionID) {
    return collect(sessionID, "reasoning");
  }

  function size() {
    return parts.size;
  }

  return { handleEvent, assistantText, reasoningText, size };
}
