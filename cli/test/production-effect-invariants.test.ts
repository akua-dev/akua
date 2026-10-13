import { expect, it, test } from '@effect/vitest';
import { sourceFiles } from './fs-test';
import { BunServices } from '@effect/platform-bun';
import { Effect, FileSystem } from 'effect';
import ts from 'typescript';

const hostModules = new Set([
	'node:child_process',
	'node:crypto',
	'node:fs',
	'node:fs/promises',
	'node:http',
	'node:https',
	'node:net',
	'node:os',
	'node:process',
	'node:tls'
]);
const hostGlobals = new Set(['Bun', 'Deno', 'console', 'fetch', 'process', 'require']);

interface Violation {
	readonly file: string;
	readonly rule: string;
}

interface ForbiddenPattern {
	readonly rule: string;
	readonly pattern: RegExp;
}

const forbiddenPatterns: readonly ForbiddenPattern[] = [
	{
		rule: 'native Promise type or API',
		pattern: /\b(?:Promise\s*[<.]|new\s+Promise\b)/
	},
	{ rule: 'Effect.runPromise', pattern: /\bEffect\.runPromise\b/ }
];

it.effect('production TypeScript is Effect-only and assertion-free', () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const files = (yield* Effect.all(['src', 'scripts'].map(sourceFiles))).flat();
		const contents = new Map(
			yield* Effect.forEach(files, (file) =>
				fs.readFileString(file).pipe(Effect.map((text): [string, string] => [file, text]))
			)
		);
		const violations = files.flatMap((file) =>
			inspectProductionFile(file, contents.get(file) ?? '')
		);

		expect(violations).toEqual([]);
	}).pipe(Effect.provide(BunServices.layer))
);

it.effect('production host I/O is isolated to live services and executable terminals', () =>
	Effect.gen(function* () {
		const files = (yield* Effect.all(['src', 'scripts'].map(sourceFiles))).flat();

		const program = ts.createProgram(files, {});
		const checker = program.getTypeChecker();
		const violations = files.flatMap((file) => inspectHostIo(file, program, checker));

		expect(violations).toEqual([]);
	}).pipe(Effect.provide(BunServices.layer))
);

it.effect('production runtime handoffs stay inside import.meta.main terminal guards', () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const files = (yield* Effect.all(['src', 'scripts'].map(sourceFiles))).flat();
		const contents = new Map(
			yield* Effect.forEach(files, (file) =>
				fs.readFileString(file).pipe(Effect.map((text): [string, string] => [file, text]))
			)
		);
		const violations = files.flatMap((file) => {
			const source = contents.get(file) ?? '';
			return inspectRuntimeHandoffs(
				file,
				ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
			);
		});

		expect(violations).toEqual([]);
	}).pipe(Effect.provide(BunServices.layer))
);

test('runtime handoff inspection rejects Runtime.makeRunMain outside its terminal guard', () => {
	const source = ts.createSourceFile(
		'src/bin/akua.ts',
		'import { Runtime } from "effect";\nRuntime.makeRunMain(() => {});',
		ts.ScriptTarget.Latest,
		true
	);

	expect(inspectRuntimeHandoffs('src/bin/akua.ts', source)).toEqual([
		{
			file: 'src/bin/akua.ts',
			rule: 'Runtime.makeRunMain outside import.meta.main'
		}
	]);
});

test('runtime handoff inspection recognizes aliased and destructured makeRunMain calls', () => {
	const aliased = ts.createSourceFile(
		'src/bin/akua.ts',
		'import { Runtime as RuntimeAlias } from "effect";\nRuntimeAlias.makeRunMain(() => {});',
		ts.ScriptTarget.Latest,
		true
	);
	const destructured = ts.createSourceFile(
		'src/bin/akua.ts',
		'import { Runtime } from "effect";\nconst { makeRunMain } = Runtime;\nmakeRunMain(() => {});',
		ts.ScriptTarget.Latest,
		true
	);
	const destructuredAlias = ts.createSourceFile(
		'src/bin/akua.ts',
		'import { Runtime } from "effect";\nconst { makeRunMain: runMain } = Runtime;\nrunMain(() => {});',
		ts.ScriptTarget.Latest,
		true
	);

	expect(inspectRuntimeHandoffs('src/bin/akua.ts', aliased)).toEqual([
		{
			file: 'src/bin/akua.ts',
			rule: 'Runtime.makeRunMain outside import.meta.main'
		}
	]);
	expect(inspectRuntimeHandoffs('src/bin/akua.ts', destructured)).toEqual([
		{
			file: 'src/bin/akua.ts',
			rule: 'Runtime.makeRunMain outside import.meta.main'
		}
	]);
	expect(inspectRuntimeHandoffs('src/bin/akua.ts', destructuredAlias)).toEqual([
		{
			file: 'src/bin/akua.ts',
			rule: 'Runtime.makeRunMain outside import.meta.main'
		}
	]);
});

