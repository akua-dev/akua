import { expect, it, test } from '@effect/vitest';
import { sourceFiles } from './fs-test';
import { BunServices } from '@effect/platform-bun';
import { Effect, FileSystem } from 'effect';

import ts from 'typescript';

import { runAkua } from './run-akua';

it.effect('production CLI source contains no raw throw statements', () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const files = (yield* Effect.all(['src', 'scripts'].map(sourceFiles))).flat();
		const contents = new Map(
			yield* Effect.forEach(files, (file) =>
				fs.readFileString(file).pipe(Effect.map((text): [string, string] => [file, text]))
			)
		);
		expect(findThrowStatements(contents)).toEqual([]);
	}).pipe(Effect.provide(BunServices.layer))
);

it.effect('release entrypoint contains no aliased imports', () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const files = (yield* Effect.all(['src', 'scripts'].map(sourceFiles))).flat();
		const contents = new Map(
			yield* Effect.forEach(files, (file) =>
				fs.readFileString(file).pipe(Effect.map((text): [string, string] => [file, text]))
			)
		);
		expect(
			findAliasedImports('scripts/release.ts', contents.get('scripts/release.ts') ?? '')
		).toEqual([]);
	}).pipe(Effect.provide(BunServices.layer))
);

test('invalid commands arguments render a usage envelope', async () => {
	const { stdout, exitCode } = await runAkua(['commands', 'unexpected', '--json']);

	expect(exitCode).toBe(2);
	expect(JSON.parse(stdout)).toMatchObject({
		error: {
			code: 'AKUA_USAGE_ERROR',
			message: 'Unexpected argument for akua commands.'
		}
	});
});

test('invalid auth arguments render a usage envelope', async () => {
	const { stdout, exitCode } = await runAkua(['auth', 'login', 'unexpected', '--json']);

	expect(exitCode).toBe(2);
	expect(JSON.parse(stdout)).toMatchObject({
		error: {
			code: 'AKUA_USAGE_ERROR',
			message: 'Unexpected argument for akua auth login.'
		}
	});
});

function findThrowStatements(contents: ReadonlyMap<string, string>) {
	return [...contents].flatMap(([file, text]) => {
		const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
		const throws: string[] = [];
		const visit = (node: ts.Node) => {
			if (ts.isThrowStatement(node)) {
				const { line } = source.getLineAndCharacterOfPosition(node.getStart());
				throws.push(`${file}:${line + 1}`);
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
		return throws;
	});
}

function findAliasedImports(file: string, text: string): string[] {
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	const aliases: string[] = [];
	const visit = (node: ts.Node) => {
		if (ts.isImportSpecifier(node) && node.propertyName !== undefined) {
			const { line } = source.getLineAndCharacterOfPosition(node.getStart());
			aliases.push(`${file}:${line + 1}`);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return aliases;
}
