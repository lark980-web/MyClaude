export function commandCoverage(registrations, excludedNames, tuiNames, guiNames) {
  if (!Array.isArray(registrations) || registrations.some(x => typeof x !== 'string' || !x)) throw new TypeError('Expected non-empty command names');
  const counts = new Map();
  for (const name of registrations) counts.set(name, (counts.get(name) || 0) + 1);
  const builtin = [...counts.keys()];
  const excluded = builtin.filter(x => excludedNames.has(x));
  const local = builtin.filter(x => !excludedNames.has(x));
  const hit = (list, surface) => list.filter(x => surface.has(x));
  const pct = (n, total) => total ? Math.round(n / total * 100) : null;
  const tui = hit(local, tuiNames), gui = hit(local, guiNames);
  const tuiAll = hit(builtin, tuiNames), guiAll = hit(builtin, guiNames);
  return {
    available: true, countingBasis: 'unique-command-name',
    builtinRegistrations: registrations.length,
    duplicateRegistrations: [...counts].filter(([, count]) => count > 1).map(([name, count]) => ({ name, count })),
    builtinCommands: builtin.length, localCommands: local.length, excluded,
    tuiCovered: tui.length, guiCovered: gui.length,
    tuiPct: pct(tui.length, local.length), guiPct: pct(gui.length, local.length),
    tuiAllCovered: tuiAll.length, guiAllCovered: guiAll.length,
    tuiAllPct: pct(tuiAll.length, builtin.length), guiAllPct: pct(guiAll.length, builtin.length),
    tuiMissing: local.filter(x => !tuiNames.has(x)), guiMissing: local.filter(x => !guiNames.has(x)),
  };
}
