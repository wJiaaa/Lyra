import { builtInApprovalPolicy } from "../../runtime/approval-policy.ts";
import type { Context, Plugin } from "../context.ts";
import { APPROVAL, type ApprovalPolicy } from "../services.ts";

/**
 * Which actions may proceed without a person.
 *
 * The rules themselves live in `runtime/approval-policy.ts`. This plugin used to carry its own copy,
 * and the two drifted: a rule added there was tested and never reached the app, which runs this one.
 *
 * A seam because the answer is a matter of policy, not of fact: a personal machine, a shared
 * build box and a locked-down deployment want three different lines, and they should differ by
 * which policy is loaded rather than by branches inside one function.
 *
 * The built-in policy is a blacklist. Asking about everything that writes turns the prompt into
 * something people learn to click through, which is worse than not having it — so it asks about
 * what cannot be taken back, and nothing else.
 */
export const approvalPlugin: Plugin = {
	name: "approval",
	apply(ctx: Context) {
		return ctx.provide<ApprovalPolicy>(APPROVAL, builtInApprovalPolicy);
	},
};
