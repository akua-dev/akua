import { describe, expect, it } from '@effect/vitest';
import { Effect, FileSystem, Schema } from 'effect';
import * as Yaml from 'effect/encoding/Yaml';
import { BunServices } from '@effect/platform-bun';

const Step = Schema.Struct({
	uses: Schema.optional(Schema.String),
	run: Schema.optional(Schema.String),
	secrets: Schema.optional(Schema.Never)
});
const Job = Schema.Struct({
	'runs-on': Schema.optional(Schema.String),
	permissions: Schema.optional(Schema.Record(Schema.String, Schema.Literal('read'))),
	steps: Schema.Array(Step),
	secrets: Schema.optional(Schema.Never)
});
const Workflow = Schema.Struct({
	permissions: Schema.Record(Schema.String, Schema.Literal('read')),
	jobs: Schema.Record(Schema.String, Job)
});

describe('advisory public CI contract', () => {
	it.effect('uses read-only hosted checks and archive smokes without a release writer', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const ciWorkflow = yield* fs.readFileString('../.github/workflows/cli.yml');
			const parsed = yield* Effect.try(() => Yaml.parse(ciWorkflow));
			const workflow = yield* Schema.decodeUnknownEffect(Workflow)(parsed);
			expect(workflow.permissions).toEqual({ contents: 'read' });
			expect(Object.keys(workflow.jobs).sort()).toEqual([
				'check',
				'install-smoke',
				'package-release'
			]);
			expect(workflow.jobs.check?.['runs-on']).toBe('ubuntu-latest');
			expect(workflow.jobs['package-release']?.['runs-on']).toBe('ubuntu-24.04');
			expect(
				workflow.jobs['package-release']?.steps.map((step) => step.run).filter(Boolean)
			).toContain("bun install --frozen-lockfile --os='*' --cpu='*'");
			expect(
				workflow.jobs['install-smoke']?.steps.filter((step) =>
					step.uses?.startsWith('actions/download-artifact@')
				)
			).toHaveLength(1);
			// Every action is pinned to a full commit SHA, not a movable tag.
			for (const job of Object.values(workflow.jobs))
				for (const step of job.steps)
					if (step.uses !== undefined) expect(step.uses).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
		}).pipe(Effect.provide(BunServices.layer))
	);
});
