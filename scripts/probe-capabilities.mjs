// Explicitly opt-in, billable smoke test. Never prints credentials or full payloads.
// NEURALWATT_API_KEY="$(localterm secret get neuralwatt_api_key)" node scripts/probe-capabilities.mjs
// --extended also tests small chat, speed, flex Responses, and image-history requests.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const only = process.argv.find(arg => arg.startsWith('--only='))?.slice(7)?.split(',');
const run = name => !only || only.includes(name);
const key = process.env.NEURALWATT_API_KEY;
if (!key) throw new Error('Set NEURALWATT_API_KEY to run this billable probe.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = await mkdtemp(join(tmpdir(), 'neuralwatt-capabilities-'));
const previousHome = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = home;
const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'X-NW-Tools-Opt-Out': 'true' };
try {
  const { DefaultResourceLoader, ModelRuntime, SettingsManager } = await import('@earendil-works/pi-coding-agent');
  const settingsManager = SettingsManager.inMemory({ packages: [root] });
  const loader = new DefaultResourceLoader({ cwd: home, agentDir: home, settingsManager,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const runtime = await ModelRuntime.create({ authPath: join(home, 'auth.json'), modelsPath: null,
    modelsStorePath: join(home, 'models-cache'), allowModelNetwork: false });
  const registrations = loaded.runtime.pendingProviderRegistrations.reduce((byName, { name, config }) =>
    byName.set(name, { ...byName.get(name), ...config }), new Map());
  for (const [name, config] of registrations) runtime.registerProvider(name, config);
  const catalogResponse = await fetch('https://api.neuralwatt.com/v1/models', { headers, signal: AbortSignal.timeout(15000) });
  assert.equal(catalogResponse.status, 200, 'authenticated model discovery');
  const catalog = (await catalogResponse.json()).data;
  const available = new Set(catalog.map(m => m.id));
  const decisions = runtime.getModelsOfType('classifier', 'neuralwatt').filter(m => available.has(m.id));
  assert(decisions.some(m => m.id === 'clef-flash'), 'Clef access and classifier registration');
  for (const model of run('classifier') ? decisions : []) {
    assert(!runtime.getModels('neuralwatt').some(m => m.id === model.id));
    const result = await runtime.classify(model, { state: { message: 'The fix works perfectly, thank you!' }, questions: {
      sentiment: { type: 'choice', instructions: 'Classify the sentiment.', criteria: { positive: 'Happy', negative: 'Unhappy', neutral: 'Neither' } },
      approved: { type: 'bool', instructions: 'Does the user approve?', criteria: { true: 'Yes', false: 'No' } },
      urgency: { type: 'score', instructions: 'How urgent is further action?', criteria: ['None', 'Can wait', 'Immediate'] },
    } }, { apiKey: key, maxRetries: 0, timeoutMs: 30000 });
    assert.equal(result.stopReason, 'stop', result.errorMessage ?? 'Classifier did not finish successfully');
    assert.equal(result.answers.sentiment.type, 'choice');
    assert.equal(result.answers.approved.type, 'bool');
    assert.equal(result.answers.urgency.type, 'score');
    assert(result.usage?.input > 0);
    console.log(JSON.stringify({ probe: 'pi-runtime-classifier', model: model.id, answers: result.answers, usage: result.usage }));
  }
  const hosted = catalog.filter(m => m.metadata?.capabilities?.hosted_tools).map(m => m.id);
  if (run('hosted')) console.log(JSON.stringify({ probe: 'hosted-tools-eligibility', models: hosted,
    note: hosted.length ? 'Eligible; hosted tool execution is opt-in.' : 'Not enabled for this key; hosted execution not tested. No account settings changed.' }));

  if (process.argv.includes('--extended') || only) {
    if (run('chat')) {
      const model = runtime.getModelOfType('chat', 'neuralwatt', 'kimi-k2.7-code-fast');
      assert(model);
      const result = await runtime.completeSimple({ ...model, samplingParams: { top_k: 20, repetition_penalty: 1.05, seed: 42,
        response_format: { type: 'json_object' } } }, { messages: [{ role: 'user', content: 'Return JSON with ok equal to true.', timestamp: Date.now() }] },
      { apiKey: key, maxTokens: 256, maxRetries: 0, signal: AbortSignal.timeout(45000), headers });
      assert.equal(result.stopReason, 'stop', result.errorMessage ?? JSON.stringify({ stopReason: result.stopReason, content: result.content }));
      const text = result.content.filter(b => b.type === 'text').map(b => b.text).join('');
      assert.equal(JSON.parse(text).ok, true);
      console.log(JSON.stringify({ probe: 'pi-runtime-chat-sampling-json', model: model.id, tokens: result.usage.totalTokens }));
    }

    async function post(label, endpoint, body, expected = 200) {
      const response = await fetch(`https://api.neuralwatt.com/v1/${endpoint}`, { method: 'POST', headers,
        body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
      const data = await response.json();
      assert.equal(response.status, expected, `${label}: ${JSON.stringify(data).replaceAll(key, '[redacted]').slice(0, 500)}`);
      console.log(JSON.stringify({ probe: label, status: response.status, tier: response.headers.get('x-nw-service-tier') ?? data.service_tier,
        usage: data.usage, ...(response.ok ? {} : { detail: data.detail ?? data.error }) }));
      return data;
    }
    if (run('speed')) await post('speed-lane', 'chat/completions', { model: 'deepseek-v4.1-flash-speed', messages: [{ role: 'user', content: 'Reply OK.' }], reasoning_effort: 'none', max_completion_tokens: 16 });
    if (run('responses')) await post('flex-responses', 'responses', { model: 'deepseek-v4-flash-flex', input: 'Reply OK.', reasoning: { effort: 'none' }, max_output_tokens: 16, store: false });
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=' } };
    const history = [{ role: 'user', content: Array(20).fill(image) }, { role: 'assistant', content: 'Images received.' },
      { role: 'user', content: [{ type: 'text', text: 'Reply OK.' }, image] }];
    if (run('images')) await post('image-history-21-total-1-current', 'chat/completions', { model: 'kimi-k2.7-code-fast', messages: history, max_completion_tokens: 16 });
  }
} catch (error) {
  console.error(String(error?.message ?? error).replaceAll(key, '[redacted]'));
  process.exitCode = 1;
} finally {
  if (previousHome === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousHome;
  await rm(home, { recursive: true, force: true });
}
