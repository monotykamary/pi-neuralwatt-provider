// Offline Pi 1.0 manifest, lifecycle, catalog and real transport regression.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = await mkdtemp(join(tmpdir(), 'pi-provider-compat-'));
const previousHome = process.env.PI_CODING_AGENT_DIR;
const previousFetch = globalThis.fetch;
process.env.PI_CODING_AGENT_DIR = home;
// Never allow a background catalog/account request to reach a real endpoint.
globalThis.fetch = async () => new Response('', { status: 503 });
let session;
try {
  const host = process.env.PI1_HOST_PACKAGE;
  const hostEntry = process.env.PI1_HOST_ENTRY === 'bundle' ? 'dist/bundle/index.js' : 'dist/index.js';
  const sdk = await import(host ? pathToFileURL(join(host, hostEntry)).href : '@earendil-works/pi-coding-agent');
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, VERSION } = sdk;
  assert.equal(VERSION, '1.0.0', 'executing host version');
  assert.equal((await import('@earendil-works/pi-coding-agent')).VERSION, '1.0.0', 'development host version');
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  for (const name of ['@earendil-works/pi-ai', '@earendil-works/pi-agent-core', '@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox']) {
    assert.equal(manifest.dependencies?.[name], undefined, `${name}: do not bundle host packages`);
    if (manifest.peerDependencies?.[name] !== undefined) assert.equal(manifest.peerDependencies[name], '*');
    if (name !== 'typebox' && manifest.devDependencies?.[name]) assert.equal(manifest.devDependencies[name], '1.0.0');
  }
  const settingsManager = SettingsManager.inMemory({ packages: [root], compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd: home, agentDir: home, settingsManager,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await resourceLoader.reload();
  const loaded = resourceLoader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.warnings ?? [], []);
  assert.equal(loaded.extensions.length, manifest.pi.extensions.length, 'all manifest entrypoints load');
  // Endpoint/header-only re-registration (e.g. MCR) retains the prior catalog.
  const registrations = [...loaded.runtime.pendingProviderRegistrations.reduce((byName, { name, config }) =>
    byName.set(name, { name, config: { ...byName.get(name)?.config, ...config } }), new Map()).values()];
  assert(registrations.length > 0, 'providers register before session startup');
  const modelRuntime = await ModelRuntime.create({ authPath: join(home, 'auth.json'), modelsPath: null, modelsStorePath: join(home, 'models-cache'), allowModelNetwork: false });
  ({ session } = await createAgentSession({ cwd: home, agentDir: home, resourceLoader, modelRuntime, settingsManager, sessionManager: SessionManager.inMemory(home) }));
  const errors = [];
  await session.bindExtensions({ mode: 'print', onError: error => errors.push(error) });
  await new Promise(done => setImmediate(done));
  const tools = new Set();
  for (const extension of loaded.extensions) for (const [name, { definition }] of extension.tools) {
    assert.equal(definition.name, name); assert.equal(typeof definition.execute, 'function');
    assert.equal(typeof definition.parameters, 'object'); assert(!tools.has(name)); tools.add(name);
    assert(session.getAllTools().some(tool => tool.name === name));
  }
  let modelCount = 0, streamChecks = 0;
  for (const { name, config } of registrations) {
    const models = modelRuntime.getAllModels(name);
    assert.equal(models.length, config.models.length, `${name}: catalog survives registration`);
    assert(models.length > 0);
    assert.equal(new Set(models.map(m => `${m.type}/${m.id}`)).size, models.length);
    for (const model of models) {
      assert.equal(model.provider, name); assert(model.api && model.baseUrl && model.id && model.name);
      if (model.type === 'image') assert(model.output.includes('image'));
      else assert(model.contextWindow > 0);
      if ((model.type ?? 'chat') === 'chat') assert(model.maxTokens > 0);
      assert(model.input.includes('text'));
      for (const cost of Object.values(model.cost)) assert(Number.isFinite(cost) && cost >= 0);
    }
    const chatModels = modelRuntime.getModels(name);
    const model = chatModels.find(m => m.api === 'openai-completions') ?? chatModels[0];
    assert(model, 'a chat model is available for offline transport checks');
    const user = { role: 'user', content: 'hello', timestamp: 1 };
    async function probe(tool = false, empty = false) {
      let payloadCalls = 0, responseCalls = 0, observed = 0, wire;
      const fetch = async (_url, init) => {
        wire = JSON.parse(init.body);
        const delta = tool ? { tool_calls: [{ index: 0, id: 'call_probe', type: 'function', function: { name: 'probe', arguments: '{"value":7}' } }] } : { content: empty ? '' : 'Hello 界' };
        const chunks = [{ id: 'offline', choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] }, { id: 'offline', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }];
        return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
      };
      const stream = modelRuntime.streamSimple(model, { messages: [{ role: 'system', content: 'Offline probe', toolsAdded: [{ name: 'probe', description: 'Probe', parameters: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'] } }], timestamp: 0 }, user] }, {
        apiKey: 'offline-placeholder', maxTokens: 32, maxRetries: 0, fetch,
        onPayload: p => { payloadCalls++; return { ...p, temperature: 0.123 }; },
        onResponse: () => { responseCalls++; }, onProviderStreamEvent: () => { observed++; },
      });
      const events = []; for await (const event of stream) events.push(event.type);
      const result = await stream.result();
      assert.equal(result.stopReason, tool ? 'toolUse' : 'stop', result.errorMessage);
      assert.equal(events.filter(e => e === 'start').length, 1);
      assert.equal(events.filter(e => e === 'done' || e === 'error').length, 1);
      assert.equal(events.at(-1), 'done');
      assert.equal(payloadCalls, 1); assert.equal(responseCalls, 1); assert(observed >= 2);
      assert.equal(wire.temperature, 0.123); assert.equal(wire.tools[0].function.name, 'probe');
      assert.equal(result.usage.totalTokens, 12);
      if (tool) assert.deepEqual(result.content.find(c => c.type === 'toolCall').arguments, { value: 7 });
      else if (!empty) assert.equal(result.content.find(c => c.type === 'text').text, 'Hello 界');
      streamChecks++;
    }
    await probe(); await probe(true); await probe(false, true);
    // Abort after preflight: the SDK's lazy preflight reports an already-aborted
    // auth operation as an error; this checks provider transport cancellation.
    const controller = new AbortController();
    const aborted = await modelRuntime.streamSimple(model, { messages: [user] }, {
      apiKey: 'offline-placeholder', signal: controller.signal, maxRetries: 0,
      onPayload: () => { controller.abort(); },
      fetch: async () => { throw new DOMException('Aborted', 'AbortError'); },
    }).result();
    assert.equal(aborted.stopReason, 'aborted', aborted.errorMessage); streamChecks++;
    modelCount += models.length;
  }
  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ repo: manifest.name, pi: VERSION, hostEntry, extensions: loaded.extensions.length, tools: tools.size, models: modelCount, streamChecks, lifecycle: 'passed' }));
} finally {
  session?.dispose(); globalThis.fetch = previousFetch;
  if (previousHome === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousHome;
  await rm(home, { recursive: true, force: true });
}
