import { Record, Schema } from 'effect';
import { stringify } from 'yaml';
import { CredentialProviderConfig } from './generated/kubelet/1.35.8/CredentialProviderConfig';
import { KubeletConfiguration } from './generated/kubelet/1.35.8/KubeletConfiguration';
import { KubeletFlags } from './generated/kubelet/1.35.8/KubeletFlags';

/** The OCI Basic username the registry recognizes as a workload token. */
export const imageCredentialUsername = 'akua-workload';
/** The executable name the kubelet runs from its bin directory. */
export const imageCredentialProviderName = 'akua-image-credential-provider';
/** The environment variable naming the registry host the provider answers for. */
export const imageCredentialRegistryVariable = 'AKUA_IMAGE_REGISTRY';

/** A registry host as an image reference names it: lowercase DNS name, optional port. */
export const RegistryHost = Schema.String.check(
	Schema.isMaxLength(253),
	Schema.isPattern(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$/)
);

const binDirectory = '/var/lib/akua/credential-provider/bin';
const configFile = '/etc/akua/credential-provider.yaml';
/** Where the provider sits inside its layer of the agent image. */
const layerPath = `usr/local/bin/${imageCredentialProviderName}`;

const Digest = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/));

/**
 * The provider of one agent release: the agent image repository on the
 * stage registry (`<registry host>/<path>`) and the digest of the
 * provider's layer per architecture. A node fetches that layer as a blob
 * and checks it before unpacking it.
 */
export const ImageCredentialProviderLayers = Schema.Struct({
	repository: Schema.String.check(
		Schema.isMaxLength(255),
		Schema.isPattern(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?\/[a-z0-9][a-z0-9._/-]*$/)
	),
	amd64: Digest,
	arm64: Digest
});
export type ImageCredentialProviderLayers = typeof ImageCredentialProviderLayers.Type;

/**
 * The kubelet flags. The kubelet reads them and the provider config only at
 * start, so both stay fixed; the binary is executed per pull.
 */
export const kubeletImageCredentialProvider = {
	ImageCredentialProviderConfigPath: configFile,
	ImageCredentialProviderBinDir: binDirectory
} satisfies typeof KubeletFlags.Type;

/**
 * Only the flags Akua writes. Upstream splits these between KubeletFlags
 * and KubeletConfiguration; their values are encoded before shell rendering.
 */
export const KubeletArguments = Schema.Struct({
	...KubeletFlags.fields,
	...KubeletConfiguration.fields
});
export type KubeletArguments = typeof KubeletArguments.Type;

const flagNames = {
	HostnameOverride: 'hostname-override',
	ProviderID: 'provider-id',
	ImageCredentialProviderConfigPath: 'image-credential-provider-config',
	ImageCredentialProviderBinDir: 'image-credential-provider-bin-dir'
} satisfies Record<keyof KubeletArguments, string>;

/** Values are single k0s/systemd arguments, never arbitrary shell fragments. */
const FlagValue = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9._:/{}$-]+$/));
export const renderKubeletArguments = (input: KubeletArguments) => {
	const encoded = Schema.encodeSync(KubeletArguments)(input, { onExcessProperty: 'error' });
	return Record.keys(flagNames)
		.flatMap((key) => {
			const value = encoded[key];
			return value === undefined
				? []
				: [`--${flagNames[key]}=${Schema.decodeSync(FlagValue)(value)}`];
		})
		.join(' ');
};

export const kubeletImageCredentialProviderArgs = renderKubeletArguments(
	kubeletImageCredentialProvider
);

/** The registry is fixed before the script reaches the node. */
export const credentialProviderConfig = (
	registry: string
): typeof CredentialProviderConfig.Type => {
	const host = Schema.decodeSync(RegistryHost)(registry);
	return {
		apiVersion: 'kubelet.config.k8s.io/v1',
		kind: 'CredentialProviderConfig',
		providers: [
			{
				name: imageCredentialProviderName,
				apiVersion: 'credentialprovider.kubelet.k8s.io/v1',
				matchImages: [host],
				defaultCacheDuration: '0s',
				env: [{ name: imageCredentialRegistryVariable, value: host }],
				tokenAttributes: {
					serviceAccountTokenAudience: host,
					cacheType: 'Token',
					requireServiceAccount: true
				}
			}
		]
	};
};

export const renderCredentialProviderConfig = (registry: string) =>
	stringify(
		Schema.encodeSync(CredentialProviderConfig)(credentialProviderConfig(registry), {
			onExcessProperty: 'error'
		}),
		{
			aliasDuplicateObjects: false,
			compat: 'yaml-1.1'
		}
	);

