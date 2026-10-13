---
name: publish-signed
description: Publish an akuapkg Package to an OCI registry with a cosign signature and a SLSA v1 provenance attestation, and configure consumers to verify it. Use when releasing a Package version, setting up signed publishing in CI, signing for an air-gapped transfer, or requiring signatures on dependencies.
license: Apache-2.0
compatibility: Requires an ECDSA P-256 private key in PKCS#8 PEM (for example from `cosign generate-key-pair`). Keyless (Sigstore OIDC) signing is not supported.
---

# Publish a signed Package

## Steps

1. Configure the keys in `akua.toml` (paths relative to the workspace):

   ```toml
   [signing]
   cosign_private_key = "./cosign.key"
   cosign_public_key = "./cosign.pub"
   ```

   Never commit the private key: in CI, write it from a secret before
   publishing. For an encrypted key, set `AKUA_COSIGN_PASSPHRASE`.

2. Check before publishing:

   ```sh
   akuapkg lock --check
   akuapkg verify
   akuapkg test --golden
   ```

3. Publish. The tag defaults to `[package].version`:

   ```sh
   akuapkg publish --ref oci://REGISTRY/REPO
   ```

   `publish` packs the workspace (without `replace` overrides), pushes it,
   signs the manifest digest with cosign and pushes a SLSA v1 attestation.
   Without `cosign_private_key` it publishes unsigned; `--no-sign` and
   `--no-attest` turn signing and attestation off explicitly.

4. Consumers verify by putting your public key in their own `akua.toml`
   `[signing].cosign_public_key`: `add`, `lock` and `update` then refuse the
   Package without a valid signature, and `verify` requires it.

## Air-gapped flow

```sh
akuapkg pack --out pkg.tar.gz
akuapkg sign --tarball pkg.tar.gz --ref oci://REGISTRY/REPO --tag 1.0.0
# transfer pkg.tar.gz and pkg.tar.gz.akuasig, then on the other side:
akuapkg verify --tarball pkg.tar.gz --sig pkg.tar.gz.akuasig --public-key cosign.pub
akuapkg push --tarball pkg.tar.gz --ref oci://REGISTRY/REPO --tag 1.0.0 --sig pkg.tar.gz.akuasig
```

`sign` reads the key from `[signing].cosign_private_key` (or `--key`) and
writes the signature next to the tarball as `<tarball>.akuasig`.

## References

- [docs/lockfile-format.md](../../docs/lockfile-format.md#signing)
- [docs/security-model.md](../../docs/security-model.md#supply-chain)
