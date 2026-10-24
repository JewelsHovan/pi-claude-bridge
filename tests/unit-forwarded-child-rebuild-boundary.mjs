import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import activate, { __test } from '../src/index.js';
import { resetCtx } from '../src/query-state.js';

// Compass #388: exercise the real capture handlers, mirror rebuild and SDK-query
// boundary. The SDK call is replaced before any Claude process or network request.
let registeredProvider;
for (const rewrite of ['session_compact', 'session_tree']) {
  test(`forwarded child preserves parent at fresh query after ${rewrite}`, () => {
    const handlers = new Map();
    let provider;
    activate({
      on: (name, handler) => {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
      registerProvider: (_name, config) => { provider = config; registeredProvider = config; },
      registerTool: () => {},
    });
    provider ??= registeredProvider;
    const emit = (name, event, ctx) => {
      for (const handler of handlers.get(name) ?? []) handler(event, ctx);
    };
    const token = randomUUID();
    const piSessionId = `compass-parent-${token}`;
    const parentPrompt = `parent-key-${token}`;
    const childPrompt = `child-key-${token}`;
    const parentOptions = {
      customPrompt: `parent-identity-${token}`,
      appendSystemPrompt: `parent-instructions-${token}`,
      contextFiles: [{ path: `/parent-${token}/AGENTS.md`, content: `parent-rules-${token}` }],
      skills: [], selectedTools: [],
    };
    const childOptions = { ...parentOptions, customPrompt: `child-identity-${token}`, appendSystemPrompt: `child-instructions-${token}`, contextFiles: [] };
    const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => piSessionId }, getSystemPrompt: () => parentPrompt };
    const oldSession = randomUUID();
    __test.resetSharedSession();
    __test.activeQueryContexts.clear();
    resetCtx();
    try {
      emit('before_agent_start', { systemPrompt: parentPrompt, systemPromptOptions: parentOptions }, ctx);
      emit('agent_start', {}, ctx);
      emit('before_agent_start', { systemPrompt: childPrompt, systemPromptOptions: childOptions, origin: { kind: 'subagent', agentId: `child-${token}` } }, { ...ctx, getSystemPrompt: () => childPrompt });
      emit('turn_start', {}, ctx);
      __test.setSharedSession(piSessionId, { sessionId: oldSession, cursor: 2, cwd: process.cwd(), piSessionId, needsRebuild: false });
      emit(rewrite, { reason: 'manual', willRetry: false }, ctx);
      assert.equal(__test.getSharedSession(piSessionId).needsRebuild, true);
      const model = provider.models[0];
      let sdkOptions;
      __test.setQuery(({ options }) => {
        sdkOptions = options;
        throw new Error('offline-sdk-query-boundary');
      });
      const messages = [
        { role: 'user', content: 'retained summary', timestamp: 1 },
        { role: 'assistant', content: [{ type: 'text', text: 'completed reply' }], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: 2, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
        { role: 'user', content: 'continue', timestamp: 3 },
      ];
      assert.throws(() => provider.streamSimple(model, { systemPrompt: parentPrompt, messages, tools: [] }, { sessionId: piSessionId }), /offline-sdk-query-boundary/);
      assert.ok(sdkOptions, 'reached actual SDK-query boundary');
      const append = sdkOptions.systemPrompt.append;
      assert.ok(append.includes(parentOptions.customPrompt), 'fresh query keeps parent persona');
      assert.ok(append.includes(parentOptions.appendSystemPrompt), 'fresh query keeps parent append');
      assert.ok(append.includes(parentOptions.contextFiles[0].content), 'fresh query keeps parent project rules');
      assert.ok(!append.includes(childOptions.customPrompt), 'fresh query excludes child persona');
      assert.equal(sdkOptions.resume, oldSession);
      assert.equal(sdkOptions.tools.length, 0, 'Compass retains tool execution ownership');
      const rebuilt = __test.getSharedSession(piSessionId);
      assert.equal(rebuilt.needsRebuild, undefined);
      assert.equal(rebuilt.cursor, 2);
      assert.equal(__test.historyRewrittenBySession.has(piSessionId), false, 'rewrite consumed by real rebuild');
      assert.equal(__test.promptCaptures.resolveOrDerive(childPrompt).custom, childOptions.customPrompt);
    } finally {
      __test.setQuery(null);
      __test.resetSharedSession();
      __test.activeQueryContexts.clear();
      resetCtx();
    }
  });
}
