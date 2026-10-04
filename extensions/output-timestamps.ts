/**
 * output-timestamps.ts -- project-scoped Pi extension.
 *
 * Prepends the time a block started appearing to assistant output blocks in the
 * interactive transcript, so a block on screen can be dated at a glance.
 *
 * Mechanism: pi.registerMarkdownTransformer() is display-only. It receives the
 * exact string the TUI renders (AssistantMessageComponent passes content.text.trim()),
 * but no message id. So times are addressed BY CONTENT, not by call order:
 *
 *   Map<trimmed block text, epoch ms>
 *
 * This keeps the transformer pure -- identical input always yields identical output --
 * which is what makes it survive terminal resizes (transform re-runs for every block
 * when width changes), fork / branch switches, and session resume.
 *
 * Fail-closed: if no time is known for a block, the block is returned untouched.
 * A missing stamp is honest; a fabricated one is worse than none.
 *
 * Phase 2 adds the same stamp to tool/command blocks. Those never pass through the
 * markdown transformer, so they are wrapped with pi.registerToolRenderer() instead.
 *
 * Revert: delete this file (or run /reload after deleting).
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ToolRenderers,
} from "@earendil-works/pi-coding-agent";
/* pi-tui is imported lazily, only if this Pi build has registerToolRenderer, so that
   installs predating 1.0.1 keep the prose stamps instead of failing the whole file.
   Tests substitute a stub via module.registerHooks(). */
interface StampUi {
	Container: new () => { addChild: (component: unknown) => void };
	Text: new (text: string, paddingX: number, paddingY: number) => unknown;
}

let ui: StampUi | undefined;

/* Minimal structural views for the session entries we read. */
interface PartLike {
	type?: string;
	text?: string;
}
interface MessageLike {
	role?: string;
	content?: unknown;
	timestamp?: number;
}
interface EntryLike {
	type?: string;
	message?: MessageLike;
}

/** Only assistant blocks are stamped; user messages and thinking stay clean. */
const STAMP_ROLE = "assistant";

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

