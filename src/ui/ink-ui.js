import React from "react";
import { render } from "ink";
import { App } from "./ink-app.js";
import { TuiBridge } from "./tui-bridge.js";

const h = React.createElement;

export function startTui({ config, onSubmit, onCommand, onExit, getStats }) {
  const bridge = new TuiBridge({ config });

  const instance = render(
    h(App, {
      bridge,
      config,
      onSubmit,
      onCommand,
      getStats,
      onExit: () => {
        onExit?.();
        instance.unmount();
      },
    }),
    { exitOnCtrlC: false, patchConsole: true }
  );

  return { bridge, instance, waitUntilExit: () => instance.waitUntilExit() };
}