test('host I/O inspection rejects host APIs in non-live service definitions', () => {
	const source = [
		'import { readFile } from "node:fs/promises";',
		'readFile("config.json");',
		'export const HttpLive = undefined;',
		'export const BrowserLive = undefined;',
		'export const ProcessLive = undefined;',
		'export const ConsoleLive = undefined;',
		'export const SecureConfigLive = undefined;',
		'export const ClockLive = undefined;'
	].join('\n');

	expect(inspectSyntheticHostIo('src/runtime/services.ts', source)).toEqual([
		{
			file: 'src/runtime/services.ts',
			rule: 'host I/O outside a typed live service'
		}
	]);
});

test('runtime handoff inspection follows Runtime aliases and function-local destructures', () => {
	const runtimeAlias = ts.createSourceFile(
		'src/bin/akua.ts',
		'import { Runtime } from "effect";\nconst R = Runtime;\nR.makeRunMain(() => {});',
		ts.ScriptTarget.Latest,
		true
	);
	const localDestructure = ts.createSourceFile(
		'src/bin/akua.ts',
		'import { Runtime } from "effect";\nfunction start() { const { makeRunMain } = Runtime; makeRunMain(() => {}); }',
		ts.ScriptTarget.Latest,
		true
	);

	expect(inspectRuntimeHandoffs('src/bin/akua.ts', runtimeAlias)).toEqual([
		{
			file: 'src/bin/akua.ts',
			rule: 'Runtime.makeRunMain outside import.meta.main'
		}
	]);
	expect(inspectRuntimeHandoffs('src/bin/akua.ts', localDestructure)).toEqual([
		{
			file: 'src/bin/akua.ts',
			rule: 'Runtime.makeRunMain outside import.meta.main'
		}
	]);
});

test('runtime handoff inspection requires makeRunMain in the terminal guard body', () => {
	const source = ts.createSourceFile(
		'src/bin/akua.ts',
		'import { Runtime } from "effect";\nif (import.meta.main) {\n  function start() { Runtime.makeRunMain(() => {}); }\n  start();\n}',
		ts.ScriptTarget.Latest,
		true
	);

	expect(inspectRuntimeHandoffs('src/bin/akua.ts', source)).toEqual([
		{
			file: 'src/bin/akua.ts',
			rule: 'Runtime.makeRunMain outside import.meta.main'
		}
	]);
});

test('runtime handoff inspection requires a block-bodied import.meta.main guard', () => {
	const source = ts.createSourceFile(
		'src/bin/akua.ts',
		'import { Runtime } from "effect";\nif (import.meta.main) Runtime.makeRunMain(() => {});',
		ts.ScriptTarget.Latest,
		true
	);

	expect(inspectRuntimeHandoffs('src/bin/akua.ts', source)).toEqual([
		{
			file: 'src/bin/akua.ts',
			rule: 'Runtime.makeRunMain outside import.meta.main'
		}
	]);
});

it.effect('test files import vitest primitives only through @effect/vitest', () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const files = (yield* Effect.all(['test'].map(sourceFiles))).flat();
		const contents = new Map(
			yield* Effect.forEach(files, (file) =>
				fs.readFileString(file).pipe(Effect.map((text): [string, string] => [file, text]))
			)
		);
		const violations = files.flatMap((file) => {
			const source = contents.get(file) ?? '';
			const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
			const found: Violation[] = [];
			visit(sourceFile, (node) => {
				if (
					ts.isImportDeclaration(node) &&
					ts.isStringLiteral(node.moduleSpecifier) &&
					node.moduleSpecifier.text === 'vitest'
				) {
					found.push({
						file,
						rule: 'import from "vitest" instead of "@effect/vitest"'
					});
				}
			});
			return found;
		});

		expect(violations).toEqual([]);
	}).pipe(Effect.provide(BunServices.layer))
);

