import { expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { Yaml } from 'effect/encoding';
import { CredentialProviderConfig } from './generated/kubelet/1.35.8/CredentialProviderConfig';
import {
	credentialProviderConfig,
	KubeletArguments,
	kubeletImageCredentialProvider,
	renderCredentialProviderConfig,
	renderKubeletArguments
} from './KubeletInstall';

it.effect('rejects misspelled config fields, including inside tokenAttributes', () =>
	Effect.gen(function* () {
		const invalidConfigs: ReadonlyArray<unknown> = [
			{ ...credentialProviderConfig('registry.example.test'), providerz: [] },
			{
				apiVersion: 'kubelet.config.k8s.io/v1',
				kind: 'CredentialProviderConfig',
				providers: [{ tokenAttributes: { serviceAccountTokenAudiance: 'registry.example.test' } }]
			},
			{ providers: [{ tokenAttributes: { requireServiceAccount: 'true' } }] }
		];
		for (const invalid of invalidConfigs) {
			expect(
				(yield* Schema.decodeUnknownEffect(CredentialProviderConfig)(invalid, {
					onExcessProperty: 'error'
				}).pipe(Effect.result))._tag
			).toBe('Failure');
			expect(
				(yield* Schema.encodeUnknownEffect(CredentialProviderConfig)(invalid, {
					onExcessProperty: 'error'
				}).pipe(Effect.result))._tag
			).toBe('Failure');
		}
	})
);

it.effect('encodes a stage-specific config that the pinned kubelet schema decodes unchanged', () =>
	Effect.gen(function* () {
		const registry = 'registry-preview.example.test:5443';
		const yaml = renderCredentialProviderConfig(registry);
		const actual = yield* Schema.decodeUnknownEffect(CredentialProviderConfig)(Yaml.parse(yaml), {
			onExcessProperty: 'error'
		});
		expect(actual).toEqual(credentialProviderConfig(registry));
		expect(actual.providers?.[0]?.tokenAttributes).toEqual({
			serviceAccountTokenAudience: registry,
			cacheType: 'Token',
			requireServiceAccount: true
		});
	})
);

it.effect('rejects misspelled flags and renders the typed kubelet arguments', () =>
	Effect.gen(function* () {
		const misspelled: unknown = { HostnameOveride: 'worker' };
		expect(
			(yield* Schema.decodeUnknownEffect(KubeletArguments)(misspelled, {
				onExcessProperty: 'error'
			}).pipe(Effect.result))._tag
		).toBe('Failure');
		expect(
			renderKubeletArguments({
				HostnameOverride: 'worker-1',
				ProviderID: '${AKUA_PROVIDER_ID}',
				...kubeletImageCredentialProvider
			})
		).toBe(
			'--hostname-override=worker-1 --provider-id=${AKUA_PROVIDER_ID} --image-credential-provider-config=/etc/akua/credential-provider.yaml --image-credential-provider-bin-dir=/var/lib/akua/credential-provider/bin'
		);
	})
);
