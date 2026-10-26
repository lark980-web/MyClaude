/**
 * Autonomous continuation: a turn-cap stop is a fuel gauge, not a finish line.
 *
 * Without this, a run that exhausts maxTurns just stops and waits for a human
 * nudge - the interruption autonomous runs exist to remove. The guardrails are
 * part of the design: a continuation-round cap, a wall-clock budget, and an
 * explicit stop must all be able to end the walk, or this reintroduces the
 * "looks stuck forever" hazard that took a debugging session to root-cause.
 *
 * Gated by config.autoRun (off by default - it burns tokens by design).
 */

/** Permissive modes that do not stall an autonomous walk. */
const PERMISSIVE = new Set(["auto", "acceptEdits", "bypassPermissions", "fullAccess"]);

/**
 * Run the agent, and when the turn cap ends the run early, keep going.
 *
 * @param {object} agent
 * @param {{message: string, attachments?: Array, reuseLastUser?: boolean}} args
 * @param {{ui?: object, maxRounds?: number, budgetMs?: number}} [opts]
 * @returns {Promise<object>} the final run result
 */
export async function runWithAutoContinue(agent, args, opts = {}) {
  const ui = opts.ui || null;
  const maxRounds = Math.max(0, Number(opts.maxRounds ?? 10));
  const budgetMs = Math.max(0, Number(opts.budgetMs ?? 60 * 60 * 1000));
  const startedAt = Date.now();
  const autonomous = !!agent.config.autoRun;
  const say = (t) => { if (ui && typeof ui.info === "function") { ui.info(t); } };

  if (autonomous && !PERMISSIVE.has(agent.mode)) {
    // A mode that asks would stall every step; an autonomous run promises not
    // to. Never downgrade an already-permissive choice.
    agent.setMode("auto");
    say("自主模式：权限已切换到 auto");
  }

  let result = await agent.run(args.message, { attachments: args.attachments, reuseLastUser: args.reuseLastUser });

  if (!autonomous) { return result; }

  let round = 0;
  while (result && result.maxTurnsReached) {
    // A user stop wins over everything, always.
    if (agent.stopRequested) { break; }
    if (maxRounds > 0 && round >= maxRounds) {
      say(`自主模式：已达续跑上限（${maxRounds} 轮）— 任务暂停在当前进度`);
      break;
    }
    if (budgetMs > 0 && Date.now() - startedAt > budgetMs) {
      say(`自主模式：已达时间预算（${Math.round(budgetMs / 60000)} 分钟）— 任务暂停在当前进度`);
      break;
    }
    round++;
    say(`自主续跑第 ${round} 轮 — 继续完成未完成的部分`);
    result = await agent.run("继续完成未完成的部分。若任务已全部完成，直接简短汇报现状即可。");
  }
  return result;
}
