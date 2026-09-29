#!/usr/bin/env bash
# Patterns passed to the assertion helpers intentionally remain literal.
# shellcheck disable=SC1003,SC2016
set -euo pipefail

line_in_job() {
	local file="$1"
	local job="$2"
	local pattern="$3"

	awk -v job="$job" -v pattern="$pattern" '
		$0 ~ "^  " job ":$" { in_job = 1; next }
		in_job && $0 ~ /^  [A-Za-z0-9_-]+:$/ { exit }
		in_job && index($0, pattern) { print NR; exit }
	' "$file"
}

command_line_in_job() {
	local file="$1"
	local job="$2"
	local pattern="$3"

	awk -v job="$job" -v pattern="$pattern" '
		$0 ~ "^  " job ":$" { in_job = 1; next }
		in_job && $0 ~ /^  [A-Za-z0-9_-]+:$/ { exit }
		in_job {
			command = $0
			sub(/^[[:space:]]+/, "", command)
			if (command !~ /^#/ && index(command, pattern)) { print NR; exit }
		}
	' "$file"
}

assert_before() {
	local file="$1"
	local job="$2"
	local first="$3"
	local second="$4"
	local first_line second_line

	first_line="$(line_in_job "$file" "$job" "$first")"
	second_line="$(line_in_job "$file" "$job" "$second")"

	if [[ -z "$first_line" ]]; then
		echo "ERROR: $file job '$job' is missing step '$first'" >&2
		exit 1
	fi
	if [[ -z "$second_line" ]]; then
		echo "ERROR: $file job '$job' is missing step '$second'" >&2
		exit 1
	fi
	if (( first_line >= second_line )); then
		echo "ERROR: $file job '$job' must run '$first' before '$second'" >&2
		echo "       '$first' line $first_line, '$second' line $second_line" >&2
		exit 1
	fi
}

assert_job_contains() {
	local file="$1"
	local job="$2"
	local pattern="$3"
	local line

	line="$(command_line_in_job "$file" "$job" "$pattern")"
	if [[ -z "$line" ]]; then
		echo "ERROR: $file job '$job' is missing '$pattern'" >&2
		exit 1
	fi
}

assert_job_excludes() {
	local file="$1"
	local job="$2"
	local pattern="$3"
	local line

	line="$(command_line_in_job "$file" "$job" "$pattern")"
	if [[ -n "$line" ]]; then
		echo "ERROR: $file job '$job' still contains forbidden text '$pattern'" >&2
		exit 1
	fi
}

assert_job_runs_on() {
	local file="$1"
	local job="$2"
	local expected="$3"

	ruby -ryaml -e '
		file, job, expected = ARGV
		workflow = YAML.safe_load(File.read(file), aliases: true)
		actual = workflow.fetch("jobs").fetch(job).fetch("runs-on")
		exit if actual == expected

		warn "ERROR: #{file} job #{job.inspect} runs on #{actual.inspect}, expected #{expected.inspect}"
		exit 1
	' "$file" "$job" "$expected"
}

assert_workflow_excludes_runner() {
	local file="$1"
	local forbidden="$2"

	ruby -ryaml -e '
		file, forbidden = ARGV
		workflow = YAML.safe_load(File.read(file), aliases: true)
		contains = lambda do |value|
			case value
			when Hash then value.any? { |key, child| contains.call(key) || contains.call(child) }
			when Array then value.any? { |child| contains.call(child) }
			else value == forbidden
			end
		end
		exit unless contains.call(workflow.fetch("jobs"))

		warn "ERROR: #{file} still routes release work to retired runner #{forbidden.inspect}"
		exit 1
	' "$file" "$forbidden"
}

assert_file_contains() {
	local file="$1"
	local pattern="$2"

	if ! grep -Fq -- "$pattern" "$file"; then
		echo "ERROR: $file is missing '$pattern'" >&2
		exit 1
	fi
}

assert_file_excludes() {
	local file="$1"
	local pattern="$2"

	if grep -Fq -- "$pattern" "$file"; then
		echo "ERROR: $file still contains forbidden text '$pattern'" >&2
		exit 1
	fi
}

assert_file_excludes_pattern() {
	local file="$1"
	local pattern="$2"

	if grep -Eiq -- "$pattern" "$file"; then
		echo "ERROR: $file matches forbidden pattern '$pattern'" >&2
		exit 1
	fi
}

assert_dispatch_input_required() {
	local file="$1"
	local input="$2"

	if ! awk -v input="$input" '
		$0 == "      " input ":" { in_input = 1; next }
		in_input && $0 ~ /^      [^ ]/ { exit }
		in_input && $0 == "        required: true" { found = 1 }
		END { exit !found }
	' "$file"; then
		echo "ERROR: $file workflow_dispatch input '$input' must be required" >&2
		exit 1
	fi
}

# PR CI must stay runnable without the retired AgentOS ARC pool. Parse the
# workflow instead of matching YAML text so formatting cannot weaken this
# routing contract.
assert_job_runs_on ".github/workflows/ci.yml" "rust" "ubuntu-latest"
assert_job_runs_on ".github/workflows/ci.yml" "sdk" "ubuntu-latest"

# A release tag must never queue on the retired AgentOS ARC pool. Every Linux
# release job uses GitHub-hosted runners; macOS and Windows matrix entries keep
# their platform-specific hosted runners.
for retired_runner in akua-x64-ci-v2 akua-heavy-ci-v2 akua-docker-ci-v2; do
	assert_workflow_excludes_runner ".github/workflows/release.yml" "$retired_runner"
done
for job in detect-version wasm-bundle github-release docker; do
	assert_job_runs_on ".github/workflows/release.yml" "$job" "ubuntu-latest"
done

# Hosted Linux runners do not preinstall the GNU arm64 cross linker used by
# the CLI matrix. Validate the parsed step ordering and target guard so the
# immutable tag is not stranded after the release starts.
ruby -ryaml -e '
	workflow = YAML.safe_load(File.read(".github/workflows/release.yml"), aliases: true)
	steps = workflow.fetch("jobs").fetch("cli-build").fetch("steps")
	install_index = steps.index { |step| step["name"] == "Install Linux arm64 cross compiler" }
	cross_index = steps.index { |step| step["name"] == "Cross-compile for linux/arm64" }
	abort "ERROR: cli-build must install the Linux arm64 cross compiler" unless install_index
	abort "ERROR: cli-build is missing the Linux arm64 cross-compile check" unless cross_index
	abort "ERROR: cross compiler must be installed before it is used" unless install_index < cross_index
	install = steps.fetch(install_index)
	abort "ERROR: cross compiler install must be scoped to the arm64 GNU target" unless install["if"] == "matrix.target == '\''aarch64-unknown-linux-gnu'\''"
	abort "ERROR: cross compiler install must provide gcc-aarch64-linux-gnu" unless install.fetch("run").include?("gcc-aarch64-linux-gnu")
'

# A tag can fail before its immutable GitHub Release exists. The reviewed-main
# recovery lane must require an explicit opt-in before it is allowed to create
# that missing release from a freshly rebuilt, SHA-verified tag.
assert_dispatch_input_required ".github/workflows/release.yml" "create-missing-release"
assert_job_contains ".github/workflows/release.yml" \
	"github-release" \
	'CREATE_MISSING_RELEASE: ${{ inputs['\''create-missing-release'\''] }}'
