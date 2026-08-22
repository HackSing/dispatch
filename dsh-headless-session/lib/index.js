import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
//#region lib/types/index.js
/**
* @aiwaretop/dsh-headless-session — one-shot direct Agent driver with durable,
* resumable sessions. The bundle patch rides over dsh-base + dsh-headless
* without Host, HTTP, or browser plugins; this runner creates or resumes one
* Agent through the core registry, drives the task to quiescence, flushes its
* Session, prints the final assistant text, and exits.
*
* @module @aiwaretop/dsh-headless-session
*/
/** Stable Cordis plugin name. */
const name = "dispatch-headless-runner";
/** Core services required before the one-shot turn can start. */
const inject = [
	"agentDefaultModel",
	"agents",
	"sessions"
];
const Config = z.object({ task: z.string().required(), sessionId: z.string(), resumeId: z.string() });
/** The process streams the runner writes to; tests substitute captures. */
const internals = {
	stdout: process.stdout,
	stderr: process.stderr
};
/** Bare ids and `session-`-prefixed ids name the same session. */
const normalize = (id) => id.startsWith("session-") ? id : `session-${id}`;
/** Aggregate the last assistant text and turn outcome in one owned interval. */
function summarize(events, firstSeq) {
	let started = false;
	let text = "";
	let reason;
	for (const event of events) {
		if (event.seq < firstSeq) continue;
		if (event.type === "turn/start") {
			started = true;
			continue;
		}
		if (!started) continue;
		if (event.type === "assistant/message") {
			const joined = event.data.message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
			if (joined !== "") text = joined;
		}
		if (event.type === "turn/end") reason = event.data.reason;
	}
	return {
		text,
		reason
	};
}
/** Report an unexpected direct-driver failure and request a failing exit. */
function fail(io, error) {
	io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`);
	io.exit(1);
}
/**
* Run one task through a created or resumed Agent and request process exit.
* @param ctx - plugin context carrying the Agent, default model, Session, and launcher IO services.
* @param config - validated task plus session-selection config.
* @param io - process-facing effects.
*/
async function run(ctx, config, io) {
	await ctx.get("loader")?.await();
	const agents = ctx.get("agents");
	const defaultModel = ctx.get("agentDefaultModel");
	const sessions = ctx.get("sessions");
	if (agents === void 0 || defaultModel === void 0 || sessions === void 0) return;
	const selection = defaultModel.currentSelection();
	const { agent } = config.resumeId !== void 0
		? await agents.resume({
			resumeSessionId: SessionId(normalize(config.resumeId)),
			agentOptions: {
				provider: selection.provider,
				model: selection.model
			},
			setup: (agentCtx) => {
				installModelSelection(agentCtx, {
					current: selection,
					assembled: void 0
				});
			}
		})
		: await agents.create({
			sessionId: SessionId(normalize(config.sessionId ?? randomUUID())),
			meta: { cwd: process.cwd() },
			agentOptions: {
				provider: selection.provider,
				model: selection.model
			},
			setup: (agentCtx) => {
				installModelSelection(agentCtx, {
					current: selection,
					assembled: void 0
				});
			}
		});
	await agent.whenIdle();
	const firstSeq = agent.session.seq;
	agent.followup(createUserMessage({
		content: [{
			type: "text",
			text: config.task
		}],
		source: { kind: "user" }
	}));
	await agent.whenIdle();
	await sessions.flush(agent.session);
	const outcome = summarize(agent.session.events, firstSeq);
	io.stdout.write(outcome.text + "\n");
	if (outcome.reason?.kind === "error") io.stderr.write(`dsh: ${outcome.reason.error.code}: ${outcome.reason.error.message}\n`);
	io.exit(outcome.reason?.kind === "completed" ? 0 : 1);
}
/**
* Mount the one-shot direct driver.
* @param ctx - plugin context carrying core services and the launcher-provided exit request.
* @param config - validated task plus session-selection config.
*/
function apply(ctx, config) {
	const exit = ctx.get("appExit");
	if (exit === void 0) throw new Error("dispatch-headless-runner: the launcher must provide ctx.appExit before the tree mounts");
	const io = {
		stdout: internals.stdout,
		stderr: internals.stderr,
		exit
	};
	run(ctx, config, io).catch((error) => {
		fail(io, error);
	});
}
//#endregion
export { Config, apply, inject, internals, name };