function formatClock(ms: number): string {
	if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
	const d = new Date(ms);
	const t = d.getTime();
	if (!Number.isFinite(t)) return "";
	return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * The visible stamp text, e.g. "@ 12:34:33 ->".
 *
 * Both renderers share this so a block reads identically wherever it appears.
 * Only the markup differs: the markdown path wraps it in inline code for color,
 * the tool path is a plain Text component and gets color from the theme instead.
 */
function stampText(ms: number | undefined): string {
	if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
	const clock = formatClock(ms);
	return clock ? `@ ${clock} ->` : "";
}

/**
 * Keys for a message: the trimmed text of every text part.
 * Matches exactly what the TUI hands the markdown transformer.
 */
function blockKeys(message: MessageLike | undefined): string[] {
	if (!message || message.role !== STAMP_ROLE) return [];
	const content = message.content;
	if (typeof content === "string") {
		const key = content.trim();
		return key ? [key] : [];
	}
	if (!Array.isArray(content)) return [];
	const keys: string[] = [];
	for (const part of content as PartLike[]) {
		if (part && part.type === "text" && typeof part.text === "string") {
			const key = part.text.trim();
			if (key) keys.push(key);
		}
	}
	return keys;
}

function messageTime(message: MessageLike | undefined): number | undefined {
	const ms = message?.timestamp;
	return typeof ms === "number" && Number.isFinite(ms) ? ms : undefined;
}

/* ------------------------------------------------------------------ *
 * Phase 2: tool / command blocks                                      *
 * ------------------------------------------------------------------ */

/** Namespaced so we never collide with keys the tool's own renderer stores. */
const START_KEY = "__blockStampStartMs";
const INNER_KEY = "__blockStampInner";

type RenderCall = NonNullable<ToolRenderers["renderCall"]>;
type RenderArgs = Parameters<RenderCall>[0];
type RenderTheme = Parameters<RenderCall>[1];
type RenderContext = Parameters<RenderCall>[2];

/** Muted clock label, degrading to plain text if the theme cannot style it. */
function clockLabel(ms: number | undefined, theme: RenderTheme | undefined): string {
	if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
	const stamp = stampText(ms);
	if (!stamp) return "";
	try {
		const fg = (theme as { fg?: (key: string, text: string) => string } | undefined)?.fg;
		return typeof fg === "function" ? fg("muted", stamp) : stamp;
	} catch {
		return stamp;
	}
}

/**
 * Whether wrapping this component would break it.
 *
 * Container has no handleInput and no `focused` property, so a component that takes
 * keyboard focus (an interactive or MCP tool renderer) would stop receiving keys once
 * wrapped. Such blocks are left unstamped rather than damaged.
 */
function isUnsafeToWrap(component: unknown): boolean {
	if (!component || typeof component !== "object") return true;
	const candidate = component as { handleInput?: unknown; focused?: unknown };
	return typeof candidate.handleInput === "function" || "focused" in candidate;
}

/**
 * The moment this tool call began, captured exactly once.
 * Returns undefined before execution starts, so the caller stamps nothing.
 */
function startOfExecution(context: RenderContext | undefined, now: () => number): number | undefined {
	const state = context?.state as Record<string, unknown> | undefined;
	if (!state || typeof state !== "object") return undefined;
	const previous = state[START_KEY];
	if (typeof previous === "number") return previous;
	if (!context?.executionStarted) return undefined;
	const start = now();
	if (typeof start !== "number" || !Number.isFinite(start)) return undefined;
	state[START_KEY] = start;
	return start;
}

/** Opt-in diagnostics: run `STAMP_DEBUG=1 pi` to see which halves registered. */
function debugLine(message: string): void {
	try {
		if (typeof process !== "undefined" && process.env?.STAMP_DEBUG) {
			console.error(`[output-timestamps] ${message}`);
		}
	} catch {
		// Diagnostics must never be able to break loading.
	}
}

export default async function (pi: ExtensionAPI) {
	/** trimmed block text -> epoch ms the block began */
	const times = new Map<string, number>();

	/** In-flight assistant message start, used while its text is still streaming. */
	let liveStart: number | undefined;

	/** True once we have loaded times for the currently rendered branch. */
	let hydrated = false;

	/**
	 * Most recent context handed to an event handler. Used only for lazy hydration
	 * after /reload, which may not re-fire session_start. Overwritten on every event
	 * so a session replacement leaves us holding the newest context, never a stale one.
	 */
	let latestCtx: ExtensionContext | undefined;

	function indexMessage(message: MessageLike | undefined): void {
		const ms = messageTime(message);
		if (ms === undefined) return;
		for (const key of blockKeys(message)) times.set(key, ms);
	}

	function rebuild(ctx: ExtensionContext | undefined): void {
		if (!ctx?.sessionManager) return;
		try {
			const entries = ctx.sessionManager.getBranch() as unknown as EntryLike[];
			if (!Array.isArray(entries)) return;
			const next = new Map<string, number>();
			for (const entry of entries) {
				if (!entry || entry.type !== "message") continue;
				const ms = messageTime(entry.message);
				if (ms === undefined) continue;
				for (const key of blockKeys(entry.message)) next.set(key, ms);
			}
			// Swap only on success: a throw above leaves the previous map intact.
			times.clear();
			for (const [key, ms] of next) times.set(key, ms);
			hydrated = true;
		} catch {
			// Fail closed -- keep what we have; un-stamped blocks beat wrong ones.
		}
	}

	/** Wrap a handler so we always track the freshest context. */
	function withCtx<T>(handler: (event: T, ctx: ExtensionContext) => void) {
		return async (event: T, ctx: ExtensionContext) => {
			latestCtx = ctx;
			handler(event, ctx);
		};
	}

	pi.on("session_start", withCtx<{ type: string }>((_event, ctx) => {
		times.clear();
		liveStart = undefined;
		hydrated = false;
		rebuild(ctx);
	}));

	// Branch changed (fork, tree navigation): the rendered set is different, so the
	// content-addressed map must be rebuilt from the new active branch.
	pi.on("session_tree", withCtx<{ type: string }>((_event, ctx) => {
		times.clear();
		liveStart = undefined;
		hydrated = false;
		rebuild(ctx);
	}));

	pi.on("session_compact", withCtx<{ type: string }>((_event, ctx) => {
		hydrated = false;
		rebuild(ctx);
	}));

	pi.on("message_start", withCtx<{ message?: MessageLike }>((event, _ctx) => {
		if (event?.message?.role === STAMP_ROLE) {
			liveStart = messageTime(event.message) ?? Date.now();
		}
	}));

	pi.on("message_end", withCtx<{ message?: MessageLike }>((event, ctx) => {
		latestCtx = ctx;
		indexMessage(event?.message);
		if (event?.message?.role === STAMP_ROLE) liveStart = undefined;
	}));

	// Prose stamps need Pi >= 0.84.0. Registered conditionally so a build without
	// the hook loads instead of throwing.
	if (typeof (pi as Record<string, unknown>).registerMarkdownTransformer === "function") {
		pi.registerMarkdownTransformer((markdown, info) => {
			try {
				if (info.messageType !== "assistant") return markdown;
				if (typeof markdown !== "string" || markdown.trim() === "") return markdown;

				// Lazy hydration covers /reload when no session_start re-fired.
				if (!hydrated && !info.isStreaming) {
					rebuild(latestCtx);
				}

				const ms = times.get(markdown) ?? (info.isStreaming ? liveStart : undefined);
				if (ms === undefined) return markdown;

				const stamp = stampText(ms);
				if (!stamp) return markdown;

				// Inline code gives the stamp its own color without needing theme access.
				// Checked against the real pi-tui Markdown component: '@' and '->' are inert
				// in marked, so the decoration renders literally rather than being parsed.
				return `\`${stamp}\`\n\n${markdown}`;
			} catch {
				// Never let a stamp bug blank or corrupt the block.
				return markdown;
			}
		});
		debugLine("prose stamps: on");
	} else {
		debugLine("prose stamps: off (registerMarkdownTransformer missing; needs Pi >= 0.84.0)");
	}

	/**
	 * Stamp tool/command blocks.
	 *
	 * ToolExecutionComponent hands each renderer its own previous return value back as
	 * context.lastComponent, and the built-in shell renderer calls setText() on it. So the
	 * wrapped renderer must never see our wrapper: it gets a proxied context whose
	 * lastComponent is the component IT returned last, cached in context.state (shared per
	 * tool row across the call and result renders). Without this, wrapping degrades every
	 * tool block to Pi's fallback rendering.
	 */
	// Command-block stamps need Pi >= 1.0.1 for registerToolRenderer, plus pi-tui
	// for the wrapper components. Both are resolved lazily so an install that predates
	// 1.0.1 keeps its prose stamps instead of failing to load the whole file.
	if (typeof (pi as Record<string, unknown>).registerToolRenderer === "function") {
		try {
			ui = (await import("@earendil-works/pi-tui")) as unknown as StampUi;
			pi.registerToolRenderer((_toolName, next) => {
				let base: ToolRenderers | undefined;
				try {
					base = next();
				} catch {
					return undefined;
				}
				const baseRenderCall = base?.renderCall;
				if (!base || typeof baseRenderCall !== "function") return undefined;

				const renderCall = (args: RenderArgs, theme: RenderTheme, context: RenderContext) => {
					const start = startOfExecution(context, () => Date.now());
					const state = context?.state as Record<string, unknown> | undefined;
					const innerLast = state?.[INNER_KEY] as ReturnType<RenderCall> | undefined;
					const proxied = context ? ({ ...context, lastComponent: innerLast } as RenderContext) : context;

					const inner = baseRenderCall(args, theme, proxied);
					if (state && typeof state === "object") state[INNER_KEY] = inner;

					const label = clockLabel(start, theme);
					// Fail closed: no known start, or the component cannot survive being wrapped.
					if (!label || isUnsafeToWrap(inner)) return inner;
					// Already stamped by another copy of this extension.
					if ((inner as { stampedShell?: boolean }).stampedShell === true) return inner;

					const shell = new ui!.Container();
					// Tag our own wrapper so a second loaded copy of this extension does not
					// wrap it again and print two identical stamp lines.
					(shell as { stampedShell?: boolean }).stampedShell = true;
					shell.addChild(new ui!.Text(label, 0, 0));
					shell.addChild(inner);
					return shell;
				};

				// Spread so renderResult and renderShell keep whatever the base provided.
				return { ...base, renderCall };
			});
			debugLine("command stamps: on");
		} catch (error) {
			// Fail closed rather than break loading, but never silently: a swallowed
			// catch is invisible on someone else's machine unless we say something.
			debugLine(`command stamps: off (${String(error)})`);
		}
	} else {
		debugLine("command stamps: off (registerToolRenderer missing; needs Pi >= 1.0.1)");
	}
}
