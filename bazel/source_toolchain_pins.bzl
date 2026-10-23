"""Pinned upstream Go 1.27.3 archives (Linux ZIP verified via Go's checksum database)."""

SOURCE_TOOLCHAIN_PINS = {
    "go": {
        "aarch64-apple-darwin": {
            "sha256": "dd3908cf20959d798c1e06ebe5b72213f0505ce01373b40ce3110975a6cd99c2",
            "url": "https://go.dev/dl/go1.27.3.darwin-arm64.tar.gz",
        },
        "x86_64-apple-darwin": {
            "sha256": "b6f8e931e4ab497fcde6da8ae4499a58f9d258e55c8a80824a516eae5950a750",
            "url": "https://go.dev/dl/go1.27.3.darwin-amd64.tar.gz",
        },
        "x86_64-unknown-linux-gnu": {
            "sha256": "af4c06478303fdd1bfb335fab86c7ccb9b12e529044a946a16a1c4bcc779f8d7",
            "strip_prefix": "golang.org/toolchain@v0.0.1-go1.27.3.linux-amd64",
            "url": "https://proxy.golang.org/golang.org/toolchain/@v/v0.0.1-go1.27.3.linux-amd64.zip",
        },
    },
}
