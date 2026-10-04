/**
 * Tests for phase 2: the clock stamp on tool/command blocks.
 *
 * Run: node --test --experimental-strip-types ".pi/tests/*.test.mjs"
 *
 * @earendil-works/pi-tui is not resolvable from this project, so it is mapped to a
 * local stub via module.registerHooks() before the extension is imported.
 */

import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import assert from "node:assert/strict";

const stubUrl = pathToFileURL(new URL("./pi-tui-stub.mjs", import.meta.url).pathname).href;

registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "@earendil-works/pi-tui") {
			return { url: stubUrl, format: "module", shortCircuit: true };
		}
		return next(specifier, context);
	},
});

const { Text, Container } = await import("@earendil-works/pi-tui");
const mod = await import("../extensions/output-timestamps.ts");

/* ------------------------------------------------------------------ *
 * Fakes                                                             *
 * ------------------------------------------------------------------ */

const START = new Date(2026, 9, 4, 14, 23, 45).getTime();
const LATER = new Date(2026, 9, 4, 14, 24, 30).getTime();

function pad2(n) {
	return String(n).padStart(2, "0");
}

/** Same rule as the extension: local wall clock, no invented timezone. */
function expectedClock(ms) {
	const d = new Date(ms);
	return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Same decoration as the extension: "@ HH:MM:SS ->". */
function expectedStamp(ms) {
	return `@ ${expectedClock(ms)} ->`;
}

const theme = { fg: (kind, text) => `<${kind}>${text}</${kind}>` };

/**
 * Mimics the built-in shell renderer: it reuses context.lastComponent and calls
 * setText() on it. It THROWS if it is ever handed something that is not its own
 * component, which is exactly the trap the extension must avoid.
 */
function makeBase(trace) {
	return {
		renderShell: "default",
		renderCall(args, _theme, ctx) {
			trace.calls += 1;
			trace.receivedLast.push(ctx.lastComponent);
			const component = ctx.lastComponent ?? new Text("", 0, 0);
			if (typeof component.setText !== "function") {
				throw new TypeError("base renderer was handed a non-Text component");
			}
			component.setText(`$ ${args.command}`);
			return component;
		},
		renderResult(_result, _options, _theme, _ctx) {
			return new Text("result-body", 0, 0);
		},
	};
}

function makeContext(overrides = {}) {
	return {
		args: { command: "echo hi" },
		toolCallId: "call-1",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: "/tmp",
		executionStarted: false,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		...overrides,
	};
}

function installClock(startValue) {
	const real = Date.now;
	let current = startValue;
	Date.now = () => current;
	return {
		set(value) {
			current = value;
		},
		restore() {
			Date.now = real;
		},
	};
}

async function load() {
	const registrations = { toolRenderer: undefined };
	const pi = {
		registerMarkdownTransformer() {},
		registerToolRenderer(resolver) {
			registrations.toolRenderer = resolver;
		},
		on() {},
	};
	await mod.default(pi);
	return registrations.toolRenderer;
}

/* ------------------------------------------------------------------ *
 * Tests                                                             *
 * ------------------------------------------------------------------ */

test("resolver registers", async () => {
	assert.equal(typeof await load(), "function");
});

test("no stamp before execution starts", async () => {
	const resolver = await load();
	const trace = { calls: 0, receivedLast: [] };
	const wrapped = resolver("bash", () => makeBase(trace));
	const ctx = makeContext({ executionStarted: false });

	const out = wrapped.renderCall(ctx.args, theme, ctx);

	assert.equal(trace.calls, 1, "base renderer still ran");
	assert.ok(!(out instanceof Container), "must not be wrapped");
	assert.equal(out.text, "$ echo hi");
});

test("stamps the start time on line 1 once execution starts", async () => {
	const clock = installClock(START);
	const resolver = await load();
	const trace = { calls: 0, receivedLast: [] };
	const wrapped = resolver("bash", () => makeBase(trace));
	const ctx = makeContext({ executionStarted: true });

	const out = wrapped.renderCall(ctx.args, theme, ctx);

	assert.ok(out instanceof Container, "expected a wrapper");
	assert.equal(out.children.length, 2);
	assert.equal(out.children[0].text, `<muted>${expectedStamp(START)}</muted>`);
	assert.equal(out.children[1].text, "$ echo hi");
	clock.restore();
});

test("start time is captured exactly once, not re-stamped per render", async () => {
	const clock = installClock(START);
	const resolver = await load();
	const trace = { calls: 0, receivedLast: [] };
	const wrapped = resolver("bash", () => makeBase(trace));
	const ctx = makeContext({ executionStarted: true });

	const first = wrapped.renderCall(ctx.args, theme, ctx);
	clock.set(LATER); // 45 seconds of real work elapse
	const second = wrapped.renderCall(ctx.args, theme, ctx);
	clock.restore();

	assert.equal(first.children[0].text, second.children[0].text, "stamp must not drift");
	assert.equal(second.children[0].text, `<muted>${expectedStamp(START)}</muted>`);
});

test("base renderer never receives the wrapper as lastComponent", async () => {
	const clock = installClock(START);
	const resolver = await load();
	const trace = { calls: 0, receivedLast: [] };
	const wrapped = resolver("bash", () => makeBase(trace));
	const ctx = makeContext({ executionStarted: true });

	// makeBase throws if it is handed anything without setText(), so a
	// Container leaking in would fail these renders outright.
	const first = wrapped.renderCall(ctx.args, theme, ctx);
	const second = wrapped.renderCall(ctx.args, theme, ctx);
	clock.restore();

	assert.equal(trace.receivedLast[0], undefined);
	assert.ok(trace.receivedLast[1]);
	assert.ok(!(trace.receivedLast[1] instanceof Container), "wrapper leaked into base renderer");
	assert.equal(trace.receivedLast[1], first.children[1], "base must get its OWN component back");
	assert.equal(trace.receivedLast[1], second.children[1], "and must keep reusing it");
});

test("tool call without a start time fails closed", async () => {
	const resolver = await load();
	const trace = { calls: 0, receivedLast: [] };
	const wrapped = resolver("bash", () => makeBase(trace));
	const ctx = makeContext({ executionStarted: false, state: undefined });

	const out = wrapped.renderCall(ctx.args, theme, ctx);

	assert.ok(!(out instanceof Container));
	assert.equal(out.text, "$ echo hi");
});

test("unknown tools are left to pi defaults", async () => {
	const resolver = await load();
	assert.equal(resolver("some_mcp_tool", () => undefined), undefined);
});

test("renderResult and renderShell pass through untouched", async () => {
	const resolver = await load();
	const trace = { calls: 0, receivedLast: [] };
	const base = makeBase(trace);
	const wrapped = resolver("bash", () => base);

	assert.equal(wrapped.renderShell, base.renderShell);
	assert.equal(wrapped.renderResult, base.renderResult);
});

test("stamping is pure across repeated renders of the same block", async () => {
	const clock = installClock(START);
	const resolver = await load();
	const trace = { calls: 0, receivedLast: [] };
	const wrapped = resolver("bash", () => makeBase(trace));
	const ctx = makeContext({ executionStarted: true });

	const render = () => wrapped.renderCall(ctx.args, theme, ctx).render(80).join("\n");
	const a = render();
	const b = render();
	clock.restore();

	assert.equal(a, b);
	assert.match(a, /14:23:45/);
});

test("interactive components are not wrapped", async () => {
	const clock = installClock(START);
	const resolver = await load();

	for (const kind of ["handleInput", "focused"]) {
		const trace = { calls: 0, receivedLast: [] };
		const base = makeBase(trace);
		const original = base.renderCall;
		base.renderCall = (args, t, ctx) => {
			const component = original(args, t, ctx);
			if (kind === "handleInput") component.handleInput = () => {};
			else component.focused = false;
			return component;
		};

		const wrapped = resolver("bash", () => base);
		const ctx = makeContext({ executionStarted: true });
		const out = wrapped.renderCall(ctx.args, theme, ctx);

		assert.ok(!(out instanceof Container), `${kind} component must not be wrapped`);
		assert.equal(out.text, "$ echo hi");
		// The base still got its own component back, not a wrapper.
		assert.ok(!(trace.receivedLast[1] instanceof Container));
	}
	clock.restore();
});

test("the interactive guard does not suppress ordinary blocks", async () => {
	const clock = installClock(START);
	const resolver = await load();
	const trace = { calls: 0, receivedLast: [] };
	const wrapped = resolver("bash", () => makeBase(trace));
	const ctx = makeContext({ executionStarted: true });

	const out = wrapped.renderCall(ctx.args, theme, ctx);
	clock.restore();

	assert.ok(out instanceof Container, "plain Text components must still be stamped");
});

test("CROSS-PATH: markdown and tool stamps are the same visible characters", async () => {
	const clock = installClock(START);
	const handlers = new Map();
	let transformer;
	let resolver;
	const pi = {
		registerMarkdownTransformer(fn) {
			transformer = fn;
		},
		registerToolRenderer(r) {
			resolver = r;
		},
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
	};
	await mod.default(pi);

	// Hydrate the markdown map from a branch entry.
	const BLOCK = "some assistant prose";
	const ctx = {
		sessionManager: {
			getBranch: () => [
				{
					type: "message",
					message: { role: "assistant", content: [{ type: "text", text: BLOCK }], timestamp: START },
				},
			],
		},
	};
	handlers.get("session_start")[0]({ type: "session_start" }, ctx);

	const stamped = transformer(BLOCK, { messageType: "assistant", isStreaming: false, availableWidth: 80 });
	const markdownLine = stamped.split("\n\n")[0];

	// Tool path with a theme that adds no markup, so this compares bare characters.
	const trace = { calls: 0, receivedLast: [] };
	const wrapped = resolver("bash", () => makeBase(trace));
	const toolCtx = makeContext({ executionStarted: true });
	const toolLine = wrapped.renderCall(toolCtx.args, {}, toolCtx).children[0].text;
	clock.restore();

	assert.equal(markdownLine, "`" + expectedStamp(START) + "`", "markdown keeps inline-code markup");
	assert.equal(toolLine, expectedStamp(START), "tool path is plain text");
	// The point of the test: identical once markup is removed.
	assert.equal(markdownLine.replace(/^`|`$/g, ""), toolLine);
});
