import { describe, expect, it, beforeEach } from "vitest";
import { readEnergyFromTee, resetSessionState, getPendingState, consumePendingMCR, publishMCRRidge } from "../index";

function makeStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull(controller) {
      if (chunks.length === 0) {
        controller.close();
      } else {
        controller.enqueue(chunks.shift()!);
      }
    },
  });
}

/** Simulates network-interleaved SSE chunks with async delays between them. */
function makeDelayedStream(
  chunks: Array<{ data: Uint8Array; delayMs?: number }>,
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    async pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      const { data, delayMs = 0 } = chunks[index++];
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
      controller.enqueue(data);
    },
  });
}

function str(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("readEnergyFromTee", () => {
  beforeEach(() => {
    resetSessionState();
  });

  it("parses energy and cost from delayed SSE comment", async () => {
    const chunks = [
      str('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'),
      str(': energy {"energy_joules":99.5,"duration_seconds":0.5}\n'),
      str(': cost {"request_cost_usd":0.000123}\n'),
    ];

    const body = makeStream(chunks);
    const promise = readEnergyFromTee(body);

    // Energy comment is delayed; state must not be committed yet
    expect(getPendingState().pendingEnergyJoules).toBe(0);
    expect(getPendingState().pendingCostUsd).toBe(0);

    // After awaiting the reader the comment has been parsed
    await promise;

    const state = getPendingState();
    expect(state.pendingEnergyJoules).toBe(99.5);
    expect(state.pendingCostUsd).toBe(0.000123);
    expect(state.pendingDetail.duration_seconds).toBe(0.5);
  });

  it("handles multiple energy comments (accumulates)", async () => {
    const chunks = [
      str(': energy {"energy_joules":10}\n'),
      str(': energy {"energy_joules":20}\n'),
      str(': cost {"request_cost_usd":0.001}\n'),
    ];

    const body = makeStream(chunks);
    await readEnergyFromTee(body);

    const state = getPendingState();
    expect(state.pendingEnergyJoules).toBe(30);
    expect(state.pendingCostUsd).toBe(0.001);
  });

  it("flushes trailing bytes without trailing newline", async () => {
    const chunks = [
      str('data: {"choices":[]}\n\n'),
      // final energy line has no trailing newline — must still be parsed
      str(': energy {"energy_joules":42.0}'),
    ];

    const body = makeStream(chunks);
    await readEnergyFromTee(body);

    const state = getPendingState();
    expect(state.pendingEnergyJoules).toBe(42.0);
  });

  it("ignores malformed comments", async () => {
    const chunks = [
      str('data: good\n\n'),
      str(': energy this-is-not-json\n'),
      str(': energy {"energy_joules":55}\n'),
      str(': cost also-not-json\n'),
    ];

    const body = makeStream(chunks);
    await readEnergyFromTee(body);

    const state = getPendingState();
    expect(state.pendingEnergyJoules).toBe(55);
    expect(state.pendingCostUsd).toBe(0);
  });

  it("gives back a pending state like real-world: energy arrives *after* a large chunk", async () => {
    // Simulate the real bug: a large response token chunk is yielded first,
    // then after a micro-delay the energy comment arrives. Before the fix,
    // turn_end would check pendingEnergyJoules before the reader had a chance
    // to read the second chunk.
    const bigChunk = str('data: {"choices":[{"delta":{"content":"' + "x".repeat(5000) + '"}}]}\n\n');
    const energyChunk = str(': energy {"energy_joules":12345.6,"attribution_ratio":0.07}\n');

    const body = makeStream([bigChunk, energyChunk]);
    const promise = readEnergyFromTee(body);

    // pull() is synchronous but reader.read() is async — the first read
    // pulls bigChunk, schedules a microtask to process it, and then the
    // second read pulls energyChunk. Because we are in a single-threaded
    // test environment, polling is still zero at this exact moment.
    expect(getPendingState().pendingEnergyJoules).toBe(0);

    // After awaiting, the comment has been parsed
    await promise;
    expect(getPendingState().pendingEnergyJoules).toBe(12345.6);
    expect(getPendingState().pendingDetail.attribution_ratio).toBe(0.07);
  });

  it("lost energy when not awaited (old behaviour simulation)", async () => {
    // Exact reproduction of the original race-condition:
    // stream.end() fires → originalEnd(result) → turn_end handler runs
    // BEFORE the tee reader has seen the final SSE comment.
    const chunks = [
      str('data: {"choices":[]}\n\n'),
      // energy comes last with no trailing newline
      str(': energy {"energy_joules":234.5}'),
    ];

    const body = makeStream(chunks);
    const promise = readEnergyFromTee(body);

    // Old simulation: commit without waiting for reader
    const oldCommitValue = getPendingState().pendingEnergyJoules; // 0

    // New simulation: wait then commit (the fix)
    await promise;
    const newCommitValue = getPendingState().pendingEnergyJoules; // 234.5

    expect(oldCommitValue).toBe(0); // lost without await
    expect(newCommitValue).toBe(234.5); // captured with await
  });

  it("loses energy on a delayed comment without turn_end await (real-world race)", async () => {
    // This is the exact real-world pattern: the main stream finishes,
    // stream.end() fires, and turn_end commits immediately. The tee reader
    // is still waiting on a delayed SSE energy comment from the server.
    const body = makeDelayedStream([
      { data: str('data: {"choices":[]}\n\n'), delayMs: 1 },
      // the energy comment arrives 20ms later — simulating a real network gap
      { data: str(': energy {"energy_joules":999.99}\n'), delayMs: 20 },
    ]);

    const start = Date.now();
    const promise = readEnergyFromTee(body);

    // At turn_end time (simulated here), the energy comment has NOT yet
    // been parsed because its scheduled delivery is still in the future.
    const atEndTime = getPendingState().pendingEnergyJoules;
    expect(atEndTime).toBe(0);

    // Only after awaiting do we see the energy
    await promise;
    expect(getPendingState().pendingEnergyJoules).toBe(999.99);
    expect(Date.now() - start).toBeGreaterThanOrEqual(20);
  });

  it("handles back-to-back turns without leaking state across turns", async () => {
    // Simulate two sequential requests. No leak should happen because
    // turn_end resets pending state before the next request starts.
    const body1 = makeStream([
      str('data: {"choices":[]}\n\n'),
      str(': energy {"energy_joules":100}\n'),
      str(': cost {"request_cost_usd":0.001}\n'),
    ]);

    resetSessionState();
    await readEnergyFromTee(body1);
    expect(getPendingState().pendingEnergyJoules).toBe(100);
    expect(getPendingState().pendingCostUsd).toBe(0.001);

    // Simulate turn_end clearing state
    resetSessionState();
    expect(getPendingState().pendingEnergyJoules).toBe(0);
    expect(getPendingState().pendingCostUsd).toBe(0);

    // Second request
    const body2 = makeStream([
      str('data: {"choices":[]}\n\n'),
      str(': energy {"energy_joules":200}\n'),
    ]);

    await readEnergyFromTee(body2);
    expect(getPendingState().pendingEnergyJoules).toBe(200);
  });

  it("preserves all neuralwatt fields from a realistic comment", async () => {
    const body = makeStream([
      str('data: {"choices":[]}\n\n'),
      str(
        ': energy {"energy_joules":209.9,"cost_usd":0.000292,"energy_kwh":0.000058307,"avg_power_watts":4747,"duration_seconds":0.906,"attribution_method":"counter_prorated_token_pool_weighted_multi_gpu_8","attribution_ratio":0.0488,"ratio_was_capped":true,"uncapped_attribution_ratio":0.1478,"uncapped_energy_joules":661.32,"uncapped_energy_kwh":0.0001837}\n',
      ),
      str(
        ': cost {"request_cost_usd":0.000292,"cache_savings_usd":0,"allowance_remaining_usd":64.553536,"budget_remaining_usd":64.553536}\n',
      ),
    ]);

    await readEnergyFromTee(body);
    const state = getPendingState();

    expect(state.pendingEnergyJoules).toBe(209.9);
    expect(state.pendingCostUsd).toBe(0.000292);
    expect(state.pendingDetail.energy_kwh).toBe(0.000058307);
    expect(state.pendingDetail.avg_power_watts).toBe(4747);
    expect(state.pendingDetail.duration_seconds).toBe(0.906);
    expect(state.pendingDetail.attribution_method).toBe("counter_prorated_token_pool_weighted_multi_gpu_8");
    expect(state.pendingDetail.attribution_ratio).toBe(0.0488);
    expect(state.pendingDetail.ratio_was_capped).toBe(true);
    expect(state.pendingDetail.uncapped_attribution_ratio).toBe(0.1478);
    expect(state.pendingDetail.uncapped_energy_joules).toBe(661.32);
    expect(state.pendingDetail.uncapped_energy_kwh).toBe(0.0001837);
    expect(state.pendingDetail.cache_savings_usd).toBe(0);
    expect(state.pendingDetail.allowance_remaining_usd).toBe(64.553536);
    expect(state.pendingDetail.budget_remaining_usd).toBe(64.553536);
  });

  it("final non-newline chunk is flushed via decoder decode", async () => {
    // Edge case: the last SSE comment has no trailing newline AND the
    // decoder still holds buffered bytes when done === true.
    const body = new ReadableStream({
      start(controller) {
        // Complete JSON but no trailing newline — must be caught by flush
        controller.enqueue(str('data: {}\n\n: energy {"energy_joules":111}'));
        controller.close();
      },
    });

    await readEnergyFromTee(body);
    expect(getPendingState().pendingEnergyJoules).toBe(111);
  });

  it("handles late done signal after a partial json fragment", async () => {
    // More realistic edge: stream yields partial data then done.
    // The earlier flush logic must handle the buffer correctly.
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(str(': energy {"energy_joules":77'));
        controller.enqueue(str('.7,"cost_usd":0.001}\n: cost {"request_cost_usd":0.001}\n'));
        controller.close();
      },
    });

    await readEnergyFromTee(body);
    const state = getPendingState();
    expect(state.pendingEnergyJoules).toBe(77.7);
    expect(state.pendingCostUsd).toBe(0.001);
  });
});

