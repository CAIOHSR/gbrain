/** Focused contract tests for `gbrain dream --source-only`. */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { NON_GLOBAL_PHASES, GLOBAL_PHASES, runCycle } from '../src/core/cycle.ts';
import { runDream } from '../src/commands/dream.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let brainDir: string;
let gbrainHome: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-source-only-'));
  gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-source-only-home-'));
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config, archived, created_at)
     VALUES ('vor-brain', 'VOR brain', $1, '{}'::jsonb, false, NOW())`,
    [brainDir],
  );
});

afterEach(() => {
  rmSync(brainDir, { recursive: true, force: true });
  rmSync(gbrainHome, { recursive: true, force: true });
});

async function lastSourceCycleAt(): Promise<string | null> {
  const rows = await engine.executeRaw<{ config: Record<string, unknown> | null }>(
    `SELECT config FROM sources WHERE id = 'vor-brain'`,
  );
  const value = rows[0]?.config?.last_source_cycle_at;
  return typeof value === 'string' ? value : null;
}

describe('gbrain dream --source-only', () => {
  test('reports every non-global phase and no global phase', async () => {
    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      const report = await runDream(engine, [
        '--source', 'vor-brain',
        '--dir', brainDir,
        '--source-only',
        '--dry-run',
        '--json',
      ]);
      expect(report).toBeTruthy();
      const phases = report?.phases.map((phase) => phase.phase) ?? [];
      expect(phases).toEqual(NON_GLOBAL_PHASES);
      expect(phases).not.toContain(GLOBAL_PHASES[0]);
    });
  }, 120_000);

  test('--source-only combined with --phase is a usage error', async () => {
    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      const exitSpy = spyOn(process, 'exit').mockImplementation(() => { throw new Error('EXIT'); });
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
      try {
        await runDream(engine, ['--source', 'vor-brain', '--dir', brainDir, '--source-only', '--phase', 'lint']);
        throw new Error('expected runDream to exit');
      } catch (error: any) {
        expect(error.message).toBe('EXIT');
      }
      expect(exitSpy).toHaveBeenCalledWith(2);
      expect(errorSpy.mock.calls.flat().join(' ')).toMatch(/--source-only cannot be combined with --phase/);
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });

  test('--help documents --source-only without connecting the cycle', async () => {
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    await runDream(null, ['--help', '--source-only']);
    expect(logSpy.mock.calls.flat().join(' ')).toContain('--source-only');
    logSpy.mockRestore();
  });

  test('source freshness is written only after the single cycle completes', async () => {
    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      const observations: Array<string | null> = [];
      const report = await runCycle(engine, {
        brainDir,
        sourceId: 'vor-brain',
        phases: NON_GLOBAL_PHASES,
        dryRun: false,
        yieldBetweenPhases: async () => {
          observations.push(await lastSourceCycleAt());
        },
      });
      expect(report.phases.map((phase) => phase.phase)).toEqual(NON_GLOBAL_PHASES);
      expect(observations.length).toBeGreaterThan(0);
      expect(observations.every((value) => value === null)).toBe(true);
      expect(await lastSourceCycleAt()).not.toBeNull();
    });
  }, 120_000);
});
