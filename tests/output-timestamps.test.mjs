/**
 * Offline tests for .pi/extensions/output-timestamps.ts
 * Run: node --test --experimental-strip-types .pi/tests/
 *
 * Uses a fake ExtensionAPI + fake ReadonlySessionManager so no model call,
 * no TUI and no Pi process is needed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

// The extension imports @earendil-works/pi-tui for tool-block rendering, which is
// not resolvable from this project. Map it to a local stub (see tool-stamps.test.mjs).
const STUB = new URL("./pi-tui-stub.mjs", import.meta.url).href;
registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "@earendil-works/pi-tui") {
			return { url: STUB, format: "module", shortCircuit: true };
		}
		return next(specifier, context);
	},
});

const EXT = new URL("../extensions/output-timestamps.ts", import.meta.url).href;

const T0 = new Date(2026, 9, 4, 14, 22, 7).getTime(); // 14:22:07 local
const T1 = new Date(2026, 9, 4, 9, 5, 1).getTime(); // 09:05:01 local

/** assistant message entry with one or more text parts */
function asst(parts, timestamp, id = "a1") {
	const content = parts.map((text) => ({ type: "text", text }));
	return { type: "message", id, parentId: null, timestamp: new Date(timestamp).toISOString(), message: { role: "assistant", content, timestamp } };
}
function user(text, timestamp, id = "u1") {
	return { type: "message", id, parentId: null, timestamp: new Date(timestamp).toISOString(), message: { role: "user", content: text, timestamp } };
}
function toolOnly(timestamp, id = "a2") {
	return { type: "message", id, parentId: null, timestamp: new Date(timestamp).toISOString(), message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }], timestamp } };
}

function harness(initialBranch = []) {
	const handlers = new Map();
	let transformer = null;
	let branch = initialBranch;

	const ctx = {
		sessionManager: {
			getBranch: () => branch,
		},
	};

	const pi = {
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
			return () => {};
		},
		registerMarkdownTransformer(fn) {
			transformer = fn;
		},
		registerToolRenderer() {},
	};

	return {
		async load() {
			const mod = await import(`${EXT}?case=${Math.random()}`);
			await mod.default(pi);
			return transformer;
		},
		setBranch(next) {
			branch = next;
		},
		ctx,
		async fire(event, payload) {
			for (const h of handlers.get(event) ?? []) await h(payload, ctx);
		},
		handled: (event) => (handlers.get(event) ?? []).length > 0,
	};
}

const run = (fn, markdown, messageType, isStreaming = false, availableWidth = 80) =>
	fn(markdown, { messageType, isStreaming, availableWidth });

test("registers a markdown transformer and the lifecycle events", async () => {
	const h = harness();
	await h.load();
	assert.ok(h.handled("session_start"), "session_start");
	assert.ok(h.handled("session_tree"), "session_tree");
	assert.ok(h.handled("message_start"), "message_start");
	assert.ok(h.handled("message_end"), "message_end");
});

test("assistant block is stamped with its start time on line 1", async () => {
	const h = harness([asst(["Hello there"], T0)]);
	const fn = await h.load();
	await h.fire("session_start", { type: "session_start" });

	const out = run(fn, "Hello there", "assistant");
	assert.equal(out.split("\n")[0], "`@ 14:22:07 ->`");
	assert.match(out, /\n\nHello there$/, "original content preserved after stamp");
});

test("user messages and thinking blocks are left untouched", async () => {
	const h = harness([user("my question", T0), asst(["answer"], T1)]);
	const fn = await h.load();
	await h.fire("session_start", { type: "session_start" });

	assert.equal(run(fn, "my question", "user"), "my question");
	assert.equal(run(fn, "some reasoning", "assistant-thinking"), "some reasoning");
	assert.equal(run(fn, "answer", "assistant"), "`@ 09:05:01 ->`\n\nanswer");
});

test("PURITY: identical output across repeats and across widths (resize simulation)", async () => {
	const h = harness([asst(["stable block"], T0)]);
	const fn = await h.load();
	await h.fire("session_start", { type: "session_start" });

	const first = run(fn, "stable block", "assistant");
	for (const width of [40, 80, 120, 200]) {
		for (let i = 0; i < 3; i++) {
			assert.equal(run(fn, "stable block", "assistant", false, width), first, `width ${width} pass ${i}`);
		}
	}
	// and it must still be the original time, not 'now'
	assert.equal(first.split("\n")[0], "`@ 14:22:07 ->`");
});

