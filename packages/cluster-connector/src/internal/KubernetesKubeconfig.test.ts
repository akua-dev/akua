import { assert, describe, it } from '@effect/vitest';
import { Effect, FileSystem, Layer, Option } from 'effect';
import { HttpClientRequest } from 'effect/http';
import { KubernetesConnection, KubernetesTls } from './Kubernetes';
import { kubeconfigLayer } from './KubernetesKubeconfig';

const b64 = (text: string) => btoa(text);
const kubeconfig = `
current-context: hosted
contexts:
  - name: hosted
    context: { cluster: hosted, user: connector }
clusters:
  - name: hosted
    cluster:
      server: https://kaas-k0s.cp-abc:443/
      certificate-authority-data: ${b64('CA PEM')}
users:
  - name: connector
    user:
      client-certificate-data: ${b64('CERT PEM')}
      client-key-data: ${b64('KEY PEM')}
`;

const fileSystem = FileSystem.layerNoop({ readFileString: () => Effect.succeed(kubeconfig) });

describe('kubeconfigLayer', () => {
	it.effect('uses the current context server and presents its client certificate alone', () =>
		Effect.gen(function* () {
			const connection = yield* KubernetesConnection;
			const tls = yield* KubernetesTls;
			assert.strictEqual(connection.baseUrl, 'https://kaas-k0s.cp-abc:443');
			assert.strictEqual(connection.impersonate._tag, 'none');
			assert.deepStrictEqual(Option.getOrNull(tls), {
				ca: 'CA PEM',
				cert: 'CERT PEM',
				key: 'KEY PEM'
			});
			const request = yield* connection.authenticate(HttpClientRequest.get('/version'));
			assert.isUndefined(request.headers.authorization);
		}).pipe(
			Effect.provide(
				kubeconfigLayer('/etc/akua/kubeconfig', { _tag: 'none' }).pipe(Layer.provide(fileSystem))
			)
		)
	);
});
