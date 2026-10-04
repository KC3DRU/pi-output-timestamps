import { registerHooks } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
const STUB = new URL("./pi-tui-stub.mjs", import.meta.url).href;
registerHooks({
	resolve: (s, c, n) =>
		s === "@earendil-works/pi-tui"
			? { url: STUB, format: "module", shortCircuit: true }
			: n(s, c),
});

const EXT = new URL("../extensions/output-timestamps.ts", import.meta.url).href;
const START = Date.UTC(2026, 9, 4, 10, 30, 15);
const TEXT = "C-index is rank-based.";
const STAMP_LINE = /^`?@ \d\d:\d\d:\d\d ->`?$/;

/** A Pi build that exposes only the hooks that version actually shipped. */
function makePi({ markdown = true, tool = true } = {}) {
	const got = { transformer: undefined, resolvers: [], handlers: new Map() };
	const pi = {
		on(event, handler) {
			if (!got.handlers.has(event)) got.handlers.set(event, []);
			got.handlers.get(event).push(handler);
		},
	};
	if (markdown) pi.registerMarkdownTransformer = (f) => (got.transformer = f);
	if (tool) pi.registerToolRenderer = (r) => got.resolvers.push(r);
	return { pi, got };
}

const sessionCtx = () => ({
	sessionManager: {
		getBranch: () => [
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: TEXT }], timestamp: START } },
		],
	},
});

function hydrate(got) {
	for (const h of got.handlers.get("session_start") ?? []) h({ type: "session_start" }, sessionCtx());
}

/* --- version floors ---------------------------------------------------------- */

test("Pi without registerToolRenderer (< 1.0.1): loads, prose still stamps", async () => {
	const mod = await import(`${EXT}?v1=${Math.random()}`);
	const { pi, got } = makePi({ tool: false });

	await mod.default(pi);

	assert.ok(got.transformer, "prose transformer must still register");
	hydrate(got);
	const stamped = got.transformer(TEXT, { messageType: "assistant", isStreaming: false, availableWidth: 80 });
	assert.ok(
		stamped.split("\n").some((l) => STAMP_LINE.test(l)),
		"prose block must carry a stamp on an older Pi, got: " + JSON.stringify(stamped),
	);
});

test("Pi without registerMarkdownTransformer (< 0.84): loads, tool resolver registers", async () => {
	const mod = await import(`${EXT}?v2=${Math.random()}`);
	const { pi, got } = makePi({ markdown: false });

	await mod.default(pi);

	assert.equal(got.transformer, undefined);
	assert.equal(got.resolvers.length, 1);
});

test("Pi with neither hook: resolves without throwing, registers nothing", async () => {
	const mod = await import(`${EXT}?v3=${Math.random()}`);
	const { pi, got } = makePi({ markdown: false, tool: false });
	await mod.default(pi);
	assert.equal(got.transformer, undefined);
	assert.equal(got.resolvers.length, 0);
});

/* --- duplicate installs (global copy + project copy) -------------------------- */

test("two loaded copies print one stamp line on command blocks", async () => {
	const mod = await import(`${EXT}?dup=${Math.random()}`);
	const resolvers = [];
	for (let i = 0; i < 2; i++) {
		const pi = { on() {}, registerMarkdownTransformer() {}, registerToolRenderer: (r) => resolvers.push(r) };
		await mod.default(pi);
	}
	assert.equal(resolvers.length, 2);

	// Chain the way Pi does: each resolver receives a `next` for the remaining chain.
	let provide = () => ({ renderCall: (args) => ({ render: () => ["$ " + args.command] }) });
	for (const r of resolvers) {
		const inner = provide;
		provide = () => r("bash", inner);
	}

	const ctx = { args: { command: "ls -la" }, state: {}, executionStarted: true, lastComponent: undefined };
	const lines = provide().renderCall(ctx.args, {}, ctx).render(60);
	assert.equal(lines.filter((l) => STAMP_LINE.test(l)).length, 1, "got: " + JSON.stringify(lines));
});

test("two loaded copies print one stamp line on prose blocks", async () => {
	const mod = await import(`${EXT}?dup2=${Math.random()}`);
	const transformers = [];
	const handlers = [];
	for (let i = 0; i < 2; i++) {
		const pi = {
			on(e, h) { handlers.push(h); },
			registerMarkdownTransformer: (f) => transformers.push(f),
			registerToolRenderer() {},
		};
		await mod.default(pi);
	}
	for (const h of handlers) h({ type: "session_start" }, sessionCtx());

	let out = TEXT;
	for (const f of transformers) out = f(out, { messageType: "assistant", isStreaming: false, availableWidth: 80 });
	assert.equal(out.split("\n").filter((l) => STAMP_LINE.test(l)).length, 1, "got: " + JSON.stringify(out));
});
