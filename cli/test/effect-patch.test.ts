import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import ts from 'typescript';

// patches/effect@4.0.1.patch types an optional multipart payload as FormData or
// nothing; an unencoded object must not type-check.
it.effect(
	'Effect client accepts optional multipart as FormData or void, not an unencoded object',
	() =>
		Effect.sync(() => {
			const fileName = 'test/optional-multipart-contract.ts';
			const source = `
import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiSchema } from 'effect/http-api';
const multipart = Schema.Struct({ name: Schema.String }).pipe(HttpApiSchema.asMultipart());
type Request = HttpApiEndpoint.ClientRequest<never, never, typeof multipart | typeof Schema.Void, never, 'decoded-only'>;
declare const upload: (request: Request) => void;
upload({ payload: new FormData() });
upload({ payload: undefined });
// @ts-expect-error multipart input must be encoded as FormData
upload({ payload: { name: 'widget' } });
`;
			const options: ts.CompilerOptions = {
				strict: true,
				noEmit: true,
				skipLibCheck: true,
				types: [],
				module: ts.ModuleKind.NodeNext,
				moduleResolution: ts.ModuleResolutionKind.NodeNext,
				target: ts.ScriptTarget.ES2022
			};
			const host = ts.createCompilerHost(options);
			const getSourceFile = host.getSourceFile.bind(host);
			host.getSourceFile = (name, languageVersion) =>
				name === fileName
					? ts.createSourceFile(name, source, languageVersion, true)
					: getSourceFile(name, languageVersion);
			const program = ts.createProgram([fileName], options, host);

			expect(
				ts
					.getPreEmitDiagnostics(program)
					.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
			).toEqual([]);
		})
);
