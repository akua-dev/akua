import { describe, expect, it } from '@effect/vitest';
import { Effect, FileSystem, Path, Schema } from 'effect';
import * as Yaml from 'effect/encoding/Yaml';
import { BunServices } from '@effect/platform-bun';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { artifactName, RELEASE_TARGETS } from '../scripts/release';

const WorkflowEnvironment = Schema.Record(
	Schema.String,
	Schema.Literals([
		'${{ github.token }}',
		'${{ needs.smoke-matrix.outputs.version }}',
		'${{ matrix.target }}'
	])
);

const Step = Schema.Struct({
	id: Schema.optional(Schema.String),
	uses: Schema.optional(Schema.String),
	run: Schema.optional(Schema.String),
	env: Schema.optional(WorkflowEnvironment),
	secrets: Schema.optional(Schema.Never)
});
const Job = Schema.Struct({
	env: Schema.optional(WorkflowEnvironment),
	if: Schema.optional(Schema.String),
	needs: Schema.optional(Schema.String),
	'runs-on': Schema.optional(Schema.String),
	permissions: Schema.optional(Schema.Record(Schema.String, Schema.Literal('read'))),
	steps: Schema.Array(Step),
	secrets: Schema.optional(Schema.Never)
});

const readWorkflow = Effect.fn('readWorkflow')(function* () {
	const fs = yield* FileSystem.FileSystem;
	const content = yield* fs.readFileString('../.github/workflows/cli.yml');
	return yield* Schema.decodeUnknownEffect(Workflow)(yield* Effect.try(() => Yaml.parse(content)));
});
const Workflow = Schema.Struct({
	on: Schema.Struct({
		push: Schema.Struct({ branches: Schema.Array(Schema.String) }),
		pull_request: Schema.Struct({ branches: Schema.Array(Schema.String) }),
		release: Schema.optional(Schema.Struct({ types: Schema.Array(Schema.String) })),
		workflow_dispatch: Schema.optional(Schema.Unknown)
	}),
	permissions: Schema.Record(Schema.String, Schema.Literal('read')),
	env: Schema.optional(Schema.Never),
	jobs: Schema.Record(Schema.String, Job)
});

describe('advisory public CI contract', () => {
	it.effect(
		'checks source changes and smokes published assets without a release builder or writer',
		() =>
			Effect.gen(function* () {
				const workflow = yield* readWorkflow();
				expect(workflow.permissions).toEqual({ contents: 'read' });
				expect(workflow.on.push.branches).toEqual(['main']);
				expect(workflow.on.pull_request.branches).toEqual(['main']);
				expect(workflow.on.release?.types).toEqual(['published']);
				expect(workflow.on).toHaveProperty('workflow_dispatch');
				expect(Object.keys(workflow.jobs).sort()).toEqual([
					'check',
					'install-smoke',
					'smoke-matrix'
				]);
				expect(workflow.jobs.check?.['runs-on']).toBe('ubuntu-latest');
				expect(workflow.jobs.check?.if).toBe(
					"github.event_name == 'push' || github.event_name == 'pull_request'"
				);
				expect(workflow.jobs['smoke-matrix']?.if).toBe(
					"github.event_name == 'release' || github.event_name == 'workflow_dispatch'"
				);
				expect(workflow.jobs['install-smoke']?.needs).toBe('smoke-matrix');
				for (const job of Object.values(workflow.jobs))
					for (const step of job.steps)
						if (step.uses !== undefined) {
							expect(step.uses).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
							expect(step.uses.split('@')[0]).toMatch(/^(actions\/checkout|oven-sh\/setup-bun)$/);
						}
			}).pipe(Effect.provide(BunServices.layer))
	);

	it.live.each(RELEASE_TARGETS)('downloads and admits only the published $id archive', (target) =>
		Effect.gen(function* () {
			const workflow = yield* readWorkflow();
			const step = workflow.jobs['install-smoke']?.steps.find(
				(candidate) => candidate.id === 'release-smoke'
			);
			expect(step?.env).toEqual({
				GH_TOKEN: '${{ github.token }}',
				VERSION: '${{ needs.smoke-matrix.outputs.version }}',
				TARGET: '${{ matrix.target }}'
			});
			if (step?.run === undefined) return yield* Effect.die('Missing published release smoke');
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const root = yield* fs.makeTempDirectoryScoped();
			const bin = path.join(root, 'bin');
			yield* fs.makeDirectory(bin);
			const archive = artifactName('1.2.3', target);
			const digest = 'a'.repeat(64);
			yield* fs.writeFileString(
				path.join(bin, 'gh'),
				`#!/bin/sh\nprintf '%s\\n' "$@" > gh.log\nmkdir -p dist/release\nprintf '%s  %s\\n' "$DIGEST" "$ARCHIVE" > "dist/release/$ARCHIVE.sha256"\n`
			);
			yield* fs.writeFileString(
				path.join(bin, 'bun'),
				`#!/bin/sh\nprintf '%s\\n' "$@" > bun.log\n`
			);
			yield* fs.chmod(path.join(bin, 'gh'), 0o755);
			yield* fs.chmod(path.join(bin, 'bun'), 0o755);
			const handle = yield* spawner.spawn(
				ChildProcess.make('bash', ['-euo', 'pipefail', '-c', step.run], {
					cwd: root,
					env: {
						PATH: `${bin}:/usr/bin:/bin`,
						VERSION: '1.2.3',
						TARGET: target.id,
						ARCHIVE: archive,
						DIGEST: digest
					}
				})
			);
			expect(yield* handle.exitCode).toBe(0);
			expect((yield* fs.readFileString(path.join(root, 'gh.log'))).trim().split('\n')).toEqual([
				'release',
				'download',
				'v1.2.3',
				'--repo',
				'akua-dev/akua',
				'--pattern',
				archive,
				'--pattern',
				`${archive}.sha256`,
				'--dir',
				'dist/release'
			]);
			expect((yield* fs.readFileString(path.join(root, 'bun.log'))).trim().split('\n')).toEqual([
				'scripts/release.ts',
				'smoke',
				'--version',
				'1.2.3',
				'--output',
				'dist/release',
				'--target',
				target.id,
				'--archive-sha256',
				digest
			]);
		}).pipe(Effect.scoped, Effect.provide(BunServices.layer))
	);
});
