import { Option, Redacted } from 'effect';
import { AgentImage, EnrollmentCode } from '@platform/api-contract/services/cluster-agent';
import type { AgentSettings } from '../config';

export const testEnrollmentCode = `akua_enr_${'a'.repeat(43)}`;

export const testImage = (digit: string) =>
	AgentImage.make(`pkg.akua.dev/akua/cluster-agent@sha256:${digit.repeat(64)}`);

export const testSettings = (overrides: Partial<AgentSettings> = {}): AgentSettings => ({
	platformOrigin: new URL('https://api.akua.test'),
	release: { version: '1.0.0', image: testImage('1'), protocol: 1 },
	enrollment: { _tag: 'code', code: EnrollmentCode.make(Redacted.make(testEnrollmentCode)) },
	distribution: Option.none(),
	accessNamespaces: [],
	healthPort: 8080,
	enginePath: '/usr/local/bin/akua-apply',
	namespace: 'akua-system',
	...overrides
});
