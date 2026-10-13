"""Pinned upstream Go 1.27.2 archives (Linux ZIP verified via Go's checksum database)."""

SOURCE_TOOLCHAIN_PINS = {
    "go": {
        "aarch64-apple-darwin": {
            "sha256": "76812b213b1b2302c978d28fa52fa92d541704b9e7d9d5db8002c50e4018c4c5",
            "url": "https://go.dev/dl/go1.27.2.darwin-arm64.tar.gz",
        },
        "x86_64-apple-darwin": {
            "sha256": "587b59182488b23aa6e5fc25110405a3e0e5b38ed2f5b2f46ed13c32aee356fe",
            "url": "https://go.dev/dl/go1.27.2.darwin-amd64.tar.gz",
        },
        "x86_64-unknown-linux-gnu": {
            "sha256": "3a467ed067f27cd55bf3a702f8e2bf12479f53c9d8ae0de548f48ebcb3c67796",
            "strip_prefix": "golang.org/toolchain@v0.0.1-go1.27.2.linux-amd64",
            "url": "https://proxy.golang.org/golang.org/toolchain/@v/v0.0.1-go1.27.2.linux-amd64.zip",
        },
    },
}
