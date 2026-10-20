# Changelog

## [0.11.4](https://github.com/akua-dev/cli/compare/v0.11.3...v0.11.4)

### Features

- Canonical Bazel release archives bundle the source-built Package SDK, native bindings, and render engines at version 0.9.6.

## [0.11.3](https://github.com/akua-dev/cli/compare/v0.11.2...v0.11.3)

### Fixes

- Initialize bundled native engines before offline Package renders.

## [0.11.2](https://github.com/akua-dev/cli/compare/v0.11.1...v0.11.2)

### Fixes

- Resume release drafts safely and verify all immutable archives before publication.

## [0.11.1](https://github.com/akua-dev/cli/compare/v0.11.0...v0.11.1)

- Publish the Bazel-built CLI and bundled SDK 0.9.4 through the scoped Main release pipeline.
- Resolve generated API path placeholders with the current Effect client.

## [0.11.0](https://github.com/akua-dev/cli/compare/v0.10.1...v0.11.0) (2026-09-14)

### Features

- **cli:** expose generated input discovery ([8ab9a5c](https://github.com/akua-dev/cli/commit/8ab9a5cb63c5dfded1ab5490998fcc5935f5c221))
- **cli:** expose generated input discovery ([cf46b16](https://github.com/akua-dev/cli/commit/cf46b1602460da246ecc5ad822edae496a987c50)), closes [#53](https://github.com/akua-dev/cli/issues/53)

### Bug Fixes

- **ci:** restore runnable CLI pull request checks ([#56](https://github.com/akua-dev/cli/issues/56)) ([05c5261](https://github.com/akua-dev/cli/commit/05c52616023fa3d19e091f93f3c813218d999756))
- **ci:** restore runnable CLI release automation ([9fb8943](https://github.com/akua-dev/cli/commit/9fb89438535511b090fb965bc26d5041dcc57ee2))
- **ci:** restore runnable CLI release automation ([28ba9e1](https://github.com/akua-dev/cli/commit/28ba9e18490a6ef88a7230197de91128ee662cea))
- **cli:** adopt required product-quality API contract ([2ff18e8](https://github.com/akua-dev/cli/commit/2ff18e80d9f05e3c97503ccdca0b811bed1c27cf))
- **cli:** adopt required product-quality API contract ([073fc10](https://github.com/akua-dev/cli/commit/073fc109b99b8914a1bca69944862cfda00322da))
- **cli:** compile OpenAPI path templates correctly ([67777d7](https://github.com/akua-dev/cli/commit/67777d7908896ab5769b789feaaaceb12a17fc61))
- **cli:** compile OpenAPI path templates correctly ([2313eb9](https://github.com/akua-dev/cli/commit/2313eb906c7a3f1704a577d65582695d103e8919))
- **cli:** omit absent optional request bodies ([1614694](https://github.com/akua-dev/cli/commit/161469464c66f9a8ecbfe84ba4f4b9856dd36066))
- **cli:** omit absent optional request bodies ([0e3ab08](https://github.com/akua-dev/cli/commit/0e3ab086caa5283ad316a79d4e568ff57113c415))
- **cli:** percent-encode literal colons in :action-suffixed paths ([#47](https://github.com/akua-dev/cli/issues/47)) ([599cbc4](https://github.com/akua-dev/cli/commit/599cbc462de311aafb48db20297a6b8db693e769))
- **cli:** preserve embedded legacy path parameters ([0e005f0](https://github.com/akua-dev/cli/commit/0e005f05395c5e44b08305db0b50ed4082d07bec))
- **contract:** accept system-managed machine responses ([#59](https://github.com/akua-dev/cli/issues/59)) ([0019e0c](https://github.com/akua-dev/cli/commit/0019e0c52134a838e1774ee053dd7d877f38f7d5))
- **contract:** sync quota lifetime response ([#61](https://github.com/akua-dev/cli/issues/61)) ([a6c4cf8](https://github.com/akua-dev/cli/commit/a6c4cf81795dd216fb0b1e92751c73ee4b0222e7))

## [0.10.1](https://github.com/akua-dev/cli/compare/v0.10.0...v0.10.1) (2026-08-17)

### Bug Fixes

- **release:** resolve the embedded package runtime from process.execPath ([#44](https://github.com/akua-dev/cli/issues/44)) ([c827efe](https://github.com/akua-dev/cli/commit/c827efec6680d81aa3acdf3318dc1b084752dd51))

## [0.10.0](https://github.com/akua-dev/cli/compare/v0.9.0...v0.10.0) (2026-08-17)

### Features

- **cli:** execute generated public API operations ([#40](https://github.com/akua-dev/cli/issues/40)) ([255d9d6](https://github.com/akua-dev/cli/commit/255d9d684e2cdb204168c938a6abee6404bf343e))
- **cli:** expose Effect command tree ([#41](https://github.com/akua-dev/cli/issues/41)) ([9459e02](https://github.com/akua-dev/cli/commit/9459e0237f5f9c39ec67288fa57db3a5add1a945))
- **hcloud:** add generic provider setup flow ([#26](https://github.com/akua-dev/cli/issues/26)) ([3d44871](https://github.com/akua-dev/cli/commit/3d448719949369d6d328c00e8fe8e19ade83ae3d))
- **release:** ship the embedded package runtime in every archive ([#42](https://github.com/akua-dev/cli/issues/42)) ([c873e0a](https://github.com/akua-dev/cli/commit/c873e0a063d9157de7c0ab9c25606e6b1de81888))

### Bug Fixes

- **auth:** send Better Auth device requests as JSON ([f619e81](https://github.com/akua-dev/cli/commit/f619e8170a40c5e496194bb154578bc88b92621c))
- **cli:** surface input schema issues and undeclared API response bodies ([#43](https://github.com/akua-dev/cli/issues/43)) ([9576a47](https://github.com/akua-dev/cli/commit/9576a47619b11b87d7d98e4f6e743331971d8c70))
- preserve release binary bytes in Kata ([2267e6d](https://github.com/akua-dev/cli/commit/2267e6d3587dc657abcf11adb05022a67745105b))

## [0.9.0](https://github.com/akua-dev/cli/compare/v0.8.0...v0.9.0) (2026-07-14)

### Features

- **loader:** add the compiled Agent OS HCloud provider-loader companion ([#23](https://github.com/akua-dev/cli/issues/23)) ([f235639](https://github.com/akua-dev/cli/commit/f23563969bbc533155cf545cbf7cdf2165613408))

## [0.8.0](https://github.com/akua-dev/cli/compare/v0.7.0...v0.8.0) (2026-07-14)

### Features

- **release:** publish installable multi-platform CLI artifacts ([#21](https://github.com/akua-dev/cli/issues/21)) ([8a7568f](https://github.com/akua-dev/cli/commit/8a7568f01fb7f99b0b5885de4c6e1c4d914e6531))
- **skills:** add canonical Akua agent skill ([#20](https://github.com/akua-dev/cli/issues/20)) ([3ec5ae4](https://github.com/akua-dev/cli/commit/3ec5ae4e0d67e7f2dbb1e43e57676a97ecd1f7f9))

## [0.7.0](https://github.com/akua-dev/cli/compare/v0.6.1...v0.7.0) (2026-07-11)

### Features

- **auth:** add local token config commands ([#17](https://github.com/akua-dev/cli/issues/17)) ([139a149](https://github.com/akua-dev/cli/commit/139a149a4c5339fcc7da0556fa1b642348394de8))
- **cli:** scaffold greenfield Akua CLI prototype ([#14](https://github.com/akua-dev/cli/issues/14)) ([aada3af](https://github.com/akua-dev/cli/commit/aada3af7d3ea4c3a6439b86a75494f2d8d893d09))
- **runtime:** detect universal agent environment mode ([#15](https://github.com/akua-dev/cli/issues/15)) ([42562cb](https://github.com/akua-dev/cli/commit/42562cbda419e04324732199e71307f23ff0b295))

### Bug Fixes

- **ci:** fall back to GitHub token for releases ([#19](https://github.com/akua-dev/cli/issues/19)) ([45a1fc1](https://github.com/akua-dev/cli/commit/45a1fc1f6e9d541b085417f8fff80f7a26341a8c))