assert_job_contains ".github/workflows/release.yml" \
	"github-release" \
	'if [[ "$CREATE_MISSING_RELEASE" != "true" ]]'

# Release-owned coordinates moved with the repository. Keep the image and
# release identities on the current GitHub organization.
for workflow in .github/workflows/*.yml; do
	assert_file_excludes "$workflow" "cnap-tech"
done
assert_file_contains ".github/workflows/release.yml" "ghcr.io/akua-dev/akuapkg:\${tag}"
assert_file_excludes_pattern ".github/workflows/release.yml" 'gh[[:space:]]+release[[:space:]]+upload'
assert_file_excludes ".github/workflows/release.yml" "--clobber"
assert_job_contains ".github/workflows/release.yml" \
	"github-release" \
	'if [[ "$GITHUB_EVENT_NAME" == "workflow_dispatch" ]]'

# Homebrew belongs to akua-dev/cli and its dedicated tap lane. Akua core must
# never configure tap credentials, generate a formula, or dispatch a tap writer.
if grep -Eiq 'homebrew|TAP_BUMP|github\.com-tap|Formula/akua\.rb' .github/workflows/release.yml; then
	echo "ERROR: release.yml contains an Akua-core Homebrew/tap side effect or ownership claim" >&2
	exit 1
fi
for file in README.md packages/sdk/README.md docs/sdk-runtime-compat.md; do
	assert_file_excludes_pattern "$file" 'brew[[:space:]]+install[^[:cntrl:]]*akua|homebrew[^[:cntrl:]]*(formula|tap|install|update|publish|release)|(^|[^[:alnum:]_])(formula|tap)([^[:alnum:]_]|$)[^[:cntrl:]]*akua'
done

# Public package-tool docs must follow the executable command surface. Keep
# platform-only and planned verbs out of the standalone Akuapkg reference, and
# keep engine documentation on the package-tool binary name.
docs_contract_failed=0
for verb in attest deploy rollout secret policy audit query infra login logout bench trace cov eval telemetry lint-cli; do
	if grep -Fq -- "akuapkg $verb" docs/cli.md; then
		echo "ERROR: docs/cli.md documents nonexistent standalone verb 'akuapkg $verb'" >&2
		docs_contract_failed=1
	fi
	if [[ -e "site/cli/$verb.html" ]]; then
		echo "ERROR: site/cli/$verb.html publishes nonexistent standalone verb 'akuapkg $verb'" >&2
		docs_contract_failed=1
	fi
done
if ! grep -Fq -- "Akuapkg embeds" docs/embedded-engines.md || \
	grep -Fq -- 'the `akua` binary' docs/embedded-engines.md; then
	echo "ERROR: docs/embedded-engines.md conflates Akuapkg with the platform akua binary" >&2
	docs_contract_failed=1
fi
if grep -Fq -- "## Performance notes" docs/embedded-engines.md || \
	grep -Fq -- "[docs/bench/](bench/)" docs/embedded-engines.md; then
	echo "ERROR: docs/embedded-engines.md contains unsupported or unlinked benchmark claims" >&2
	docs_contract_failed=1
fi
if grep -Fq -- 'akuapkg bench' docs/embedded-engines.md; then
	echo "ERROR: docs/embedded-engines.md recommends nonexistent 'akuapkg bench'" >&2
	docs_contract_failed=1
fi
if (( docs_contract_failed != 0 )); then
	exit 1
fi

# A manual recovery runs workflow code from a green branch, but every source
# checkout must resolve to the requested immutable tag. The workflow verifies
# and propagates that commit; it must never create or move a tag.
for input in expected-source-commit expected-workflow-commit; do
	assert_dispatch_input_required ".github/workflows/release.yml" "$input"
done
assert_job_contains ".github/workflows/release.yml" \
	"detect-version" \
	'EXPECTED_SOURCE_COMMIT: ${{ inputs.expected-source-commit }}'
assert_job_contains ".github/workflows/release.yml" \
	"detect-version" \
	'EXPECTED_WORKFLOW_COMMIT: ${{ inputs.expected-workflow-commit }}'
assert_job_contains ".github/workflows/release.yml" \
	"detect-version" \
	'ACTUAL_WORKFLOW_COMMIT: ${{ github.workflow_sha }}'
assert_job_contains ".github/workflows/release.yml" \
	"detect-version" \
	'if [[ "$source_commit" != "$EXPECTED_SOURCE_COMMIT" ]]'
assert_job_contains ".github/workflows/release.yml" \
	"detect-version" \
	'if [[ "$ACTUAL_WORKFLOW_COMMIT" != "$EXPECTED_WORKFLOW_COMMIT" ]]'
assert_job_contains ".github/workflows/release.yml" \
	"detect-version" \
	'git rev-parse "refs/tags/${tag}^{commit}"'
assert_file_contains ".github/workflows/release.yml" "source_commit: \${{ steps.parse.outputs.source_commit }}"
for job in wasm-bundle cli-build github-release docker; do
	assert_job_contains ".github/workflows/release.yml" \
		"$job" \
		'ref: ${{ needs.detect-version.outputs.source_commit }}'
done
if grep -Eq '^[[:space:]]*(git tag|git push .*refs/tags/|gh release delete)' ".github/workflows/release.yml"; then
	echo "ERROR: .github/workflows/release.yml contains a tag/Release replacement command" >&2
	exit 1
fi

assert_file_excludes ".github/workflows/release.yml" "github.com/akua-dev/akua.git"
assert_file_excludes ".github/workflows/release.yml" "github.com/akua-dev/akua/blob"

# npm packages are no longer published from this pipeline (akua-dev/cnap#2348).
# Guard against the publish plumbing creeping back in.
assert_file_excludes ".github/workflows/release.yml" "npm publish"
assert_file_excludes ".github/workflows/release.yml" "id-token: write"
if [[ -e ".github/workflows/release-publish.yml" ]]; then
	echo "ERROR: .github/workflows/release-publish.yml must not exist; npm publishing is discontinued (akua-dev/cnap#2348)" >&2
	exit 1
fi
if [[ -n "$(jq -r '.scripts.prepublishOnly // empty' crates/akua-napi/package.json)" ]]; then
	echo "ERROR: crates/akua-napi/package.json must not carry an npm prepublishOnly script" >&2
	exit 1
fi

# The deliberately gated recovery command is authoritative release contract,
# not tribal knowledge. npm publishing is discontinued (akua-dev/cnap#2348);
# guard against the trusted-publisher/recovery narrative it required creeping
# back into the docs.
assert_file_contains "docs/releasing.md" "akua-dev/akuapkg"
assert_file_contains "docs/releasing.md" "akua-dev/cnap#2348"
assert_file_contains "docs/releasing.md" "--ref main"
assert_file_contains "docs/releasing.md" "-f expected-source-commit=be62c125e9816aa1a440de9afecb4b6fc9a8d487"
assert_file_contains "docs/releasing.md" '-f expected-workflow-commit="$reviewed_workflow_commit"'
assert_file_contains "docs/releasing.md" "Homebrew is explicitly outside the release workflow"
assert_file_contains "docs/releasing.md" "akua-dev/cli"
assert_file_contains "docs/releasing.md" 'dedicated `akua-dev/homebrew-tap` lane'
assert_file_excludes "docs/releasing.md" "updates Homebrew"
assert_file_excludes "docs/releasing.md" "updates the generated Homebrew"
assert_file_excludes "docs/releasing.md" "release-publish.yml"
assert_file_excludes "docs/releasing.md" "trusted publisher"
assert_file_excludes "packages/sdk/README.md" "github.com/cnap-tech/akua"
assert_file_contains "packages/sdk/README.md" "docs/releasing.md"

echo "Release workflow ordering checks passed."
