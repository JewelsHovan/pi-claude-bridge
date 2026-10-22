#!/usr/bin/env node

/**
 * A forwarding host sends child before_agent_start through the parent's handlers.
 * The hook context still has the parent's session manager, but getSystemPrompt()
 * returns the child's prompt and event.origin identifies the child. Child
 * agent_start/turn_start are not forwarded. Only the parent's own before hook
 * may supply the options reused at its later start/turn boundaries.
 *
 * Exercise real extension handlers and the shared capture/projection registry;
 * no provider stream or SDK query is started.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { __test } from "../src/index.js";
import { projectPromptCapture } from "../src/prompt-capture.js";
import { activateWithMockPi } from "./lib/mock-pi.mjs";

function fixture(name) {
	const options = (role) => ({
		customPrompt: `${name}: ${role} identity`,
		appendSystemPrompt: `${name}: ${role} appended instructions`,
		contextFiles: [{ path: `/${name}/${role}/AGENTS.md`, content: `${name}: ${role} project rules` }],
		skills: [{
			name: `${role}-skill`,
			description: `${name}: ${role} skill description`,
			filePath: `/${name}/${role}/SKILL.md`,
			baseDir: `/${name}/${role}`,
			sourceInfo: { source: "test", scope: "temporary", origin: "top-level" },
			disableModelInvocation: false,
		}],
		sections: { host_rules: `${name}: ${role} section rules` },
		selectedTools: ["read"],
	});
	// Unique keys per case: the process-wide registry deliberately survives a
	// new activation. Neither key embeds the other, so resolution must be exact.
	const parentPrompt = `[forwarded-capture:${name}:parent]`;
	const childPrompt = `[forwarded-capture:${name}:child]`;
	const parentOptions = options("parent");
	const childOptions = options("child");
	const sessionManager = { getSessionId: () => `${name}-parent-session` };
	const parentCtx = { sessionManager, getSystemPrompt: () => parentPrompt };
	const childCtx = { ...parentCtx, getSystemPrompt: () => childPrompt };
	return {
		parentPrompt, childPrompt, parentOptions, childOptions, parentCtx, childCtx,
		parentEvent: { systemPrompt: parentPrompt, systemPromptOptions: parentOptions },
		childEvent: {
			systemPrompt: childPrompt,
			systemPromptOptions: childOptions,
			origin: { kind: "subagent", agentId: `${name}-child-provider-session` },
		},
	};
}

function assertPortable(prompt, options) {
	const capture = __test.promptCaptures.resolveOrDerive(prompt);
	assert.ok(capture, "the exact prompt must resolve");
	assert.equal(capture.assembledPrompt, prompt);
	assert.equal(capture.inherited.length, 0, "no embedded-prompt fallback is involved");
	assert.equal(capture.custom, options.customPrompt);
	assert.equal(capture.append, options.appendSystemPrompt);
	assert.deepEqual(capture.contextFiles, options.contextFiles);
	assert.deepEqual(capture.skills, options.skills);
	assert.deepEqual(capture.sections, options.sections);
	const projected = projectPromptCapture(capture, { skillReadTool: "mcp" });
	for (const text of [
		options.customPrompt, options.appendSystemPrompt,
		options.contextFiles[0].path, options.contextFiles[0].content,
		options.skills[0].filePath, options.skills[0].description,
		`<host_rules>\n${options.sections.host_rules}\n</host_rules>`,
	]) {
		assert.ok(projected.includes(text), `projection must retain ${text}`);
	}
	return projected;
}

describe("forwarded child prompt capture", () => {
	it("records the child without replacing the parent's stashed portable parts", () => {
		const f = fixture("interleaved");
		const handlers = activateWithMockPi();
		handlers.get("before_agent_start")(f.parentEvent, f.parentCtx);
		handlers.get("agent_start")({}, f.parentCtx);
		const parentProjection = assertPortable(f.parentPrompt, f.parentOptions);

		assert.equal(f.childCtx.sessionManager, f.parentCtx.sessionManager);
		assert.notEqual(f.childEvent.origin.agentId, f.childCtx.sessionManager.getSessionId());
		assert.equal(f.childCtx.getSystemPrompt(), f.childPrompt);
		handlers.get("before_agent_start")(f.childEvent, f.childCtx);
		const childProjection = assertPortable(f.childPrompt, f.childOptions);

		// Only parent boundaries return to this closure after the child hook.
		for (const boundary of ["turn_start", "agent_start"]) {
			handlers.get(boundary)({}, f.parentCtx);
			assert.equal(assertPortable(f.parentPrompt, f.parentOptions), parentProjection);
			assert.equal(assertPortable(f.childPrompt, f.childOptions), childProjection);
		}
	});

	it("retains parent options after a compact notification and continuation without a new parent before hook", () => {
		const f = fixture("compact-continuation");
		const handlers = activateWithMockPi();
		handlers.get("before_agent_start")(f.parentEvent, f.parentCtx);
		handlers.get("agent_start")({}, f.parentCtx);
		handlers.get("turn_start")({}, f.parentCtx);
		const parentProjection = assertPortable(f.parentPrompt, f.parentOptions);
		handlers.get("before_agent_start")(f.childEvent, f.childCtx);
		const childProjection = assertPortable(f.childPrompt, f.childOptions);

		// This observes a completed rewrite only; it does not run a summarizer or
		// a provider. Resolving anew models the fresh query's capture lookup.
		handlers.get("session_compact")({ reason: "manual", willRetry: false }, f.parentCtx);
		handlers.get("turn_start")({}, f.parentCtx);
		handlers.get("agent_start")({}, f.parentCtx);
		assert.equal(assertPortable(f.parentPrompt, f.parentOptions), parentProjection);
		assert.equal(assertPortable(f.childPrompt, f.childOptions), childProjection);
	});

	// Upstream's event type has no origin field. A host may add unrelated
	// provenance to its own turns; only kind: "subagent" means forwarding here.
	for (const [name, originFields] of [
		["no-origin", {}],
		["null-origin", { origin: null }],
		["unrelated-origin", { origin: { kind: "user", agentId: "host-own-turn" } }],
		["opaque-origin", { origin: { requestId: "host-request" } }],
		["string-origin", { origin: "host-own-turn" }],
	]) {
		it(`${name}: stashes own-agent options and still widens its key`, () => {
			const f = fixture(name);
			const handlers = activateWithMockPi();
			handlers.get("before_agent_start")(f.childEvent, f.childCtx);
			handlers.get("before_agent_start")({ ...f.parentEvent, ...originFields }, f.parentCtx);
			const widened = `${f.parentPrompt}\nLate tool description`;
			handlers.get("agent_start")({}, { ...f.parentCtx, getSystemPrompt: () => widened });
			assertPortable(widened, f.parentOptions);
			assertPortable(f.childPrompt, f.childOptions);
		});
	}
});

describe("capture boundaries before this closure has own-agent options", () => {
	for (const boundary of ["agent_start", "turn_start"]) {
		for (const childFirst of [false, true]) {
			const suffix = `${boundary}-${childFirst ? "child-first" : "no-before"}`;

			it(`${suffix}: leaves an unknown parent unrecorded and fails closed`, () => {
				const f = fixture(`unknown-${suffix}`);
				const handlers = activateWithMockPi();
				if (childFirst) handlers.get("before_agent_start")(f.childEvent, f.childCtx);
				const size = __test.promptCaptures.size;
				handlers.get(boundary)({}, f.parentCtx);

				assert.equal(__test.promptCaptures.resolve(f.parentPrompt), undefined,
					"a cold boundary must not invent an empty or child-owned parent capture");
				assert.equal(__test.promptCaptures.size, size);
				assert.throws(() => __test.promptCaptures.resolveOrDerive(f.parentPrompt), /no capture/);
				if (childFirst) assertPortable(f.childPrompt, f.childOptions);
			});

			it(`${suffix}: preserves a valid capture from an earlier activation`, () => {
				const f = fixture(`known-${suffix}`);
				const first = activateWithMockPi();
				first.get("before_agent_start")(f.parentEvent, f.parentCtx);
				first.get("turn_start")({}, f.parentCtx);
				const known = __test.promptCaptures.resolve(f.parentPrompt);
				const parentProjection = assertPortable(f.parentPrompt, f.parentOptions);

				// A new factory closure, but the same real shared capture registry.
				// The seeded capture is valid, not already poisoned state to repair.
				const fresh = activateWithMockPi();
				if (childFirst) fresh.get("before_agent_start")(f.childEvent, f.childCtx);
				fresh.get(boundary)({}, f.parentCtx);

				assert.equal(__test.promptCaptures.resolve(f.parentPrompt), known);
				assert.equal(known.source, "turn_start", "a cold closure must not overwrite provenance");
				assert.equal(assertPortable(f.parentPrompt, f.parentOptions), parentProjection);
				if (childFirst) assertPortable(f.childPrompt, f.childOptions);
			});
		}
	}
});
