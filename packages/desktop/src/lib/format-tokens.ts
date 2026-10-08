/**
 * A token count at a glance: 812, 12.3k, 4.1M, 2.7B.
 *
 * One decimal at every scale, because the digit after the point is the one that carries the
 * difference anyone acts on — 4.1M against 4.9M is a fifth of a bill. Billions are reachable on a
 * long-running project, and without a step for them the figure ran to five digits of millions.
 *
 * Here rather than beside the running indicator that first needed it, because four surfaces now
 * print the same figure — the meter, a session card, a sub-agent's row and its bar — and a number
 * that reads differently in two of them is two numbers. The phone's running line prints it too, so
 * the rule itself lives in `@plume/client-runtime/running`.
 */
export { formatTokens } from "@plume/client-runtime/running";
