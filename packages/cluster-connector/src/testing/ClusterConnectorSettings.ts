import { Option, Redacted } from 'effect';
import {
	ClusterConnectorImage,
	EnrollmentCode
} from '@platform/api-contract/services/ClusterConnector';
import type { ClusterConnectorSettings } from '../internal/ClusterConnectorConfig';

export const testEnrollmentCode = `akua_enr_${'a'.repeat(43)}`;

export const testImage = (digit: string) =>
	ClusterConnectorImage.make(`pkg.akua.dev/akua/cluster-agent@sha256:${digit.repeat(64)}`);

export const testSettings = (
	overrides: Partial<ClusterConnectorSettings> = {}
): ClusterConnectorSettings => ({
	platformOrigin: new URL('https://api.akua.test'),
	release: { version: '1.0.0', image: testImage('1'), protocol: 1 },
	enrollment: { _tag: 'code', code: EnrollmentCode.make(Redacted.make(testEnrollmentCode)) },
	distribution: Option.none(),
	healthPort: 8080,
	enginePath: '/usr/local/bin/akua-apply',
	namespace: 'akua-system',
	...overrides
});