it.effect('test files never monkey-patch globalThis.fetch', () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const files = (yield* Effect.all(['test'].map(sourceFiles))).flat();
		const contents = new Map(
			yield* Effect.forEach(files, (file) =>
				fs.readFileString(file).pipe(Effect.map((text): [string, string] => [file, text]))
			)
		);
		const violations = files.flatMap((file) => {
			const source = contents.get(file) ?? '';
			return /globalThis\.fetch\s*=/.test(source)
				? [
						{
							file,
							rule: 'globalThis.fetch assignment; use FetchHttpClient.Fetch or a service test layer instead'
						}
					]
				: [];
		});

		expect(violations).toEqual([]);
	}).pipe(Effect.provide(BunServices.layer))
);

function inspectProductionFile(file: string, source: string): Violation[] {
	const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest);
	const violations = lexicalViolations(file, source);

	visit(sourceFile, (node) => {
		if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
			violations.push({ file, rule: 'TypeScript assertion' });
		}
		if (ts.isThrowStatement(node)) {
			violations.push({ file, rule: 'raw throw statement' });
		}
		if (ts.isAwaitExpression(node)) {
			violations.push({ file, rule: 'await expression' });
		}
		if (isAsyncFunction(node)) {
			violations.push({ file, rule: 'async function' });
		}
	});

	return violations;
}

function isAsyncFunction(node: ts.Node): boolean {
	return (
		ts.isFunctionLike(node) &&
		ts.canHaveModifiers(node) &&
		ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true
	);
}

function inspectHostIo(file: string, program: ts.Program, checker: ts.TypeChecker): Violation[] {
	const sourceFile = program.getSourceFile(file);
	if (sourceFile === undefined) return [{ file, rule: 'missing TypeScript source' }];
	const violations: Violation[] = [];

	visit(sourceFile, (node) => {
		if (!isHostIo(node, checker)) return;
		if (isApprovedLiveServiceModule(file)) return;
		if (isExecutableTerminal(file, node)) return;
		violations.push({ file, rule: 'host I/O outside a typed live service' });
	});

	return violations;
}

function inspectSyntheticHostIo(file: string, source: string): Violation[] {
	const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	const compilerHost = ts.createCompilerHost({ noLib: true, noResolve: true });
	const originalGetSourceFile = compilerHost.getSourceFile.bind(compilerHost);
	compilerHost.getSourceFile = (name, languageVersion) =>
		name === file ? sourceFile : originalGetSourceFile(name, languageVersion);
	const program = ts.createProgram({
		rootNames: [file],
		options: { noLib: true, noResolve: true },
		host: compilerHost
	});

	return inspectHostIo(file, program, program.getTypeChecker());
}

function isHostIo(node: ts.Node, checker: ts.TypeChecker): boolean {
	if (ts.isImportDeclaration(node)) {
		const module = node.moduleSpecifier;
		return ts.isStringLiteral(module) && hostModules.has(module.text);
	}
	if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
		const module = node.arguments[0];
		return module !== undefined && ts.isStringLiteral(module) && hostModules.has(module.text);
	}
	if (
		ts.isCallExpression(node) &&
		ts.isIdentifier(node.expression) &&
		node.expression.text === 'require'
	) {
		const module = node.arguments[0];
		return module !== undefined && ts.isStringLiteral(module) && hostModules.has(module.text);
	}
	if (!ts.isIdentifier(node) || !hostGlobals.has(node.text)) return false;
	const symbol = checker.getSymbolAtLocation(node);
	return (
		symbol === undefined ||
		!symbol.declarations?.some(
			(declaration) => declaration.getSourceFile() === node.getSourceFile()
		)
	);
}

function isApprovedLiveServiceModule(file: string): boolean {
	return file.endsWith('-live.ts');
}

function isExecutableTerminal(file: string, node: ts.Node): boolean {
	if (file !== 'src/bin/akua.ts' && !/^scripts\/(?:generate-contract|release)\.ts$/.test(file))
		return false;
	let current: ts.Node | undefined = node;
	while (current !== undefined) {
		if (ts.isIfStatement(current) && isImportMetaMainGuard(current.expression)) return true;
		current = current.parent;
	}
	return false;
}

function isImportMetaMainGuard(expression: ts.Expression): boolean {
	return (
		ts.isPropertyAccessExpression(expression) &&
		expression.name.text === 'main' &&
		ts.isMetaProperty(expression.expression) &&
		expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword
	);
}

function inspectRuntimeHandoffs(file: string, sourceFile: ts.SourceFile): Violation[] {
	const bindings = collectRuntimeBindings(sourceFile);
	const violations: Violation[] = [];
	visit(sourceFile, (node) => {
		if (!isRuntimeMakeRunMain(node, bindings) || isRuntimeTerminalBody(file, node)) return;
		violations.push({
			file,
			rule: 'Runtime.makeRunMain outside import.meta.main'
		});
	});
	return violations;
}