describe("readEnergyFromTee MCR stream comments", () => {
  beforeEach(() => {
    resetSessionState();
  });

  it("parses : mcr-session comment", async () => {
    const body = makeStream([
      str(': mcr-session {"session_fp": "df77ba79e128f08f7ea2c0d1", "stored_through": 1, "safe_drop_before": 13}\n'),
    ]);
    await readEnergyFromTee(body);

    const state = getPendingState();
    expect(state.pendingMcrSession).not.toBeNull();
    expect(state.pendingMcrSession!.session_fp).toBe("df77ba79e128f08f7ea2c0d1");
    expect(state.pendingMcrSession!.stored_through).toBe(1);
    expect(state.pendingMcrSession!.safe_drop_before).toBe(13);
  });

  it("extracts .mcr sub-object from : energy comment", async () => {
    const body = makeStream([
      str(': energy {"energy_joules": 44.1, "mcr": {"compaction_triggered": false, "session_turns": 3, "context_tokens": 5, "apc_hit_rate": 0.85, "mcr_compacted_tokens": 420, "mcr_original_tokens": 1000}}\n'),
    ]);
    await readEnergyFromTee(body);

    const state = getPendingState();
    expect(state.pendingMcrEnergy).not.toBeNull();
    expect(state.pendingMcrEnergy!.energy_joules).toBe(44.1);
    expect(state.pendingMcrEnergy!.mcr).toBeDefined();
    expect(state.pendingMcrEnergy!.mcr!.compaction_triggered).toBe(false);
    expect(state.pendingMcrEnergy!.mcr!.session_turns).toBe(3);
    expect(state.pendingMcrEnergy!.mcr!.context_tokens).toBe(5);
    expect(state.pendingMcrEnergy!.mcr!.apc_hit_rate).toBe(0.85);
    expect(state.pendingMcrEnergy!.mcr!.mcr_compacted_tokens).toBe(420);
    expect(state.pendingMcrEnergy!.mcr!.mcr_original_tokens).toBe(1000);
  });

  it("parses full realistic stream with energy, mcr-session, and cost", async () => {
    const body = makeStream([
      str('data: {"id":"chatcmpl-8b5e61f1de1e81cd","object":"chat.completion.chunk","created":1779942195,"model":"neuralwatt/glm-5.1-long","choices":[{"index":0,"delta":{"reasoning":"The"},"logprobs":null,"finish_reason":null,"token_ids":null}]}\n\n'),
      str('data: {"id":"chatcmpl-8b5e61f1de1e81cd","object":"chat.completion.chunk","created":1779942195,"model":"neuralwatt/glm-5.1-long","choices":[{"index":0,"delta":{"content":"Hello"},"logprobs":null,"finish_reason":null,"token_ids":null}]}\n\n'),
      str(': energy {"energy_joules": 44.1, "energy_kwh": 1.2251e-05, "avg_power_watts": 4124.0, "duration_seconds": 0.463, "attribution_method": "counter_prorated_token_pool_weighted_multi_gpu_8", "attribution_ratio": 0.0231, "carbon_g_co2eq": 0.0005146, "grid_carbon_intensity_gco2perkwhr": 42.0, "grid_id": "FI", "carbon_source": "agent_cache", "mcr": {"compaction_triggered": false, "inference_energy_joules": 44.1, "compaction_energy_joules": 0.0, "session_turns": 1, "context_tokens": 5, "mode": "virtual_context", "summaries_used": 0, "sync_compaction_ran": false, "chunks_pending_compaction": 0, "original_tokens": 11, "all_chunks_cached": false, "mcr_compacted_tokens": 0, "mcr_original_tokens": 11, "session_fp": "df77ba79e128f08f7ea2c0d1", "apc_hit_tokens": 0, "apc_miss_tokens": 5, "apc_hit_rate": 0.0, "current_turn_new_tokens": 399}}\n'),
      str(': mcr-session {"session_fp": "df77ba79e128f08f7ea2c0d1", "stored_through": 1, "safe_drop_before": 0, "apc_hit_tokens": 0, "apc_miss_tokens": 5, "apc_hit_rate": 0.0, "current_turn_new_tokens": 399}\n'),
      str(': cost {"request_cost_usd": 6.1e-05, "cache_savings_usd": 0.0, "allowance_remaining_usd": 74.623536, "budget_remaining_usd": 74.623536}\n'),
    ]);
    await readEnergyFromTee(body);

    const state = getPendingState();
    // Energy
    expect(state.pendingEnergyJoules).toBe(44.1);
    expect(state.pendingCostUsd).toBeCloseTo(6.1e-05, 10);
    expect(state.pendingDetail.attribution_method).toBe("counter_prorated_token_pool_weighted_multi_gpu_8");
    // MCR session from : mcr-session
    expect(state.pendingMcrSession).not.toBeNull();
    expect(state.pendingMcrSession!.session_fp).toBe("df77ba79e128f08f7ea2c0d1");
    expect(state.pendingMcrSession!.stored_through).toBe(1);
    expect(state.pendingMcrSession!.safe_drop_before).toBe(0);
    // MCR energy from : energy .mcr
    expect(state.pendingMcrEnergy).not.toBeNull();
    expect(state.pendingMcrEnergy!.energy_joules).toBe(44.1);
    expect(state.pendingMcrEnergy!.mcr!.compaction_triggered).toBe(false);
    expect(state.pendingMcrEnergy!.mcr!.session_turns).toBe(1);
    expect(state.pendingMcrEnergy!.mcr!.context_tokens).toBe(5);
    expect(state.pendingMcrEnergy!.mcr!.apc_hit_rate).toBe(0.0);
    expect(state.pendingMcrEnergy!.mcr!.mcr_compacted_tokens).toBe(0);
    expect(state.pendingMcrEnergy!.mcr!.mcr_original_tokens).toBe(11);
    // Raw SSE payloads preserved verbatim
    expect(state.pendingEnergyRaw).not.toBeNull();
    expect((state.pendingEnergyRaw as any).carbon_g_co2eq).toBe(0.0005146);
    expect((state.pendingEnergyRaw as any).grid_id).toBe("FI");
    expect((state.pendingEnergyRaw as any).mcr.mode).toBe("virtual_context");
    expect((state.pendingEnergyRaw as any).mcr.apc_hit_tokens).toBe(0);
    expect(state.pendingMcrSessionRaw).not.toBeNull();
    expect((state.pendingMcrSessionRaw as any).apc_hit_tokens).toBe(0);
    expect((state.pendingMcrSessionRaw as any).current_turn_new_tokens).toBe(399);
    expect(state.pendingCostRaw).not.toBeNull();
    expect((state.pendingCostRaw as any).allowance_remaining_usd).toBe(74.623536);
  });

  it("ignores malformed : mcr-session comment", async () => {
    const body = makeStream([
      str(': mcr-session not-json\n'),
      str(': mcr-session {"no_session_fp": true}\n'),
    ]);
    await readEnergyFromTee(body);

    const state = getPendingState();
    expect(state.pendingMcrSession).toBeNull();
  });

  it("ignores : energy without .mcr sub-object", async () => {
    const body = makeStream([
      str(': energy {"energy_joules": 10}\n'),
    ]);
    await readEnergyFromTee(body);

    const state = getPendingState();
    expect(state.pendingEnergyJoules).toBe(10);
    expect(state.pendingMcrEnergy).toBeNull();
  });

  it("consumePendingMCR returns and clears pending MCR data", async () => {
    const body = makeStream([
      str(': mcr-session {"session_fp": "abc123", "stored_through": 5, "safe_drop_before": 3}\n'),
      str(': energy {"energy_joules": 99, "mcr": {"compaction_triggered": true, "session_turns": 2, "context_tokens": 10, "apc_hit_rate": 0.5}}\n'),
    ]);
    // readEnergyFromTee populates pendingMcrSession/pendingMcrEnergy as a
    // side effect. After awaiting, publishMCRRidge copies them to globalThis
    // so consumePendingMCR() can read them.
    await readEnergyFromTee(body);
    publishMCRRidge();

    const result = consumePendingMCR();
    expect(result.mcrSession).not.toBeNull();
    expect(result.mcrSession!.session_fp).toBe("abc123");
    expect(result.mcrSession!.safe_drop_before).toBe(3);
    expect(result.mcrEnergy).not.toBeNull();
    expect(result.mcrEnergy!.energy_joules).toBe(99);
    expect(result.mcrEnergy!.mcr!.apc_hit_rate).toBe(0.5);

    // Consumed — second call returns nulls
    const result2 = consumePendingMCR();
    expect(result2.mcrSession).toBeNull();
    expect(result2.mcrEnergy).toBeNull();
  });

  it("resetSessionState clears pending MCR data", async () => {
    const body = makeStream([
      str(': mcr-session {"session_fp": "abc", "stored_through": 1, "safe_drop_before": 0}\n'),
      str(': energy {"energy_joules": 50, "mcr": {"compaction_triggered": false, "session_turns": 1, "context_tokens": 5}}\n'),
    ]);
    await readEnergyFromTee(body);

    expect(getPendingState().pendingMcrSession).not.toBeNull();
    expect(getPendingState().pendingMcrEnergy).not.toBeNull();

    resetSessionState();

    expect(getPendingState().pendingMcrSession).toBeNull();
    expect(getPendingState().pendingMcrEnergy).toBeNull();
  });

  it("raw SSE payloads are captured even with no energy/cost", async () => {
    // Edge case: mcr-session comment arrives alone (no : energy, no : cost).
    // The raw field should still be populated.
    const body = makeStream([
      str(': mcr-session {"session_fp": "onlyfp", "stored_through": 2, "safe_drop_before": 1}\n'),
    ]);
    await readEnergyFromTee(body);

    const state = getPendingState();
    expect(state.pendingEnergyJoules).toBe(0);
    expect(state.pendingCostUsd).toBe(0);
    expect(state.pendingMcrSessionRaw).not.toBeNull();
    expect((state.pendingMcrSessionRaw as any).session_fp).toBe("onlyfp");
    expect(state.pendingEnergyRaw).toBeNull();
    expect(state.pendingCostRaw).toBeNull();
  });
});
