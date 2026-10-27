/**
 * Mirror a turn to the terminal where the exe window runs: tool calls,
 * assistant text and notices. The browser keeps its SSE stream; the terminal
 * is the only place a launched --gui process can show what is executing.
 */
export const consoleUi = (ui, key) => {
  let text = "";
  let reason = "";
  const cap = (s, n) => String(s).slice(0, n) + (String(s).length > n ? " …" : "");
  const flushText = () => { if (text) { console.log(`[${key}] ${cap(text, 400)}`); text = ""; } };
  const flushReason = () => { if (reason) { console.log(`[${key}] (reasoning) ${cap(reason, 300)}`); reason = ""; } };
  const clear = () => { flushReason(); flushText(); };
  return {
    ...ui,
    streamText: (t) => { text += t; ui.streamText(t); },
    reasoningText: (t) => { reason += t; ui.reasoningText(t); },
    endStream: () => { clear(); ui.endStream(); },
    toolStart: (name, args) => {
      clear();
      const sum = args && Object.keys(args).length ? " " + JSON.stringify(args).slice(0, 80) : "";
      console.log(`[${key}] ▶ ${name}${sum}`);
      ui.toolStart(name, args);
    },
    toolEnd: (name, ok, elapsed, output, extra) => {
      clear();
      const out = output ? " — " + String(output).replace(/\s+/g, " ").slice(0, 60) : "";
      console.log(`[${key}]   ${ok ? "✓" : "✗"} ${name}${elapsed ? " " + Math.round(elapsed) + "ms" : ""}${out}`);
      ui.toolEnd(name, ok, elapsed, output, extra);
    },
    info: (t) => { clear(); console.log(`[${key}] · ${t}`); ui.info(t); },
    warn: (t) => { clear(); console.log(`[${key}] ! ${t}`); ui.warn(t); },
    error: (t) => { clear(); console.log(`[${key}] ✗ ${t}`); ui.error(t); },
    success: (t) => { clear(); console.log(`[${key}] ✓ ${t}`); ui.success(t); },
  };
};