interface RuntimeBindings {
	readonly runtime: ReadonlySet<string>;
	readonly makeRunMain: ReadonlySet<string>;
}

function collectRuntimeBindings(sourceFile: ts.SourceFile): RuntimeBindings {
	const runtime = new Set<string>();
	const makeRunMain = new Set<string>();

	visit(sourceFile, (node) => {
		if (!ts.isImportDeclaration(node) || !isEffectImport(node)) return;
		const bindings = node.importClause?.namedBindings;
		if (!bindings || !ts.isNamedImports(bindings)) return;
		for (const element of bindings.elements) {
			if ((element.propertyName?.text ?? element.name.text) === 'Runtime')
				runtime.add(element.name.text);
		}
	});

	let changed = true;
	while (changed) {
		changed = false;
		visit(sourceFile, (node) => {
			if (!ts.isVariableDeclaration(node) || node.initializer === undefined) return;
			if (ts.isIdentifier(node.name)) {
				if (isRuntimeAlias(node.initializer, runtime))
					changed ||= addBinding(runtime, node.name.text);
				if (isMakeRunMainAlias(node.initializer, runtime, makeRunMain))
					changed ||= addBinding(makeRunMain, node.name.text);
				return;
			}
			if (ts.isObjectBindingPattern(node.name) && isRuntimeAlias(node.initializer, runtime)) {
				for (const element of node.name.elements) {
					if (!isMakeRunMainBinding(element) || !ts.isIdentifier(element.name)) continue;
					changed ||= addBinding(makeRunMain, element.name.text);
				}
			}
		});
	}

	return { runtime, makeRunMain };
}

function isEffectImport(node: ts.ImportDeclaration): boolean {
	return ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === 'effect';
}

function addBinding(bindings: Set<string>, name: string): boolean {
	if (bindings.has(name)) return false;
	bindings.add(name);
	return true;
}

function isRuntimeAlias(expression: ts.Expression, runtime: ReadonlySet<string>): boolean {
	return ts.isIdentifier(expression) && runtime.has(expression.text);
}

function isMakeRunMainAlias(
	expression: ts.Expression,
	runtime: ReadonlySet<string>,
	makeRunMain: ReadonlySet<string>
): boolean {
	return (
		(ts.isIdentifier(expression) && makeRunMain.has(expression.text)) ||
		(ts.isPropertyAccessExpression(expression) &&
			expression.name.text === 'makeRunMain' &&
			isRuntimeAlias(expression.expression, runtime))
	);
}

function isRuntimeMakeRunMain(node: ts.Node, bindings: RuntimeBindings): boolean {
	if (!ts.isCallExpression(node)) return false;
	if (ts.isPropertyAccessExpression(node.expression)) {
		return (
			node.expression.name.text === 'makeRunMain' &&
			isRuntimeAlias(node.expression.expression, bindings.runtime)
		);
	}
	return ts.isIdentifier(node.expression) && bindings.makeRunMain.has(node.expression.text);
}

function isMakeRunMainBinding(element: ts.BindingElement): boolean {
	const propertyName = element.propertyName;
	return propertyName === undefined
		? ts.isIdentifier(element.name) && element.name.text === 'makeRunMain'
		: ts.isIdentifier(propertyName) && propertyName.text === 'makeRunMain';
}

function isRuntimeTerminalBody(file: string, node: ts.Node): boolean {
	if (file !== 'src/bin/akua.ts' && !/^scripts\/(?:generate-contract|release)\.ts$/.test(file))
		return false;
	let current: ts.Node | undefined = node;
	while (current !== undefined && !ts.isStatement(current)) current = current.parent;
	if (current === undefined) return false;
	const parent = current.parent;
	return (
		ts.isBlock(parent) &&
		ts.isIfStatement(parent.parent) &&
		isImportMetaMainGuard(parent.parent.expression) &&
		parent.parent.thenStatement === parent &&
		current.parent === parent
	);
}

function lexicalViolations(file: string, source: string): Violation[] {
	return forbiddenPatterns.flatMap(({ rule, pattern }) =>
		pattern.test(source) ? [{ file, rule }] : []
	);
}

function visit(node: ts.Node, inspect: (current: ts.Node) => void): void {
	inspect(node);
	ts.forEachChild(node, (child) => visit(child, inspect));
}