/**
 * POSIX sh, shared by every Akua node bootstrap (a pool Machine's user-data
 * and the BYO join.sh), so both install the provider the same way. It
 * defines `akua_install_image_credential_provider <repository> <amd64
 * digest> <arm64 digest>`: download the node architecture's layer by digest
 * over HTTPS, verify it with `sha256sum -c`, unpack the binary and write the
 * kubelet's CredentialProviderConfig, each by an atomic rename.
 *
 * The agent image lives on the stage registry, so the repository's host is
 * the registry whose pulls carry the Pod's own ServiceAccount token: the
 * config's only match and the token's audience. The kubelet requests a
 * Pod-bound token and caches the answer per token, as the kubelet API
 * requires (`cacheType: Token`) when the provider returns that token itself
 * as the credential. A Pod without a ServiceAccount never reaches it.
 *
 * The caller defines `akua_image_credential_provider_failed <step>
 * <message>`; the installer calls it on any failure and exits if it
 * returns. `<step>` is `download-image-credential-provider` or
 * `verify-image-credential-provider`; neither argument carries input.
 */
export const imageCredentialProviderInstaller = (registry: string) => `akua_icp_fail() {
  rm -rf "\${akua_icp_work:-}"
  akua_image_credential_provider_failed "$1" "$2"
  exit 1
}
akua_install_image_credential_provider() {
  akua_icp_repository=$1
  case "$(uname -m)" in
    x86_64|amd64) akua_icp_digest=$2 ;;
    aarch64|arm64) akua_icp_digest=$3 ;;
    *) akua_icp_fail download-image-credential-provider "Unsupported architecture for the image credential provider" ;;
  esac
  akua_icp_registry=\${akua_icp_repository%%/*}
  case "$akua_icp_repository" in
    ''|*[!a-z0-9.:/_-]*|/*|*/|*//*) akua_icp_fail download-image-credential-provider "Invalid image credential provider repository" ;;
  esac
  case "$akua_icp_registry" in
    ''|"$akua_icp_repository"|[!a-z0-9]*) akua_icp_fail download-image-credential-provider "Invalid image credential provider repository" ;;
  esac
  [ "$akua_icp_registry" = '${Schema.decodeSync(RegistryHost)(registry)}' ] \\
    || akua_icp_fail download-image-credential-provider "Image credential provider repository belongs to another registry"
  akua_icp_hex=\${akua_icp_digest#sha256:}
  case "$akua_icp_digest" in sha256:*) ;; *) akua_icp_hex= ;; esac
  case "$akua_icp_hex" in
    ''|*[!a-f0-9]*) akua_icp_fail verify-image-credential-provider "Invalid image credential provider digest" ;;
  esac
  [ "\${#akua_icp_hex}" -eq 64 ] || akua_icp_fail verify-image-credential-provider "Invalid image credential provider digest"
  akua_icp_work=$(mktemp -d) || akua_icp_fail download-image-credential-provider "Could not create a temporary directory"
  curl -sSfL --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 300 --retry 3 \\
    "https://$akua_icp_registry/v2/\${akua_icp_repository#*/}/blobs/$akua_icp_digest" \\
    -o "$akua_icp_work/layer.tar.gz" >/dev/null 2>&1 \\
    || akua_icp_fail download-image-credential-provider "Could not download the image credential provider; check connectivity and retry"
  printf '%s  %s\\n' "$akua_icp_hex" "$akua_icp_work/layer.tar.gz" | sha256sum -c - >/dev/null 2>&1 \\
    || akua_icp_fail verify-image-credential-provider "The downloaded image credential provider does not match its pinned digest"
  tar -xzf "$akua_icp_work/layer.tar.gz" -C "$akua_icp_work" >/dev/null 2>&1 \\
    && [ -f "$akua_icp_work/${layerPath}" ] \\
    || akua_icp_fail download-image-credential-provider "Could not unpack the image credential provider"
  install -d -m 0755 ${binDirectory} ${configFile.slice(0, configFile.lastIndexOf('/'))} \\
    && install -m 0755 "$akua_icp_work/${layerPath}" ${binDirectory}/.${imageCredentialProviderName}.new \\
    && mv -f ${binDirectory}/.${imageCredentialProviderName}.new ${binDirectory}/${imageCredentialProviderName} \\
    || akua_icp_fail download-image-credential-provider "Could not install the image credential provider"
  cat > "$akua_icp_work/credential-provider.yaml" <<'AKUA_CREDENTIAL_PROVIDER_CONFIG'
${renderCredentialProviderConfig(registry).trimEnd()}
AKUA_CREDENTIAL_PROVIDER_CONFIG
  install -m 0644 "$akua_icp_work/credential-provider.yaml" ${configFile}.new \\
    && mv -f ${configFile}.new ${configFile} \\
    || akua_icp_fail download-image-credential-provider "Could not write the image credential provider configuration"
  rm -rf "$akua_icp_work"
}`;
