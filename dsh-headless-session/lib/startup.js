import { Command } from "commander";
import { parseCmdline } from "@deepseek-ai/dsh-cmdline";
//#region lib/types/startup.js
/**
* The one-shot app's command-line provider: it parses the task positional,
* `--session-id`, `--resume`, and `--help`, then publishes
* {@link DISPATCH_HEADLESS_STARTUP_SERVICE}. The runner is an ordinary consumer
* whose lazy config waits for that service.
* @module @aiwaretop/dsh-headless-session/startup
*/
/** Stable Cordis plugin name. */
const name = "dispatch-headless-startup";
/** Services required before the task can be resolved. */
const inject = ["cmdlineArgs"];
/** Service provided by this plugin and injected by the one-shot runner. */
const DISPATCH_HEADLESS_STARTUP_SERVICE = "dispatchHeadlessStartup";
/**
* This app's command: the task positional, the session options, its
* description, and its help text.
* @returns a fresh program, so one process can parse more than once (tests).
*/
function dispatchHeadlessCommand() {
	return new Command().name("dsh --profile headless-dispatch").description("Answer one task in a durable, resumable session, print the final assistant message, and exit.").helpOption("-h, --help", "show this help").option("--session-id <id>", "create the fresh run's session with the given id").option("--resume <id>", "resume an existing session instead of creating one").argument("[task...]", "the task text; multiple words are joined by spaces").addHelpText("after", `
Examples:
  dsh --profile headless-dispatch --session-id <uuid> "run the tests"   answer one task under that session id
  dsh --profile headless-dispatch --resume <uuid> "continue"            resume that session and exit
`);
}
/**
* Parse and provide the one-shot task plus session options as an ordinary
* Cordis service. The command's action publishes them; a missing or
* whitespace-only task is a usage error, as is giving both `--session-id` and
* `--resume`, so on rejection (and on `--help`) nothing is provided.
* @param ctx - plugin context carrying the command line.
*/
function apply(ctx) {
	const program = dispatchHeadlessCommand();
	program.action(() => {
		const task = program.args.join(" ");
		if (task.trim() === "") program.error("error: a task is required, for example: dsh --profile headless-dispatch \"run the tests\"");
		const opts = program.opts();
		if (opts.sessionId !== void 0 && opts.resume !== void 0) program.error("--session-id and --resume are mutually exclusive");
		ctx.provide(DISPATCH_HEADLESS_STARTUP_SERVICE, { task, sessionId: opts.sessionId, resumeId: opts.resume });
	});
	parseCmdline(ctx, program);
}
//#endregion
export { DISPATCH_HEADLESS_STARTUP_SERVICE, apply, inject, name };
