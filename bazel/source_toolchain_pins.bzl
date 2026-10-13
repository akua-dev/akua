"""Pinned upstream Go 1.27.2 archives."""

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
            "sha256": "ecbadb99091a3f46e31f5f934b068b1864eafa7995211b39eaddf76996045fe5",
            "url": "https://go.dev/dl/go1.27.2.linux-amd64.tar.gz",
        },
    },
}