test("FAIL-CLOSED: unknown block with no live message is returned unchanged", async () => {
	const h = harness([]);
	const fn = await h.load();
	await h.fire("session_start", { type: "session_start" });

	assert.equal(run(fn, "never seen before", "assistant"), "never seen before");
});

test("streaming block is stamped from its message_start time", async () => {
	const h = harness([]);
	const fn = await h.load();
	await h.fire("session_start", { type: "session_start" });

	await h.fire("message_start", { type: "message_start", message: { role: "assistant", content: [], timestamp: T0 } });

	// partial text, not yet in the map -> live start
	assert.equal(run(fn, "Half a sen", "assistant", true).split("\n")[0], "`@ 14:22:07 ->`");

	// when it finalizes, the map value equals the live value: the stamp must not jump
	const finalMsg = asst(["Half a sentence"], T0).message;
	await h.fire("message_end", { type: "message_end", message: finalMsg });
	assert.equal(run(fn, "Half a sentence", "assistant", false).split("\n")[0], "`@ 14:22:07 ->`");
});

test("BRANCH SWITCH: session_tree rebuilds times from the new active branch", async () => {
	const branchA = [asst(["shared text"], T0, "a1")];
	const branchB = [asst(["shared text"], T1, "b1")];

	const h = harness(branchA);
	const fn = await h.load();
	await h.fire("session_start", { type: "session_start" });
	assert.equal(run(fn, "shared text", "assistant").split("\n")[0], "`@ 14:22:07 ->`");

	h.setBranch(branchB);
	await h.fire("session_tree", { type: "session_tree" });
	assert.equal(run(fn, "shared text", "assistant").split("\n")[0], "`@ 09:05:01 ->`", "must follow the branch");
});

test("lazy hydration covers /reload when session_start never fires", async () => {
	const h = harness([asst(["late block"], T0)]);
	const fn = await h.load();
	// deliberately do NOT fire session_start; message_start gives us a ctx reference
	await h.fire("message_start", { type: "message_start", message: { role: "assistant", content: [], timestamp: T1 } });
	await h.fire("message_end", { type: "message_end", message: { role: "assistant", content: [], timestamp: T1 } });

	// a finalized block that is not in the map triggers a rebuild from latestCtx
	assert.equal(run(fn, "late block", "assistant", false).split("\n")[0], "`@ 14:22:07 ->`");
});

test("a throwing getBranch() must not corrupt output", async () => {
	const handlers = new Map();
	let transformer = null;
	const ctx = { sessionManager: { getBranch: () => { throw new Error("stale context"); } } };
	const pi = {
		on(e, h) {
			(handlers.get(e) ?? handlers.set(e, []).get(e)).push(h);
			return () => {};
		},
		registerMarkdownTransformer(fn) {
			transformer = fn;
		},
		registerToolRenderer() {},
	};
	const mod = await import(`${EXT}?case=${Math.random()}`);
	await mod.default(pi);

	await transformer("still intact", { messageType: "assistant", isStreaming: false, availableWidth: 80 });
	assert.equal(transformer("still intact", { messageType: "assistant", isStreaming: false, availableWidth: 80 }), "still intact");
});

test("multi-part assistant message stamps every text part with the same time", async () => {
	const h = harness([asst(["first para", "second para"], T0)]);
	const fn = await h.load();
	await h.fire("session_start", { type: "session_start" });

	assert.equal(run(fn, "first para", "assistant").split("\n")[0], "`@ 14:22:07 ->`");
	assert.equal(run(fn, "second para", "assistant").split("\n")[0], "`@ 14:22:07 ->`");
});

test("empty / whitespace blocks are returned untouched", async () => {
	const h = harness([asst(["x"], T0)]);
	const fn = await h.load();
	await h.fire("session_start", { type: "session_start" });

	assert.equal(run(fn, "", "assistant"), "");
	assert.equal(run(fn, "   \n  ", "assistant"), "   \n  ");
});

test("tool-call-only turns produce no stamp source (documented v1 gap)", async () => {
	const h = harness([toolOnly(T0)]);
	const fn = await h.load();
	await h.fire("session_start", { type: "session_start" });
	// The TUI never calls the transformer for a tool-only turn (no markdown component),
	// so nothing to stamp. Assert the fail-closed path is clean rather than throwing.
	assert.equal(run(fn, "unrelated text", "assistant"), "unrelated text");
});
